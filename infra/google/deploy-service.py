#!/usr/bin/env python3
"""Build a committed service revision and deploy it with workload identities and pinned secrets."""
import argparse,os,json,subprocess,tempfile,tarfile,shutil
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--environment',choices=['staging','production'],required=True);p.add_argument('--account',required=True);p.add_argument('--source',type=Path,required=True);a=p.parse_args()
project='femlab-app-staging' if a.environment=='staging' else 'femlab-app';instance='femlab-staging' if a.environment=='staging' else 'femlab-production';region='europe-west3';infra=Path(__file__).parent
revision=subprocess.check_output(['git','rev-parse','HEAD'],cwd=a.source,text=True).strip()
def run(*argv,optional=False,input=None):
 r=subprocess.run(['gcloud',*argv,f'--project={project}',f'--account={a.account}','--quiet'],input=input,text=True,capture_output=True)
 if r.returncode and not optional:raise RuntimeError('gcloud failed: '+' '.join(argv[:3])+': '+r.stderr[:1500])
 return r
print(project+': preparing source '+revision,flush=True)
build_sa=f'femlab-build@{project}.iam.gserviceaccount.com';bucket=f'gs://{project}-builds'
if run('storage','buckets','describe',bucket,optional=True).returncode:run('storage','buckets','create',bucket,'--location=EU','--uniform-bucket-level-access','--public-access-prevention')
run('projects','add-iam-policy-binding',project,f'--member=serviceAccount:{build_sa}','--role=roles/logging.logWriter','--condition=None')
run('artifacts','repositories','add-iam-policy-binding','femlab',f'--location={region}',f'--member=serviceAccount:{build_sa}','--role=roles/artifactregistry.writer')
run('storage','buckets','add-iam-policy-binding',bucket,f'--member=serviceAccount:{build_sa}','--role=roles/storage.objectViewer')
if run('secrets','describe','openai-api-key',optional=True).returncode:
 key=os.environ.get('OPENAI_API_KEY')
 if not key:raise RuntimeError('OPENAI_API_KEY is required to initialize the supplier secret; it is never printed or put in source.')
 run('secrets','create','openai-api-key','--replication-policy=user-managed','--locations=europe-west3');run('secrets','versions','add','openai-api-key','--data-file=-',input=key)
run('secrets','add-iam-policy-binding','openai-api-key',f'--member=serviceAccount:femlab-api@{project}.iam.gserviceaccount.com','--role=roles/secretmanager.secretAccessor')
def version(secret):return run('secrets','versions','list',secret,'--filter=state:ENABLED','--sort-by=~createTime','--limit=1','--format=value(name)').stdout.strip().split('/')[-1]
with tempfile.TemporaryDirectory(prefix='femlab-build-563-') as directory:
 root=Path(directory);archive=root/'source.tar';subprocess.run(['git','archive','--format=tar','-o',str(archive),revision],cwd=a.source,check=True)
 context=root/'context';context.mkdir()
 with tarfile.open(archive) as tar:tar.extractall(context,filter='data')
 (context/'infra/google').mkdir(parents=True,exist_ok=True)
 shutil.copy(infra/'service.Dockerfile',context/'infra/google/service.Dockerfile');shutil.copy(infra/'cloudbuild.service.yaml',context/'infra/google/cloudbuild.service.yaml')
 print(project+': submitting Cloud Build',flush=True)
 result=run('builds','submit',str(context),'--config='+str(context/'infra/google/cloudbuild.service.yaml'),f'--gcs-source-staging-dir={bucket}/sources',f'--service-account=projects/{project}/serviceAccounts/{build_sa}',f'--substitutions=_REVISION={revision}','--async','--format=json')
 build=json.loads(result.stdout);Path(f'/tmp/{project}-build-563.json').write_text(json.dumps({'project':project,'revision':revision,'buildId':build['id'],'image':f'{region}-docker.pkg.dev/{project}/femlab/service:{revision}'},indent=2))
 print(json.dumps({'project':project,'revision':revision,'buildId':build['id']}),flush=True)
