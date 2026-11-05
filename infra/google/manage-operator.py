#!/usr/bin/env python3
"""Authenticated operator suspension, debit correction and durable recovery (#556)."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.request


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--environment',choices=['staging','production'],required=True)
    p.add_argument('--account',required=True,help='Existing authenticated Google Cloud principal.')
    p.add_argument('--source',type=Path,required=True)
    p.add_argument('--port',type=int)
    p.add_argument('--action',choices=['debit','suspend','recover'],required=True)
    p.add_argument('--account-id')
    p.add_argument('--grant-id')
    p.add_argument('--subcredits')
    p.add_argument('--operation-id',required=True,help='Stable UUID; reuse exactly on retries.')
    p.add_argument('--reason-ref',required=True,help='Non-personal issue/case reference, max64 ASCII characters.')
    p.add_argument('--receipt',type=Path,required=True)
    p.add_argument('--dry-run',action='store_true',help='Verify principal and project permissions without SQL or Auth mutations.')
    a=p.parse_args()
    uuid=r'[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}'
    if not re.fullmatch(uuid,a.operation_id) or not re.fullmatch(r'[-a-zA-Z0-9._]{1,64}',a.reason_ref):p.error('Use an operation UUID and a bounded, non-personal reason reference.')
    if a.action!='recover':
        if not a.port or not 1024<=a.port<=65535 or not re.fullmatch(uuid,a.account_id or ''):p.error('Select the target account UUID and the port of your own Cloud SQL proxy.')
    if a.action=='debit':
        if not re.fullmatch(uuid,a.grant_id or '') or not re.fullmatch(r'[1-9][0-9]{0,18}',a.subcredits or '') or int(a.subcredits)>9223372036854775807:p.error('Use a grant UUID and positive exact integer subcredits within signed bigint.')
    elif a.grant_id or a.subcredits:p.error('Debit fields are accepted only for a debit action.')
    project='femlab-app-staging' if a.environment=='staging' else 'femlab-app'
    clean_env={k:v for k,v in os.environ.items() if k not in ['CLOUDSDK_AUTH_ACCESS_TOKEN','CLOUDSDK_AUTH_ACCESS_TOKEN_FILE','GOOGLE_APPLICATION_CREDENTIALS','CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','OPENAI_API_KEY','FREE_ELIGIBILITY_HMAC_KEY','FEMLAB_OPERATOR_ACCESS_TOKEN']}
    def g(*args):
        result=subprocess.run(['gcloud',*args,'--project='+project,'--account='+a.account,'--quiet'],env=clean_env,text=True,capture_output=True)
        if result.returncode:raise RuntimeError('Authenticated cloud operation unavailable.')
        return result.stdout.strip()
    def save(receipt):
        a.receipt.parent.mkdir(parents=True,exist_ok=True)
        descriptor=os.open(a.receipt,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
        with os.fdopen(descriptor,'w') as f:json.dump(receipt,f,indent=2);f.write('\n')
        os.chmod(a.receipt,0o600)
        print(json.dumps(receipt))
    base={'event':'operator-action','action':a.action,'environment':a.environment,'operationId':a.operation_id.lower(),'reasonRef':a.reason_ref}
    try:
        # A source account label must not silently name an impersonated or injected principal.
        impersonation=g('config','get-value','auth/impersonate_service_account')
        if impersonation not in ('','(unset)'):raise RuntimeError('Select a directly authenticated principal.')
        token=g('auth','print-access-token')
        request=urllib.request.Request('https://openidconnect.googleapis.com/v1/userinfo',headers={'Authorization':'Bearer '+token})
        with urllib.request.urlopen(request,timeout=20) as response:identity=json.load(response)
        if str(identity.get('email','')).casefold()!=a.account.casefold():raise RuntimeError('Authenticated principal did not match the selected account.')
        actor=hashlib.sha256(str(identity['email']).casefold().encode()).hexdigest();base['actorRef']=actor
        permissions=['run.jobs.run'] if a.action=='recover' else ['cloudsql.instances.connect']+(['firebaseauth.users.update'] if a.action=='suspend' else [])
        request=urllib.request.Request(f'https://cloudresourcemanager.googleapis.com/v1/projects/{project}:testIamPermissions',data=json.dumps({'permissions':permissions}).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'},method='POST')
        with urllib.request.urlopen(request,timeout=20) as response:granted=json.load(response).get('permissions',[])
        if not set(permissions)<=set(granted):raise RuntimeError('Required operator permissions are unavailable.')
        if a.dry_run:
            save({**base,'dryRun':True,'permissions':granted,'mutations':0});return 0
        if a.action=='recover':
            execution=json.loads(g('run','jobs','execute','femlab-recover','--region=europe-west3','--wait','--format=json'))
            status=execution.get('status',{});name=execution.get('metadata',{}).get('name')
            if not name or status.get('succeededCount')!=1 or status.get('failedCount',0)!=0:
                raise RuntimeError('Recovery execution did not establish one successful task.')
            save({**base,'execution':name,'succeeded':1,'failed':0});return 0
        script=a.source.resolve()/'packages/service/tools/manage-operator.ts'
        if not script.is_file():raise RuntimeError('The reviewed source checkout is unavailable.')
        password=g('secrets','versions','access','latest','--secret=database-migration-password')
        env={**clean_env,'PGHOST':'127.0.0.1','PGPORT':str(a.port),'PGDATABASE':'femlab','PGUSER':'femlab_migrator','PGPASSWORD':password,'PGOPTIONS':'-c search_path=public','FEMLAB_OPERATOR_ACTOR_REF':actor,'FIREBASE_PROJECT_ID':project}
        env.pop('FEMLAB_OPERATOR_ACCESS_TOKEN',None)
        if a.action=='suspend':env['FEMLAB_OPERATOR_ACCESS_TOKEN']=token
        argv=['node','--import','tsx',str(script),a.action,a.account_id,a.operation_id,a.reason_ref]
        if a.action=='debit':argv += [a.grant_id,a.subcredits]
        result=subprocess.run(argv,cwd=a.source.resolve(),env=env,text=True,capture_output=True,timeout=60)
        output=json.loads(result.stdout)
        if output.get('actorRef')!=actor or output.get('operationId')!=a.operation_id.lower() or output.get('action')!=a.action:raise RuntimeError('The operator receipt was invalid.')
        save({**base,**{key:output[key] for key in ['result','code','cause','details'] if key in output}})
        return result.returncode
    except Exception:
        save({**base,'code':'operator-action-unavailable','cause':'The action did not fully complete. Private credentials and diagnostics are suppressed.'});return 1


if __name__=='__main__':sys.exit(main())
