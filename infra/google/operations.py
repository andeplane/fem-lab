#!/usr/bin/env python3
"""Deploy read-only operational checks and durable machine-only alert delivery (#556)."""
import argparse
import datetime
import json
from pathlib import Path
import re
import subprocess
import urllib.error
import urllib.request
import uuid

REGION = 'europe-west3'
JOB = 'femlab-operations'
TOPIC = 'femlab-operations-alerts'
SUBSCRIPTION = 'femlab-operations-alerts-operator'
DISPLAY = 'FEM Lab operational alarm'


def configuration(project, image, secret_version, signup_limit='20'):
    if project not in ('femlab-app', 'femlab-app-staging'):
        raise ValueError('Expected the staging or production project.')
    if not re.fullmatch(r'europe-west3-docker\.pkg\.dev/' + re.escape(project) + r'/femlab/service@sha256:[a-f0-9]{64}', image):
        raise ValueError('A same-project immutable service digest is required.')
    if not re.fullmatch(r'[1-9][0-9]*', secret_version):
        raise ValueError('Pin the database secret to a numbered version.')
    if not re.fullmatch(r'[1-9][0-9]*', signup_limit) or int(signup_limit)>1_000_000:
        raise ValueError('Signup threshold must be an integer from 1 through 1000000.')
    instance = 'femlab-staging' if project.endswith('-staging') else 'femlab-production'
    connection = f'{project}:{REGION}:{instance}'
    return {
        'job': ['run', 'jobs', 'deploy', JOB, f'--region={REGION}', f'--image={image}',
                f'--service-account=femlab-jobs@{project}.iam.gserviceaccount.com',
                '--cpu=1', '--memory=512Mi', '--tasks=1', '--max-retries=0', '--task-timeout=30s',
                '--command=node', '--args=service/main.mjs,--operations',
                f'--set-cloudsql-instances={connection}',
                '--set-env-vars=^|^PGHOST=/cloudsql/' + connection + '|PGDATABASE=femlab|PGUSER=femlab_jobs|PGAPPNAME=femlab-operations|PGOPTIONS=-c default_transaction_read_only=on|OPERATIONS_SIGNUP_LIMIT=' + signup_limit,
                f'--set-secrets=PGPASSWORD=database-jobs-password:{secret_version}'],
        'filter': f'resource.type="cloud_run_job" AND resource.labels.job_name="{JOB}" AND severity>=ERROR',
        'scheduler_uri': f'https://run.googleapis.com/v2/projects/{project}/locations/{REGION}/jobs/{JOB}:run',
    }


def policy(project, channel, log_filter):
    return {'displayName': DISPLAY, 'combiner': 'OR', 'enabled': True,
            'conditions': [{'displayName': 'Read-only check failed or found an actionable alarm',
                            'conditionMatchedLog': {'filter': log_filter}}],
            'notificationChannels': [channel],
            'alertStrategy': {'notificationRateLimit': {'period': '900s'}, 'autoClose': '1800s'},
            'documentation': {'mimeType': 'text/markdown', 'content':
                'Run `node service/main.mjs --operations` with read-only database access. '
                'Inspect aggregate alarms and the recovery job. Never release an uncertain hold, '
                'raise a ceiling, or mint an entitlement from an alert. '
                'This channel delivers to the durable operator Pub/Sub subscription, not email.'}}


