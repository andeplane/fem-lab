#!/usr/bin/env python3
"""Release a successful immutable build, preserving verified billing configuration."""
import argparse,hashlib,json,subprocess,sys,urllib.request
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'stripe'))
from billing_config import resolve as billing_config
p=argparse.ArgumentParser();p.add_argument('--environment',choices=['staging','production'],required=True);p.add_argument('--account',required=True);p.add_argument('--billing',choices=['preserve','disabled','enabled'],default='preserve');a=p.parse_args()
project='femlab-app-staging' if a.environment=='staging' else 'femlab-app';instance='femlab-staging' if a.environment=='staging' else 'femlab-production';region='europe-west3'
manifest=json.loads(Path(f'/tmp/{project}-build-563.json').read_text());image=manifest['image']
def run(*argv,optional=False):
 r=subprocess.run(['gcloud',*argv,f'--project={project}',f'--account={a.account}','--quiet'],text=True,capture_output=True)
 if r.returncode and not optional:raise RuntimeError('gcloud failed: '+' '.join(argv[:3])+': '+r.stderr[:1600])
 return r
status=run('builds','describe',manifest['buildId'],'--format=value(status)').stdout.strip()
if status!='SUCCESS':raise RuntimeError('Build must be SUCCESS before release; current status: '+status)
digest=json.loads(run('artifacts','docker','images','describe',image,'--format=json').stdout)['image_summary']['digest'];image=image.split(':')[0]+'@'+digest
connection=f'{project}:{region}:{instance}'
def version(name):return run('secrets','versions','list',name,'--filter=state:ENABLED','--sort-by=~createTime','--limit=1','--format=value(name)').stdout.strip().split('/')[-1]
before=run('run','services','describe','femlab-api',f'--region={region}','--format=json',optional=True)
previous_service=json.loads(before.stdout) if not before.returncode else None
previous=previous_service['status'] if previous_service else None
serving_billing=set()
for traffic in previous['traffic'] if previous else []:
 if not traffic.get('percent'):continue
 serving=json.loads(run('run','revisions','describe',traffic['revisionName'],f'--region={region}','--format=json').stdout)
 env={item['name']:item.get('value') for item in serving['spec']['containers'][0].get('env',[])}
 serving_billing.add(env.get('BILLING_ENABLED')=='true')
if len(serving_billing)>1 and a.billing=='preserve':raise RuntimeError('Serving revisions disagree on billing; choose --billing enabled or disabled explicitly.')
billing=billing_config(a.environment,project,run,True in serving_billing,a.billing)
rollback={item['revisionName']:item['percent'] for item in previous['traffic'] if item.get('percent')} if previous else {}
def ready(uri):
 with urllib.request.urlopen(uri+'/ready',timeout=30) as response:
  if response.status!=200:raise RuntimeError('API is not ready')
rollback_ready=False
if previous:
 try:ready(previous['url']);rollback_ready=True
 except Exception:pass
