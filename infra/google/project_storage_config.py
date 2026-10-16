"""The reviewed private project-object boundary shared by provision and release commands."""
import json

PERMISSIONS = {'storage.objects.create', 'storage.objects.get', 'storage.objects.delete'}
ROLE_ID = 'femlabProjectObjects'
GLOBAL_BYTES = '100000000000'


def members(project):
    return {f'serviceAccount:femlab-{identity}@{project}.iam.gserviceaccount.com' for identity in ['api', 'jobs']}


def role_name(project):
    return f'projects/{project}/roles/{ROLE_ID}'


def validate_bucket(metadata, project, project_number):
    iam = metadata.get('iamConfiguration', {})
    if (metadata.get('name') != project + '-projects' or str(metadata.get('projectNumber')) != project_number
            or metadata.get('location') != 'EUROPE-WEST3' or metadata.get('locationType') != 'region'
            or metadata.get('storageClass') != 'STANDARD'
            or iam.get('uniformBucketLevelAccess', {}).get('enabled') is not True
            or iam.get('publicAccessPrevention') != 'enforced'
            or metadata.get('softDeletePolicy', {}).get('retentionDurationSeconds') not in [0, '0']
            or metadata.get('versioning', {}).get('enabled', False)
            or metadata.get('lifecycle', {}).get('rule') or metadata.get('retentionPolicy')
            or metadata.get('cors') or metadata.get('defaultEventBasedHold')
            or metadata.get('hierarchicalNamespace', {}).get('enabled')
            or metadata.get('autoclass', {}).get('enabled')):
        raise RuntimeError('Project bucket configuration is unexpected; review it before changing IAM or retention.')


def validate_policy(bindings, project, *, require_members=False):
    expected = members(project)
    role = role_name(project)
    granted = set()
    for binding in bindings:
        principals = set(binding.get('members', []))
        if principals & {'allUsers', 'allAuthenticatedUsers'}:
            raise RuntimeError('Project bucket has a public IAM binding; review it before proceeding.')
        if principals & expected and (binding.get('role') != role or binding.get('condition')):
            raise RuntimeError('Runtime has an unexpected project-bucket IAM binding; review it before proceeding.')
        if binding.get('role') == role:
            if principals - expected or binding.get('condition'):
                raise RuntimeError('Project object role has unexpected members or conditions.')
            granted |= principals
    if require_members and granted != expected:
        raise RuntimeError('Project runtime object permissions did not match the intended identities.')


def validate_role(config):
    if set(config.get('includedPermissions', [])) != PERMISSIONS or config.get('deleted') or config.get('stage') != 'GA':
        raise RuntimeError('Project object role differs from the reviewed three-permission contract.')


def release_config(project, run):
    """Read safety metadata as the operator; runtimes receive no bucket-administration role."""
    project_number = run('projects', 'describe', project, '--format=value(projectNumber)').stdout.strip()
    if not project_number.isdigit():
        raise RuntimeError('Cannot verify the selected Google project number.')
    bucket = 'gs://' + project + '-projects'
    metadata = json.loads(run('storage', 'buckets', 'describe', bucket, '--raw', '--format=json').stdout)
    validate_bucket(metadata, project, project_number)
    validate_role(json.loads(run('iam', 'roles', 'describe', ROLE_ID, '--format=json').stdout))
    policy = json.loads(run('storage', 'buckets', 'get-iam-policy', bucket, '--format=json').stdout)
    validate_policy(policy.get('bindings', []), project, require_members=True)
    return {'PROJECT_BUCKET': project + '-projects', 'PROJECT_STORAGE_GLOBAL_BYTES': GLOBAL_BYTES}
