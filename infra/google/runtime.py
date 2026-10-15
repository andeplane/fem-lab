#!/usr/bin/env python3
"""Provision runtime identities/secrets and SQL users. Never prints credential material."""
import argparse,json,subprocess,secrets,urllib.request,urllib.error,time
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--environment',choices=['staging','production'],required=True);p.add_argument('--account',required=True);a=p.parse_args()
project='femlab-app-staging' if a.environment=='staging' else 'femlab-app'
instance='femlab-staging' if a.environment=='staging' else 'femlab-production'
def run(*argv,optional=False,input=None):
 for attempt in range(7):
  r=subprocess.run(['gcloud',*argv,f'--project={project}',f'--account={a.account}','--quiet'],input=input,capture_output=True,text=True)
  if not r.returncode or 'does not exist' not in r.stderr or attempt==6:break
  time.sleep(5)
 if r.returncode and not optional:raise RuntimeError('gcloud failed: '+' '.join(argv[:3])+': '+r.stderr[:1000])
 return r
def api(url,body=None,method='GET'):
 token=run('auth','print-access-token').stdout.strip()
 headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','x-goog-user-project':project}
 req=urllib.request.Request(url,data=None if body is None else json.dumps(body).encode(),headers=headers,method=method)
 try:return json.load(urllib.request.urlopen(req))
 except urllib.error.HTTPError as e:
  if e.code==404:return None
  raise RuntimeError(f'Google operation failed ({e.code})') from None
run('services','enable','iamcredentials.googleapis.com','monitoring.googleapis.com')
for name in ['api','jobs','migrate','build','scheduler']:
 email=f'femlab-{name}@{project}.iam.gserviceaccount.com'
 if run('iam','service-accounts','describe',email,optional=True).returncode:run('iam','service-accounts','create',f'femlab-{name}',f'--display-name=FEM Lab {a.environment} {name}')
 if name in ['api','jobs','migrate']:run('projects','add-iam-policy-binding',project,f'--member=serviceAccount:{email}','--role=roles/cloudsql.client','--condition=None')
roles={'femlabExportSigner':['iam.serviceAccounts.signBlob'],'femlabIdentityRemoval':['firebaseauth.users.delete']}
for name,permissions in roles.items():
 role=run('iam','roles','describe',name,optional=True)
 if role.returncode:run('iam','roles','create',name,f'--title={name}',f'--permissions={",".join(permissions)}','--stage=GA')
api_sa=f'femlab-api@{project}.iam.gserviceaccount.com';jobs_sa=f'femlab-jobs@{project}.iam.gserviceaccount.com'
run('projects','add-iam-policy-binding',project,f'--member=serviceAccount:{api_sa}','--role=roles/firebaseauth.viewer','--condition=None')
run('projects','add-iam-policy-binding',project,f'--member=serviceAccount:{jobs_sa}',f'--role=projects/{project}/roles/femlabIdentityRemoval','--condition=None')
run('iam','service-accounts','add-iam-policy-binding',api_sa,f'--member=serviceAccount:{api_sa}',f'--role=projects/{project}/roles/femlabExportSigner')
bucket=f'gs://{project}-exports'
run('storage','buckets','update',bucket,'--clear-soft-delete',f'--lifecycle-file={Path(__file__).with_name("exports-lifecycle.json")}')
run('storage','buckets','add-iam-policy-binding',bucket,f'--member=serviceAccount:{api_sa}','--role=roles/storage.objectViewer')
run('storage','buckets','add-iam-policy-binding',bucket,f'--member=serviceAccount:{jobs_sa}','--role=roles/storage.objectUser')
base=f'https://sqladmin.googleapis.com/sql/v1beta4/projects/{project}/instances/{instance}'
if not api(base+'/databases/femlab'):api(base+'/databases',{'name':'femlab'},'POST')
users={u['name'] for u in (api(base+'/users') or {}).get('items',[])}
for role,secret,sa in [('api','database-api-password','api'),('jobs','database-jobs-password','jobs'),('migrator','database-migration-password','migrate')]:
 result=run('secrets','versions','access','latest',f'--secret={secret}',optional=True)
 if result.returncode:
  password=secrets.token_urlsafe(36)
  if run('secrets','describe',secret,optional=True).returncode:run('secrets','create',secret,'--replication-policy=user-managed','--locations=europe-west3')
  run('secrets','versions','add',secret,'--data-file=-',input=password)
 else:password=result.stdout
 username=f'femlab_{role}'
 if username not in users:api(base+'/users',{'name':username,'password':password,'type':'BUILT_IN'},'POST')
 run('secrets','add-iam-policy-binding',secret,f'--member=serviceAccount:femlab-{sa}@{project}.iam.gserviceaccount.com','--role=roles/secretmanager.secretAccessor')
# The release script removes the legacy recovery access after the new job is verified.
print(project+': runtime identities, private exports and SQL credentials configured')