return_origin='https://femlab.app' if a.environment=='production' else f'https://{project}.web.app'
common=f'PGHOST=/cloudsql/{connection}|PGDATABASE=femlab|FIREBASE_PROJECT_ID={project}|EXPORT_BUCKET={project}-exports|APP_RETURN_ORIGIN={return_origin}|'+'|'.join(f'{key}={value}' for key,value in billing['env'].items())
stripe_secrets=''.join(f',{key}={value}' for key,value in billing['secrets'].items())
origins=f'https://{project}.web.app,https://{project}.firebaseapp.com'
if a.environment=='production':origins+=',https://femlab.app,https://www.femlab.app'
api_env='^|^'+common+f'|PGUSER=femlab_api|APP_ORIGINS={origins}'
print(project+': releasing API '+manifest['revision'],flush=True)
api_secrets=f'PGPASSWORD=database-api-password:{version("database-api-password")},OPENAI_API_KEY=openai-api-key:{version("openai-api-key")}{stripe_secrets}'
# A billing activation or secret rotation can release the same image again under a new immutable revision.
config_hash=hashlib.sha256((api_env+'|'+api_secrets).encode()).hexdigest()[:8]
suffix='r'+manifest['buildId'].split('-')[0]+'-'+config_hash
revision='femlab-api-'+suffix
run('run','deploy','femlab-api',f'--image={image}',f'--region={region}',f'--revision-suffix={suffix}','--no-traffic','--tag=release-candidate',f'--service-account=femlab-api@{project}.iam.gserviceaccount.com','--execution-environment=gen2','--cpu=1','--memory=512Mi','--concurrency=8','--min-instances=0','--max-instances=2','--timeout=900s','--allow-unauthenticated',f'--set-cloudsql-instances={connection}',f'--set-env-vars={api_env}',f'--set-secrets={api_secrets}','--startup-probe=httpGet.path=/ready,httpGet.port=8080,periodSeconds=10,timeoutSeconds=5,failureThreshold=12')
candidate=json.loads(run('run','services','describe','femlab-api',f'--region={region}','--format=json').stdout)['status']
route=next(item for item in candidate['traffic'] if item.get('tag')=='release-candidate' and item['revisionName']==revision)
ready(route['url']);uri=candidate['url']
print(project+': releasing recovery job',flush=True)
run('run','jobs','deploy','femlab-recover',f'--image={image}',f'--region={region}',f'--service-account=femlab-jobs@{project}.iam.gserviceaccount.com','--cpu=1','--memory=1Gi','--tasks=1','--max-retries=1','--task-timeout=900s','--command=node','--args=service/main.mjs,--recover',f'--set-cloudsql-instances={connection}',f'--set-env-vars=^|^{common}|PGUSER=femlab_jobs',f'--set-secrets=PGPASSWORD=database-jobs-password:{version("database-jobs-password")}{stripe_secrets}')
run('run','jobs','execute','femlab-recover',f'--region={region}','--wait')
# Only after the new recovery identity has executed successfully, remove its legacy DDL access.
run('secrets','remove-iam-policy-binding','database-migration-password',f'--member=serviceAccount:femlab-jobs@{project}.iam.gserviceaccount.com','--role=roles/secretmanager.secretAccessor',optional=True)
run('run','jobs','add-iam-policy-binding','femlab-recover',f'--region={region}',f'--member=serviceAccount:femlab-scheduler@{project}.iam.gserviceaccount.com','--role=roles/run.invoker')
name='femlab-usage-recovery';operation='update' if not run('scheduler','jobs','describe',name,f'--location={region}',optional=True).returncode else 'create'
run('scheduler','jobs',operation,'http',name,f'--location={region}','--schedule=*/10 * * * *','--time-zone=UTC',f'--uri=https://run.googleapis.com/v2/projects/{project}/locations/{region}/jobs/femlab-recover:run','--http-method=POST',f'--oauth-service-account-email=femlab-scheduler@{project}.iam.gserviceaccount.com','--oauth-token-scope=https://www.googleapis.com/auth/cloud-platform')
run('run','services','update-traffic','femlab-api',f'--region={region}',f'--to-revisions={revision}=100')
try:ready(uri)
except Exception:
 if rollback_ready and rollback:
  run('run','services','update-traffic','femlab-api',f'--region={region}','--to-revisions='+','.join(f'{name}={weight}' for name,weight in rollback.items()))
  ready(uri)
 raise
manifest.update(image=image,apiOrigin=uri,apiRevision=revision,rollbackRevisions=rollback if rollback_ready else {});Path(f'/tmp/{project}-release-563.json').write_text(json.dumps(manifest,indent=2))
print(json.dumps({'project':project,'revision':manifest['revision'],'image':image,'apiOrigin':uri,'billing':billing['env']['BILLING_ENABLED'],'billingMode':billing['mode']}),flush=True)