def category_policies(project, channel):
    # Fixture jobs have no public ingress; fixture services require a private capability. Neither has real identities or provider credentials.
    # Their explicit source events exercise the same policies as the live API/check.
    qa = '(jsonPayload.synthetic=true AND ((resource.type="cloud_run_revision" AND resource.labels.service_name=~"^femlab-qa556-[a-f0-9]+$") OR (resource.type="cloud_run_job" AND resource.labels.job_name=~"^femlab-qa556-[a-f0-9]+$")))'
    provider_filter = ('severity>=ERROR AND jsonPayload.event="service-provider-error" AND '
        '((resource.type="cloud_run_revision" AND resource.labels.service_name="femlab-api") OR '+qa+')')
    signup_filter = ('severity>=ERROR AND jsonPayload.event="service-operations" AND jsonPayload.alarms.code="signup-surge" AND '
        f'((resource.type="cloud_run_job" AND resource.labels.job_name="{JOB}") OR '+qa+')')
    result = {}
    for category, display, condition, query in [
        ('provider', 'FEM Lab provider errors', 'A provider failed including inside a 200 SSE stream', provider_filter),
        ('signup', 'FEM Lab unusual signup traffic', 'New accounts reached the configured twenty-minute review threshold', signup_filter),
    ]:
        desired = policy(project, channel, query)
        desired['displayName'] = display
        desired['conditions'][0]['displayName'] = condition
        desired['documentation']['content'] = (
            'Inspect fixed provider failure codes or the redacted signup count. '
            'An HTTP 200 stream is not provider-success proof. Signup alarms never approve free access, '
            'change account policy or automatically change supplier ceilings. '
            'This policy has a separate notification rate limit and uses the durable machine subscription.')
        result[category] = desired
    return result


def upsert_policy(cloud, desired, policies):
    matches = [p for p in policies if p.get('displayName') == desired['displayName']]
    if len(matches)>1:
        raise RuntimeError('Multiple owned alert policies need reconciliation.')
    if matches:
        current=matches[0]
        def same(want,have):
            if isinstance(want,dict):
                return isinstance(have,dict) and all(key=='name' or same(item,have.get(key)) for key,item in want.items())
            if isinstance(want,list):
                return isinstance(have,list) and len(want)==len(have) and all(same(a,b) for a,b in zip(want,have))
            return want==have
        # Repatching an unchanged policy discards Monitoring's precomputed incident
        # state. Compare the fields managed here; preserve generated IDs/defaults.
        if same(desired,current):
            return current
        desired['name']=current['name']
        if len(desired['conditions'])==len(current.get('conditions',[]))==1:
            condition_name=current['conditions'][0].get('name')
            if condition_name:desired['conditions'][0]['name']=condition_name
        return cloud.api('monitoring','v3/'+desired['name'],desired,'PATCH')
    return cloud.api('monitoring',f'v3/projects/{cloud.project}/alertPolicies',desired,'POST')


class Cloud:
    def __init__(self, project, account):
        self.project, self.account = project, account

    def run(self, *args, optional=False):
        result = subprocess.run(['gcloud', *args, f'--project={self.project}', f'--account={self.account}', '--quiet'],
                                text=True, capture_output=True)
        if result.returncode and not optional:
            # Never include untrusted CLI output or credential-bearing command parameters.
            raise RuntimeError('gcloud operation failed: ' + ' '.join(args[:3]))
        return result

    def api(self, service, path, body=None, method='GET'):
        token = self.run('auth', 'print-access-token').stdout.strip()
        request = urllib.request.Request(f'https://{service}.googleapis.com/{path}',
            data=None if body is None else json.dumps(body).encode(),
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'x-goog-user-project': self.project}, method=method)
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f'{service} operation failed ({error.code})') from None


