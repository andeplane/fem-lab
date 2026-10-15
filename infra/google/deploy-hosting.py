#!/usr/bin/env python3
"""Compile the hosted browser app from the chosen checkout; Firebase config is public metadata."""
import argparse,json,os,subprocess,shutil,tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--environment',choices=['staging','production'],required=True);p.add_argument('--account',required=True);p.add_argument('--source',type=Path,required=True);a=p.parse_args()
infra=Path(__file__).parent;project='femlab-app-staging' if a.environment=='staging' else 'femlab-app'
api=subprocess.check_output(['gcloud','run','services','describe','femlab-api','--region=europe-west3',f'--project={project}',f'--account={a.account}','--format=value(status.url)'],text=True).strip()
public=json.loads((infra/f'firebase.{a.environment}.json').read_text())
env=dict(os.environ);env.update(FEMLAB_FIREBASE_CONFIG=json.dumps(public),FEMLAB_AI_API_ORIGIN=api,FEMLAB_BASE_PATH='/',FEMLAB_GOOGLE_SIGN_IN='false');env.pop('FEMLAB_AI_MODE',None)
subprocess.run(['npm','run','build','-w','packages/app'],cwd=a.source,env=env,check=True)
destination=infra.parent.parent/'packages/app/dist'
if destination.exists():shutil.rmtree(destination)
shutil.copytree(a.source/'packages/app/dist',destination)
with tempfile.NamedTemporaryFile(mode='w',prefix='firebase-563-',suffix='.json',dir=infra.parent.parent,delete=False) as file:
    json.dump(json.loads((infra/f'hosting.{a.environment}.json').read_text()),file);config=Path(file.name)
try:
    subprocess.run(['firebase','deploy','--only','hosting',f'--config={config}',f'--project={project}',f'--account={a.account}','--non-interactive'],cwd=infra.parent.parent,check=True)
finally:config.unlink(missing_ok=True)

print(json.dumps({'project':project,'source':subprocess.check_output(['git','rev-parse','HEAD'],cwd=a.source,text=True).strip(),'url':f'https://{project}.web.app','apiOrigin':api,'googleLogin':'disabled','billing':'disabled'}))
