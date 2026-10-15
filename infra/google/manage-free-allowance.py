#!/usr/bin/env python3
"""Operator-reviewed eligibility only; never run automatically on sign-in."""
import argparse,json,os,subprocess,sys
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--environment',choices=['staging','production'],required=True)
p.add_argument('--account',required=True)
p.add_argument('--port',type=int,required=True)
p.add_argument('--source',type=Path,required=True)
p.add_argument('--action',choices=['approve','revoke','rebind'],required=True)
p.add_argument('--account-id',required=True)
p.add_argument('--person-reference',required=True,help='Reuse one reviewed-person reference across retries and recreated accounts; no personal data.')
a=p.parse_args()
if not 1024<=a.port<=65535:p.error('Use the port of your own local Cloud SQL proxy.')
project='femlab-app-staging' if a.environment=='staging' else 'femlab-app'
def secret(name,version):
 return subprocess.check_output(['gcloud','secrets','versions','access',version,'--secret='+name,'--project='+project,'--account='+a.account],text=True,stderr=subprocess.PIPE).strip()
try:
 env=dict(os.environ,PGHOST='127.0.0.1',PGPORT=str(a.port),PGDATABASE='femlab',PGUSER='femlab_migrator',PGPASSWORD=secret('database-migration-password','latest'))
 env.pop('GOOGLE_APPLICATION_CREDENTIALS',None)
 if a.action!='revoke':env['FREE_ELIGIBILITY_HMAC_KEY']=secret('free-eligibility-hmac-key','1')
 else:env.pop('FREE_ELIGIBILITY_HMAC_KEY',None)
 result=subprocess.run(['node','--import','tsx','tools/manage-free-allowance.mts',a.action,a.account_id,a.person_reference],cwd=a.source.resolve(),env=env,text=True,capture_output=True)
 for line in (result.stdout+'\n'+result.stderr).splitlines():
  if line.startswith('{'):print(line)
 if result.returncode and not any(line.startswith('{') for line in result.stderr.splitlines()):print(json.dumps({'code':'eligibility-operation-unavailable','cause':'Private operator diagnostics suppressed.'}))
 sys.exit(result.returncode)
except Exception:
 print(json.dumps({'code':'eligibility-operation-unavailable','cause':'Private operator diagnostics suppressed.'}));sys.exit(1)
