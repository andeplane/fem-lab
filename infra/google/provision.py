#!/usr/bin/env python3
"""Idempotent project/Auth baseline. Credentials stay in gcloud/Firebase and never in output."""
import argparse
import json
import subprocess
import urllib.error
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--environment', choices=['staging', 'production'], required=True)
parser.add_argument('--account', required=True)
parser.add_argument('--billing-account', required=True)
args = parser.parse_args()
project = 'femlab-app-staging' if args.environment == 'staging' else 'femlab-app'

def gcloud(*arguments, allow_missing=False):
    result = subprocess.run(['gcloud', *arguments, f'--project={project}', f'--account={args.account}', '--quiet'], text=True, capture_output=True)
    if result.returncode and not allow_missing:
        raise RuntimeError('gcloud operation failed: ' + arguments[0])
    return result

if gcloud('projects', 'describe', project, allow_missing=True).returncode:
    gcloud('projects', 'create', project, '--name=FEM Lab' + (' staging' if args.environment == 'staging' else ''))
gcloud('billing', 'projects', 'link', project, f'--billing-account={args.billing_account}')
services = ['firebase', 'identitytoolkit', 'run', 'sqladmin', 'secretmanager', 'artifactregistry', 'cloudbuild', 'cloudscheduler', 'compute', 'storage', 'billingbudgets', 'iamcredentials']
gcloud('services', 'enable', *(service + '.googleapis.com' for service in services))
subprocess.run(['firebase', 'projects:addfirebase', project, f'--account={args.account}', '--non-interactive'], text=True, capture_output=True)

token = gcloud('auth', 'print-access-token').stdout.strip()
headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'x-goog-user-project': project}
def request(url, body=None, method='GET'):
    data = None if body is None else json.dumps(body).encode()
    return json.load(urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers, method=method)))

base = 'https://identitytoolkit.googleapis.com'
try:
    request(f'{base}/admin/v2/projects/{project}/config')
except urllib.error.HTTPError as error:
    if error.code != 404:
        raise
    request(f'{base}/v2/projects/{project}/identityPlatform:initializeAuth', {}, 'POST')
domains = [project + '.firebaseapp.com', project + '.web.app']
domains += ['localhost'] if args.environment == 'staging' else ['femlab.app', 'www.femlab.app']
request(f'{base}/admin/v2/projects/{project}/config?updateMask=signIn.email,signIn.anonymous,signIn.phoneNumber,authorizedDomains,client.permissions.disabledUserDeletion', {
    'signIn': {'email': {'enabled': True, 'passwordRequired': False}, 'anonymous': {'enabled': False}, 'phoneNumber': {'enabled': False}},
    'authorizedDomains': domains,
    'client': {'permissions': {'disabledUserDeletion': True}},
}, 'PATCH')
print(project + ': billing, APIs and email-link Auth configured. Google OAuth requires its web client configuration.')
