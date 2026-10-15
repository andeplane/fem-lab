#!/usr/bin/env python3
"""Compile the hosted browser app from the chosen checkout; Firebase config is public metadata."""
import argparse,json,os,subprocess,shutil,tempfile,urllib.request,urllib.error
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--environment',choices=['staging','production'],required=True);p.add_argument('--account',required=True);p.add_argument('--source',type=Path,required=True)
p.add_argument('--custom-domain',action='store_true',help='Use femlab.app and api.femlab.app after HTTPS and project verification.')
p.add_argument('--build-only',action='store_true',help='Prepare the deployable browser artifact without publishing it.')
p.add_argument('--google-sign-in',action='store_true',help='Show Google login only after verifying the enabled Firebase provider.')
a=p.parse_args();a.source=a.source.resolve()
if a.custom_domain and a.environment!='production':p.error('--custom-domain is only available for production')
infra=Path(__file__).parent;project='femlab-app-staging' if a.environment=='staging' else 'femlab-app'
api=subprocess.check_output(['gcloud','run','services','describe','femlab-api','--region=europe-west3',f'--project={project}',f'--account={a.account}','--format=value(status.url)'],text=True).strip()
public=json.loads((infra/f'firebase.{a.environment}.json').read_text())
site=f'https://{project}.web.app'
if a.custom_domain:
    # Validate certificates normally and verify the domain belongs to this Firebase project.
    # A DNS change alone is insufficient evidence for switching the working browser release.
    site='https://femlab.app';api='https://api.femlab.app'
    with urllib.request.urlopen(site+'/__/firebase/init.json',timeout=30) as response:hosted=json.load(response)
    if hosted.get('projectId')!=project or hosted.get('appId')!=public['appId']:raise RuntimeError('Custom domain serves an unexpected Firebase project or app')
    with urllib.request.urlopen(api+'/ready',timeout=30) as response:readiness=json.load(response)
    if readiness.get('status')!='ready':raise RuntimeError('Custom API is not ready')
    public['authDomain']='femlab.app'
if a.google_sign_in:
    token=subprocess.check_output(['gcloud','auth','print-access-token',f'--project={project}',f'--account={a.account}'],text=True).strip()
    url=f'https://identitytoolkit.googleapis.com/admin/v2/projects/{project}/defaultSupportedIdpConfigs/google.com?fields=enabled,clientId'
    request=urllib.request.Request(url,headers={'Authorization':'Bearer '+token,'x-goog-user-project':project})
    try:
        with urllib.request.urlopen(request,timeout=30) as response:provider=json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'Cannot verify the Google provider ({error.code}); configure it before enabling the browser button') from None
    if not provider.get('enabled') or not provider.get('clientId'):raise RuntimeError('Configure an enabled Google provider and web client before showing Google login')
env=dict(os.environ);env.update(FEMLAB_FIREBASE_CONFIG=json.dumps(public),FEMLAB_AI_API_ORIGIN=api,FEMLAB_BASE_PATH='/',FEMLAB_GOOGLE_SIGN_IN=str(a.google_sign_in).lower());env.pop('FEMLAB_AI_MODE',None)
subprocess.run(['npm','run','build','-w','packages/app'],cwd=a.source,env=env,check=True)
destination=infra.parent.parent/'packages/app/dist'
source=a.source/'packages/app/dist'
if source.resolve()!=destination.resolve():
    if destination.exists():shutil.rmtree(destination)
    shutil.copytree(source,destination)
with tempfile.NamedTemporaryFile(mode='w',prefix='firebase-563-',suffix='.json',dir=infra.parent.parent,delete=False) as file:
    json.dump(json.loads((infra/f'hosting.{a.environment}.json').read_text()),file);config=Path(file.name)
try:
    if not a.build_only:subprocess.run(['firebase','deploy','--only','hosting',f'--config={config}',f'--project={project}',f'--account={a.account}','--non-interactive'],cwd=infra.parent.parent,check=True)
finally:config.unlink(missing_ok=True)

print(json.dumps({'project':project,'source':subprocess.check_output(['git','rev-parse','HEAD'],cwd=a.source,text=True).strip(),'url':site,'apiOrigin':api,'authDomain':public['authDomain'],'published':not a.build_only,'googleLogin':'enabled' if a.google_sign_in else 'disabled','billing':'disabled'}))
