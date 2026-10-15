#!/usr/bin/env python3
"""Approve one reviewed invitation through an existing local Cloud SQL proxy."""
import argparse,os,subprocess
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--environment',choices=['staging','production'],required=True)
p.add_argument('--account',required=True)
p.add_argument('--port',type=int,required=True)
p.add_argument('--source',type=Path,required=True)
p.add_argument('--account-id',required=True)
p.add_argument('--approval',required=True,help='Stable invitation/review reference; reuse for retries and recreated accounts.')
a=p.parse_args()
if not 1024 <= a.port <= 65535:p.error('Use the port of your own local Cloud SQL proxy.')
project='femlab-app-staging' if a.environment=='staging' else 'femlab-app'
password=subprocess.check_output(['gcloud','secrets','versions','access','latest','--secret=database-migration-password',f'--project={project}',f'--account={a.account}'],text=True).strip()
env=dict(os.environ,PGHOST='127.0.0.1',PGPORT=str(a.port),PGDATABASE='femlab',PGUSER='femlab_migrator',PGPASSWORD=password)
subprocess.run(['node','--import','tsx','tools/approve-trial.mts',a.account_id,a.approval],cwd=a.source.resolve(),env=env,check=True)
