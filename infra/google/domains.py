#!/usr/bin/env python3
"""Prepare production domain resources; never writes Cloudflare DNS or changes live app routing."""
import argparse,json,subprocess,urllib.request,urllib.error
from pathlib import Path

p=argparse.ArgumentParser();p.add_argument('--account',required=True);a=p.parse_args()
project='femlab-app';region='europe-west3';prefix='femlab-api'
def run(*args,optional=False):
 r=subprocess.run(['gcloud',*args,f'--project={project}',f'--account={a.account}','--quiet'],text=True,capture_output=True)
 if r.returncode and not optional:raise RuntimeError('gcloud failed: '+' '.join(args[:3])+': '+r.stderr[:1200])
 return r
def ensure(kind,name,scope,flags):
 old=run('compute',kind,'describe',name,*scope,'--format=json',optional=True)
 if old.returncode:
  run('compute',kind,'create',name,*scope,*flags)
  old=run('compute',kind,'describe',name,*scope,'--format=json')
 return json.loads(old.stdout)
address=ensure('addresses',prefix+'-address',['--global'],['--ip-version=IPV4','--network-tier=PREMIUM'])
neg=ensure('network-endpoint-groups',prefix+'-neg',[f'--region={region}'],['--network-endpoint-type=serverless','--cloud-run-service=femlab-api'])
if neg.get('cloudRun',{}).get('service')!='femlab-api':raise RuntimeError('Unexpected existing NEG target')
backend=ensure('backend-services',prefix+'-backend',['--global'],['--load-balancing-scheme=EXTERNAL_MANAGED'])
groups=[item['group'] for item in backend.get('backends',[])]
if any(group!=neg['selfLink'] for group in groups):raise RuntimeError('Unexpected existing backend')
if not groups:run('compute','backend-services','add-backend',prefix+'-backend','--global',f'--network-endpoint-group={prefix}-neg',f'--network-endpoint-group-region={region}')
urlmap=ensure('url-maps',prefix+'-map',['--global'],[f'--default-service={prefix}-backend'])
if urlmap.get('defaultService')!=backend['selfLink']:raise RuntimeError('Unexpected existing URL map')
certificate=ensure('ssl-certificates',prefix+'-certificate',['--global'],['--domains=api.femlab.app'])
if certificate.get('managed',{}).get('domains')!=['api.femlab.app']:raise RuntimeError('Unexpected certificate domains')
policy=ensure('ssl-policies',prefix+'-tls',['--global'],['--profile=MODERN','--min-tls-version=1.2'])
proxy=ensure('target-https-proxies',prefix+'-https-proxy',['--global'],[f'--url-map={prefix}-map',f'--ssl-certificates={prefix}-certificate',f'--ssl-policy={prefix}-tls','--http-keep-alive-timeout-sec=1200'])
if proxy.get('urlMap')!=urlmap['selfLink'] or proxy.get('sslCertificates')!=[certificate['selfLink']]:raise RuntimeError('Unexpected existing HTTPS proxy')
forward=ensure('forwarding-rules',prefix+'-https',['--global'],['--load-balancing-scheme=EXTERNAL_MANAGED','--network-tier=PREMIUM',f'--address={prefix}-address',f'--target-https-proxy={prefix}-https-proxy','--ports=443'])
if forward.get('IPAddress')!=address['address'] or forward.get('target')!=proxy['selfLink']:raise RuntimeError('Unexpected existing forwarding rule')
token=run('auth','print-access-token').stdout.strip()
root=f'https://firebasehosting.googleapis.com/v1beta1/projects/{project}/sites/{project}'
def hosting(path,body=None):
 req=urllib.request.Request(root+path,data=json.dumps(body).encode() if body is not None else None,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','x-goog-user-project':project})
 try:
  with urllib.request.urlopen(req,timeout=30) as response:return json.load(response)
 except urllib.error.HTTPError as error:
  if error.code==404:return None
  raise RuntimeError(f'Firebase Hosting request failed ({error.code})') from None
domains=[]
for domain in ['femlab.app','www.femlab.app']:
 record=hosting('/customDomains/'+domain)
 if record is None:
  operation=hosting('/customDomains?customDomainId='+domain,{'redirectTarget':'femlab.app'} if domain.startswith('www.') else {})
  record=hosting('/customDomains/'+domain)
  if record is None:raise RuntimeError('Custom domain creation is pending; rerun after operation '+operation['name'])
 domains.append({key:record.get(key) for key in ['name','ownershipState','hostState','requiredDnsUpdates','cert','issues']})
manifest={'project':project,'api':{'domain':'api.femlab.app','type':'A','value':address['address'],'cloudflareProxied':False,'certificateState':certificate['managed']['status']},'hosting':domains}
Path('/tmp/femlab-domain-routing-600.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps(manifest,indent=2))