def deploy(cloud, image, signup_limit='20'):
    project = cloud.project
    version = cloud.run('secrets', 'versions', 'list', 'database-jobs-password', '--filter=state:ENABLED', '--sort-by=~createTime', '--limit=1', '--format=value(name)').stdout.strip().split('/')[-1]
    config = configuration(project, image, version, signup_limit)
    cloud.run('services', 'enable', 'pubsub.googleapis.com', 'monitoring.googleapis.com')
    if cloud.run('pubsub', 'topics', 'describe', TOPIC, optional=True).returncode:
        cloud.run('pubsub', 'topics', 'create', TOPIC, '--message-storage-policy-allowed-regions=europe-west3')
    if cloud.run('pubsub', 'subscriptions', 'describe', SUBSCRIPTION, optional=True).returncode:
        cloud.run('pubsub', 'subscriptions', 'create', SUBSCRIPTION, f'--topic={TOPIC}', '--message-retention-duration=7d', '--expiration-period=never')
    channels = cloud.api('monitoring', f'v3/projects/{project}/notificationChannels').get('notificationChannels', [])
    topic = f'projects/{project}/topics/{TOPIC}'
    matches = [c for c in channels if c.get('type') == 'pubsub' and c.get('labels', {}).get('topic') == topic]
    channel = matches[0] if matches else cloud.api('monitoring', f'v3/projects/{project}/notificationChannels', {'type': 'pubsub', 'displayName': DISPLAY + ' machine sink', 'labels': {'topic': topic}, 'enabled': True}, 'POST')
    number = cloud.run('projects', 'describe', project, '--format=value(projectNumber)').stdout.strip()
    cloud.run('pubsub', 'topics', 'add-iam-policy-binding', TOPIC, f'--member=serviceAccount:service-{number}@gcp-sa-monitoring-notification.iam.gserviceaccount.com', '--role=roles/pubsub.publisher')
    desired = policy(project, channel['name'], config['filter'])
    policies = cloud.api('monitoring', f'v3/projects/{project}/alertPolicies').get('alertPolicies', [])
    result=upsert_policy(cloud,desired,policies)
    categories={name:upsert_policy(cloud,body,policies)['name'] for name,body in category_policies(project,channel['name']).items()}
    cloud.run(*config['job'])
    cloud.run('run', 'jobs', 'add-iam-policy-binding', JOB, f'--region={REGION}', f'--member=serviceAccount:femlab-scheduler@{project}.iam.gserviceaccount.com', '--role=roles/run.invoker')
    exists = not cloud.run('scheduler', 'jobs', 'describe', JOB, f'--location={REGION}', optional=True).returncode
    cloud.run('scheduler', 'jobs', 'update' if exists else 'create', 'http', JOB, f'--location={REGION}', '--schedule=*/10 * * * *', '--time-zone=UTC', f"--uri={config['scheduler_uri']}", '--http-method=POST', f'--oauth-service-account-email=femlab-scheduler@{project}.iam.gserviceaccount.com', '--oauth-token-scope=https://www.googleapis.com/auth/cloud-platform')
    return {'project': project, 'image': image, 'job': JOB, 'secretVersion': version, 'policy': result['name'], 'channel': channel['name'], 'subscription': f'projects/{project}/subscriptions/{SUBSCRIPTION}', 'filter': config['filter'], 'categoryPolicies': categories, 'signupLimit': signup_limit}


def notification_drill(cloud, receipt):
    run = 'drill-' + uuid.uuid4().hex
    at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    cloud.api('logging', 'v2/entries:write', {
        'logName': f'projects/{cloud.project}/logs/femlab-operations-drill',
        'resource': {'type': 'cloud_run_job', 'labels': {'project_id': cloud.project, 'location': REGION, 'job_name': JOB}},
        'entries': [{'severity': 'ERROR', 'timestamp': at, 'labels': {'drill_run': run},
            'jsonPayload': {'event': 'service-operations', 'status': 'action-required', 'synthetic': True,
                            'code': 'operations-delivery-drill', 'drillRun': run}}]}, 'POST')
    # A matching policy incident, not publishing directly to Pub/Sub, is required.
    # The caller bounds the wait and may invoke again after notification propagation.
    return {'run': run, 'at': at, 'policy': receipt['policy']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--environment', choices=['staging', 'production'], required=True)
    parser.add_argument('--account', required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--receipt', type=Path, required=True)
    parser.add_argument('--signup-limit',default='20')
    parser.add_argument('--notification-drill', action='store_true')
    args = parser.parse_args()
    cloud = Cloud('femlab-app-staging' if args.environment == 'staging' else 'femlab-app', args.account)
    receipt = deploy(cloud, args.image, args.signup_limit)
    args.receipt.write_text(json.dumps(receipt, indent=2) + '\n')
    if args.notification_drill:
        receipt['notificationDrill'] = notification_drill(cloud, receipt)
    args.receipt.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
