#!/usr/bin/env python3
"""Release only a successful immutable build; billing is explicitly disabled until configured."""
import argparse,json,subprocess,urllib.request
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--environment',choices=['staging','production'],required=True);p.add_argument('--account',required=True);a=p.parse_args()
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
common=f'PGHOST=/cloudsql/{connection}|PGDATABASE=femlab|FIREBASE_PROJECT_ID={project}|EXPORT_BUCKET={project}-exports|BILLING_ENABLED=false'
origins=f'https://{project}.web.app,https://{project}.firebaseapp.com'
if a.environment=='production':origins+=',https://femlab.app,https://www.femlab.app'
api_env='^|^'+common+f'|PGUSER=femlab_api|APP_ORIGINS={origins}|APP_RETURN_ORIGIN=https://{project}.web.app'
print(project+': releasing API '+manifest['revision'],flush=True)
run('run','deploy','femlab-api',f'--image={image}',f'--region={region}',f'--service-account=femlab-api@{project}.iam.gserviceaccount.com','--execution-environment=gen2','--cpu=1','--memory=512Mi','--concurrency=8','--min-instances=0','--max-instances=2','--timeout=900s','--allow-unauthenticated',f'--set-cloudsql-instances={connection}',f'--set-env-vars={api_env}',f'--set-secrets=PGPASSWORD=database-api-password:{version("database-api-password")},OPENAI_API_KEY=openai-api-key:{version("openai-api-key")}','--startup-probe=httpGet.path=/ready,httpGet.port=8080,periodSeconds=10,timeoutSeconds=5,failureThreshold=12')
uri=run('run','services','describe','femlab-api',f'--region={region}','--format=value(status.url)').stdout.strip()
with urllib.request.urlopen(uri+'/ready') as response:
 if response.status!=200:raise RuntimeError('API is not ready')
print(project+': releasing recovery job',flush=True)
run('run','jobs','deploy','femlab-recover',f'--image={image}',f'--region={region}',f'--service-account=femlab-jobs@{project}.iam.gserviceaccount.com','--cpu=1','--memory=1Gi','--tasks=1','--max-retries=1','--task-timeout=900s','--command=node','--args=service/main.mjs,--recover',f'--set-cloudsql-instances={connection}',f'--set-env-vars=^|^{common}|PGUSER=femlab_jobs',f'--set-secrets=PGPASSWORD=database-jobs-password:{version("database-jobs-password")}')
run('run','jobs','execute','femlab-recover',f'--region={region}','--wait')
# Only after the new recovery identity has executed successfully, remove its legacy DDL access.
run('secrets','remove-iam-policy-binding','database-migration-password',f'--member=serviceAccount:femlab-jobs@{project}.iam.gserviceaccount.com','--role=roles/secretmanager.secretAccessor',optional=True)
run('run','jobs','add-iam-policy-binding','femlab-recover',f'--region={region}',f'--member=serviceAccount:femlab-scheduler@{project}.iam.gserviceaccount.com','--role=roles/run.invoker')
name='femlab-usage-recovery';operation='update' if not run('scheduler','jobs','describe',name,f'--location={region}',optional=True).returncode else 'create'
run('scheduler','jobs',operation,'http',name,f'--location={region}','--schedule=*/10 * * * *','--time-zone=UTC',f'--uri=https://run.googleapis.com/v2/projects/{project}/locations/{region}/jobs/femlab-recover:run','--http-method=POST',f'--oauth-service-account-email=femlab-scheduler@{project}.iam.gserviceaccount.com','--oauth-token-scope=https://www.googleapis.com/auth/cloud-platform')
manifest.update(image=image,apiOrigin=uri);Path(f'/tmp/{project}-release-563.json').write_text(json.dumps(manifest,indent=2))
print(json.dumps({'project':project,'revision':manifest['revision'],'image':image,'apiOrigin':uri,'billing':'disabled'}),flush=True)
