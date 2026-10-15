#!/usr/bin/env python3
"""Migrate through an existing IAM Cloud SQL proxy, then apply runtime permissions."""
import argparse,os,subprocess,shutil
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--environment',choices=['staging','production'],required=True);p.add_argument('--account',required=True);p.add_argument('--port',type=int,required=True);p.add_argument('--source',type=Path,required=True);a=p.parse_args()
project='femlab-app-staging' if a.environment=='staging' else 'femlab-app'
password=subprocess.check_output(['gcloud','secrets','versions','access','latest','--secret=database-migration-password',f'--project={project}',f'--account={a.account}'],text=True)
env=dict(os.environ);env.pop('GOOGLE_APPLICATION_CREDENTIALS',None);env.update(PGHOST='127.0.0.1',PGPORT=str(a.port),PGDATABASE='femlab',PGUSER='femlab_migrator',PGPASSWORD=password,FIREBASE_PROJECT_ID=project)
subprocess.run(['node','packages/service/dist/main.mjs','--migrate'],cwd=a.source,env=env,check=True)
if a.environment=='staging':
 subprocess.run([shutil.which('psql') or '/opt/homebrew/opt/postgresql@17/bin/psql','-v','ON_ERROR_STOP=1','-f',str(Path(__file__).with_name('sql-staging-ai-paused.sql'))],env=env,check=True)
subprocess.run([shutil.which('psql') or '/opt/homebrew/opt/postgresql@17/bin/psql','-v','ON_ERROR_STOP=1','-f',str(Path(__file__).with_name('sql-runtime-grants.sql'))],env=env,check=True)
print(project+': schema migrations and restricted runtime grants applied')
