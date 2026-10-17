#!/usr/bin/env python3
"""Provision private durable project objects without touching disposable exports or secrets."""
import argparse
import json
import re
import subprocess
import time
from project_storage_config import PERMISSIONS, ROLE_ID, members as runtime_members, role_name, validate_bucket, validate_policy, validate_role


parser = argparse.ArgumentParser()
parser.add_argument('--environment', choices=['staging', 'production'], required=True)
parser.add_argument('--account', required=True)
args = parser.parse_args()
project = 'femlab-app-staging' if args.environment == 'staging' else 'femlab-app'
bucket_name = project + '-projects'
bucket = 'gs://' + bucket_name
permissions = sorted(PERMISSIONS)
role_id = ROLE_ID
role = role_name(project)
members = runtime_members(project)


def run(*arguments, allow_missing=False, attempts=1):
    for attempt in range(attempts):
        result = subprocess.run(['gcloud', *arguments, f'--project={project}', f'--account={args.account}', '--quiet'], capture_output=True, text=True)
        if not result.returncode or attempt == attempts - 1:
            break
        time.sleep(5)
    if result.returncode:
        missing = re.search(r'\b404\b|\bNOT_FOUND\b', result.stderr)
        if not allow_missing or not missing:
            raise RuntimeError('Google project-storage operation failed: ' + ' '.join(arguments[:3]))
    return result


project_number = run('projects', 'describe', project, '--format=value(projectNumber)').stdout.strip()
if not project_number.isdigit():
    raise RuntimeError('Cannot verify the selected Google project number.')
described = run('storage', 'buckets', 'describe', bucket, '--raw', '--format=json', allow_missing=True)
if described.returncode:
    run('storage', 'buckets', 'create', bucket, '--location=europe-west3', '--default-storage-class=STANDARD',
        '--uniform-bucket-level-access', '--public-access-prevention', '--soft-delete-duration=0')
    described = run('storage', 'buckets', 'describe', bucket, '--raw', '--format=json')
metadata = json.loads(described.stdout)
validate_bucket(metadata, project, project_number)


def policy(*, require_members=False):
    bindings = json.loads(run('storage', 'buckets', 'get-iam-policy', bucket, '--format=json').stdout).get('bindings', [])
    validate_policy(bindings, project, require_members=require_members)
    return bindings


policy()
existing_role = run('iam', 'roles', 'describe', role_id, '--format=json', allow_missing=True)
if existing_role.returncode:
    run('iam', 'roles', 'create', role_id, '--title=FEM Lab private project objects',
        '--permissions=' + ','.join(permissions), '--stage=GA')
    existing_role = run('iam', 'roles', 'describe', role_id, '--format=json')
validate_role(json.loads(existing_role.stdout))
for member in sorted(members):
    # A freshly created custom role can take time to reach the bucket IAM service.
    # Retry only this idempotent binding, keeping the reviewed identity and role fixed.
    run('storage', 'buckets', 'add-iam-policy-binding', bucket, '--member=' + member, '--role=' + role, '--condition=None', attempts=3)
policy(require_members=True)
print(json.dumps({'project': project, 'bucket': bucket_name, 'location': metadata['location'], 'storageClass': metadata['storageClass'],
                  'private': True, 'softDeleteSeconds': 0, 'lifecycleRules': 0, 'versioning': False,
                  'runtimeRole': role, 'permissions': permissions, 'members': sorted(members)}))
