"""Exercise private project-bucket provisioning against fake Google boundaries."""
import contextlib
import copy
import io
import json
from pathlib import Path
import runpy
import subprocess
import unittest
from unittest.mock import patch
from project_storage_config import release_config


class ProjectStorageProvisioning(unittest.TestCase):
    def provision(self, *, environment='production', missing=False, metadata_patch=None,
                  policy_binding=None, role_permissions=None, describe_error=None, binding_failures=0):
        project = 'femlab-app-staging' if environment == 'staging' else 'femlab-app'
        bucket = f'gs://{project}-projects'
        role = f'projects/{project}/roles/femlabProjectObjects'
        number = '772080656490' if environment == 'staging' else '999163219889'
        permissions = ['storage.objects.create', 'storage.objects.get', 'storage.objects.delete']
        metadata = {'name': project + '-projects', 'projectNumber': number,
                    'location': 'EUROPE-WEST3', 'locationType': 'region', 'storageClass': 'STANDARD',
                    'iamConfiguration': {'uniformBucketLevelAccess': {'enabled': True}, 'publicAccessPrevention': 'enforced'},
                    'softDeletePolicy': {'retentionDurationSeconds': '0'}}
        metadata.update(metadata_patch or {})
        bindings = [] if policy_binding is None else [copy.deepcopy(policy_binding)]
        calls = []
        created = not missing
        role_created = not missing

        def execute(command, **kwargs):
            nonlocal created, role_created, binding_failures
            calls.append(command)
            self.assertIn('--project=' + project, command)
            self.assertIn('--account=selected-owner', command)
            self.assertIn('--quiet', command)
            arguments = command[1:]
            if arguments[:3] == ['projects', 'describe', project]:
                return subprocess.CompletedProcess(command, 0, number, '')
            if arguments[:3] == ['storage', 'buckets', 'describe']:
                self.assertIn(bucket, arguments)
                self.assertIn('--raw', arguments)
                if describe_error:
                    return subprocess.CompletedProcess(command, 1, '', describe_error)
                if not created:
                    return subprocess.CompletedProcess(command, 1, '', 'HTTPError 404: missing')
                return subprocess.CompletedProcess(command, 0, json.dumps(metadata), '')
            if arguments[:3] == ['storage', 'buckets', 'create']:
                self.assertFalse(created)
                created = True
                return subprocess.CompletedProcess(command, 0, '', '')
            if arguments[:3] == ['storage', 'buckets', 'get-iam-policy']:
                return subprocess.CompletedProcess(command, 0, json.dumps({'bindings': bindings}), '')
            if arguments[:3] == ['iam', 'roles', 'describe']:
                if not role_created:
                    return subprocess.CompletedProcess(command, 1, '', 'NOT_FOUND: missing')
                return subprocess.CompletedProcess(command, 0, json.dumps({'stage': 'GA', 'includedPermissions': permissions if role_permissions is None else role_permissions}), '')
            if arguments[:3] == ['iam', 'roles', 'create']:
                self.assertFalse(role_created)
                role_created = True
                return subprocess.CompletedProcess(command, 0, '', '')
            if arguments[:3] == ['storage', 'buckets', 'add-iam-policy-binding']:
                if binding_failures:
                    binding_failures -= 1
                    return subprocess.CompletedProcess(command, 1, '', 'transient bucket IAM failure')
                member = next(value.removeprefix('--member=') for value in arguments if value.startswith('--member='))
                binding = next((value for value in bindings if value['role'] == role), None)
                if binding is None:
                    binding = {'role': role, 'members': []}
                    bindings.append(binding)
                if member not in binding['members']:
                    binding['members'].append(member)
                return subprocess.CompletedProcess(command, 0, '', '')
            raise AssertionError('Unexpected Google operation: ' + ' '.join(arguments[:3]))

        script = Path(__file__).with_name('project-storage.py')
        error = None
        with patch('sys.argv', [str(script), '--environment', environment, '--account', 'selected-owner']), \
                patch('subprocess.run', execute), patch('time.sleep'), contextlib.redirect_stdout(io.StringIO()) as output:
            try:
                runpy.run_path(str(script), run_name='__main__')
            except RuntimeError as caught:
                error = caught
        return calls, output.getvalue(), error

    def test_new_private_regional_bucket_has_no_export_expiry_or_extra_runtime_permissions(self):
        for environment in ['production', 'staging']:
            with self.subTest(environment=environment):
                calls, output, error = self.provision(environment=environment, missing=True)
                self.assertIsNone(error)
                create = next(command for command in calls if command[1:4] == ['storage', 'buckets', 'create'])
                for flag in ['--location=europe-west3', '--default-storage-class=STANDARD', '--uniform-bucket-level-access', '--public-access-prevention', '--soft-delete-duration=0']:
                    self.assertIn(flag, create)
                self.assertFalse(any('lifecycle' in item or 'exports' in item or 'secret' in item for command in calls for item in command))
                grants = [command for command in calls if command[1:4] == ['storage', 'buckets', 'add-iam-policy-binding']]
                self.assertEqual(len(grants), 2)
                manifest = json.loads(output)
                self.assertEqual(set(manifest['permissions']), {'storage.objects.create', 'storage.objects.get', 'storage.objects.delete'})
                self.assertEqual({value for command in grants for value in command if value.startswith('--member=')}, {'--member=' + member for member in manifest['members']})
                self.assertTrue(all('--role=' + manifest['runtimeRole'] in command and '--condition=None' in command for command in grants))
                self.assertEqual(manifest['softDeleteSeconds'], 0)
                self.assertEqual(manifest['lifecycleRules'], 0)
                self.assertFalse(manifest['versioning'])

    def test_safe_existing_bucket_is_not_recreated_or_reconfigured(self):
        calls, output, error = self.provision()
        self.assertIsNone(error)
        self.assertTrue(json.loads(output)['private'])
        self.assertFalse(any(command[1:4] in [['storage', 'buckets', 'create'], ['storage', 'buckets', 'update'], ['iam', 'roles', 'create']] for command in calls))

    def test_transient_binding_retry_preserves_the_exact_role_and_principal(self):
        calls, output, error = self.provision(binding_failures=1)
        self.assertIsNone(error)
        self.assertTrue(json.loads(output)['private'])
        grants = [command for command in calls if command[1:4] == ['storage', 'buckets', 'add-iam-policy-binding']]
        self.assertEqual(len(grants), 3)
        self.assertEqual(grants[0], grants[1])

    def test_permanent_binding_failure_stops_after_three_identical_attempts(self):
        calls, output, error = self.provision(binding_failures=3)
        self.assertIsNotNone(error)
        self.assertEqual(output, '')
        grants = [command for command in calls if command[1:4] == ['storage', 'buckets', 'add-iam-policy-binding']]
        self.assertEqual(len(grants), 3)
        self.assertEqual(grants, [grants[0]] * 3)

    def test_missing_read_permission_or_network_failure_cannot_trigger_bucket_creation(self):
        for failure in ['HTTPError 403: bucket does not exist or access is denied', 'connection timeout']:
            with self.subTest(failure=failure):
                calls, output, error = self.provision(describe_error=failure)
                self.assertIsNotNone(error)
                self.assertEqual(output, '')
                self.assertFalse(any(command[1:4] == ['storage', 'buckets', 'create'] for command in calls))

    def test_unexpected_bucket_policy_cannot_be_silently_changed_or_granted(self):
        changes = [
            {'name': 'femlab-app-exports'}, {'projectNumber': 'another-project'}, {'location': 'US'}, {'storageClass': 'NEARLINE'},
            {'iamConfiguration': {'uniformBucketLevelAccess': {'enabled': False}, 'publicAccessPrevention': 'enforced'}},
            {'iamConfiguration': {'uniformBucketLevelAccess': {'enabled': True}, 'publicAccessPrevention': 'inherited'}},
            {'softDeletePolicy': {}}, {'softDeletePolicy': {'retentionDurationSeconds': '604800'}}, {'versioning': {'enabled': True}},
            {'lifecycle': {'rule': [{'action': {'type': 'Delete'}, 'condition': {'age': 1}}]}},
            {'retentionPolicy': {'retentionPeriod': '86400'}}, {'cors': [{'origin': ['*']}]},
            {'defaultEventBasedHold': True}, {'autoclass': {'enabled': True}}, {'hierarchicalNamespace': {'enabled': True}},
        ]
        for change in changes:
            with self.subTest(change=change):
                calls, output, error = self.provision(metadata_patch=change)
                self.assertIsNotNone(error)
                self.assertEqual(output, '')
                self.assertFalse(any(command[1:4] in [['storage', 'buckets', 'add-iam-policy-binding'], ['storage', 'buckets', 'update'], ['iam', 'roles', 'create']] for command in calls))

    def test_public_extra_runtime_or_unowned_role_bindings_fail_closed(self):
        api = 'serviceAccount:femlab-api@femlab-app.iam.gserviceaccount.com'
        role = 'projects/femlab-app/roles/femlabProjectObjects'
        for binding in [
            {'role': 'roles/storage.objectViewer', 'members': ['allUsers']},
            {'role': 'roles/storage.objectViewer', 'members': ['allAuthenticatedUsers']},
            {'role': 'roles/storage.objectAdmin', 'members': [api]},
            {'role': role, 'members': [api], 'condition': {'expression': 'true'}},
            {'role': role, 'members': ['serviceAccount:unrelated@example.test']},
        ]:
            with self.subTest(binding=binding):
                calls, output, error = self.provision(policy_binding=binding)
                self.assertIsNotNone(error)
                self.assertEqual(output, '')
                self.assertFalse(any(command[1:4] == ['storage', 'buckets', 'add-iam-policy-binding'] for command in calls))

    def test_existing_custom_role_cannot_expand_runtime_access(self):
        calls, output, error = self.provision(role_permissions=['storage.objects.create', 'storage.objects.get', 'storage.objects.delete', 'storage.objects.list'])
        self.assertIsNotNone(error)
        self.assertEqual(output, '')
        self.assertFalse(any(command[1:4] == ['storage', 'buckets', 'add-iam-policy-binding'] for command in calls))

    def test_release_checks_are_read_only_and_return_separate_environment_buckets(self):
        for project in ['femlab-app', 'femlab-app-staging']:
            with self.subTest(project=project):
                calls = []

                def run(*arguments):
                    calls.append(arguments)
                    if arguments[:2] == ('projects', 'describe'):
                        body = '12345'
                    elif arguments[:3] == ('storage', 'buckets', 'describe'):
                        body = json.dumps({'name': project + '-projects', 'projectNumber': '12345',
                                           'location': 'EUROPE-WEST3', 'locationType': 'region', 'storageClass': 'STANDARD',
                                           'iamConfiguration': {'uniformBucketLevelAccess': {'enabled': True}, 'publicAccessPrevention': 'enforced'},
                                           'softDeletePolicy': {'retentionDurationSeconds': 0}})
                    elif arguments[:3] == ('iam', 'roles', 'describe'):
                        body = json.dumps({'stage': 'GA', 'includedPermissions': ['storage.objects.create', 'storage.objects.get', 'storage.objects.delete']})
                    elif arguments[:3] == ('storage', 'buckets', 'get-iam-policy'):
                        body = json.dumps({'bindings': [{'role': f'projects/{project}/roles/femlabProjectObjects', 'members': [
                            f'serviceAccount:femlab-api@{project}.iam.gserviceaccount.com', f'serviceAccount:femlab-jobs@{project}.iam.gserviceaccount.com']}]})
                    else:
                        raise AssertionError('Release preflight attempted a mutation.')
                    return subprocess.CompletedProcess(arguments, 0, body, '')

                self.assertEqual(release_config(project, run), {'PROJECT_BUCKET': project + '-projects', 'PROJECT_STORAGE_GLOBAL_BYTES': '100000000000'})
                self.assertEqual(len(calls), 4)

    def test_release_rejects_missing_recovery_identity_before_returning_configuration(self):
        def run(*arguments):
            if arguments[:2] == ('projects', 'describe'):
                body = '12345'
            elif arguments[:3] == ('storage', 'buckets', 'describe'):
                body = json.dumps({'name': 'femlab-app-projects', 'projectNumber': '12345',
                                   'location': 'EUROPE-WEST3', 'locationType': 'region', 'storageClass': 'STANDARD',
                                   'iamConfiguration': {'uniformBucketLevelAccess': {'enabled': True}, 'publicAccessPrevention': 'enforced'},
                                   'softDeletePolicy': {'retentionDurationSeconds': '0'}})
            elif arguments[:3] == ('iam', 'roles', 'describe'):
                body = json.dumps({'stage': 'GA', 'includedPermissions': ['storage.objects.create', 'storage.objects.get', 'storage.objects.delete']})
            elif arguments[:3] == ('storage', 'buckets', 'get-iam-policy'):
                body = json.dumps({'bindings': [{'role': 'projects/femlab-app/roles/femlabProjectObjects', 'members': ['serviceAccount:femlab-api@femlab-app.iam.gserviceaccount.com']}]})
            else:
                raise AssertionError('Release preflight attempted a mutation.')
            return subprocess.CompletedProcess(arguments, 0, body, '')

        with self.assertRaisesRegex(RuntimeError, 'intended identities'):
            release_config('femlab-app', run)


if __name__ == '__main__':
    unittest.main()
