"""Exercise release orchestration against fake cloud boundaries, never real services."""
import contextlib
import io
import json
import runpy
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch


class ReleaseBillingTests(unittest.TestCase):
    def test_api_and_recovery_receive_same_pinned_billing_config(self):
        for merchant_mode, tax_mode in (('direct', 'not_collecting'), ('managed', 'automatic')):
            with self.subTest(merchant_mode=merchant_mode):
                self.assert_billing_release(merchant_mode, tax_mode)

    def assert_billing_release(self, merchant_mode, tax_mode):
        calls = []
        resolved = []
        output = {}
        manifest = {'buildId': 'abc12345-0000', 'image': 'europe-west3-docker.pkg.dev/femlab-app/femlab/service:commit', 'revision': 'commit'}
        binding = {'env': {'BILLING_ENABLED': 'true', 'BILLING_MODE': 'live',
                           'BILLING_TAX_MODE': tax_mode, 'BILLING_MERCHANT_MODE': merchant_mode,
                           'STRIPE_PRICE_PLUS': 'price_plus', 'STRIPE_PRICE_PRO': 'price_pro',
                           'STRIPE_PRICE_STUDIO': 'price_studio', 'STRIPE_PORTAL_CONFIGURATION': 'bpc_portal'},
                   'secrets': {'STRIPE_SECRET_KEY': 'stripe-api-key:8', 'STRIPE_WEBHOOK_SECRET': 'stripe-webhook-secret:7'},
                   'mode': 'live'}

        def resolve(*args):
            resolved.append(args)
            return binding

        def run(argv, **kwargs):
            calls.append(argv)
            body = ''
            if argv[1:3] == ['builds', 'describe']:
                body = 'SUCCESS'
            elif argv[1:5] == ['artifacts', 'docker', 'images', 'describe']:
                body = json.dumps({'image_summary': {'digest': 'sha256:immutable'}})
            elif argv[1:4] == ['secrets', 'versions', 'list']:
                body = '1'
            elif argv[1:4] == ['run', 'revisions', 'describe']:
                body = json.dumps({'spec': {'containers': [{'env': [{'name': 'BILLING_ENABLED', 'value': 'true'}]}]}})
            elif argv[1:5] == ['run', 'services', 'describe', 'femlab-api']:
                deploys = [call for call in calls if call[1:3] == ['run', 'deploy']]
                if not deploys:
                    # A failed disabled candidate can remain in the template after rollback;
                    # preservation must follow the revision actually receiving traffic.
                    body = json.dumps({'spec': {'template': {'spec': {'containers': [{'env': [{'name': 'BILLING_ENABLED', 'value': 'false'}]}]}}},
                                       'status': {'url': 'https://api.example.test', 'traffic': [{'revisionName': 'previous', 'percent': 100}]}})
                else:
                    suffix = next(value.split('=', 1)[1] for value in deploys[-1] if value.startswith('--revision-suffix='))
                    body = json.dumps({'status': {'url': 'https://api.example.test', 'traffic': [{'revisionName': 'femlab-api-' + suffix, 'tag': 'release-candidate', 'url': 'https://candidate.example.test'}]}})
            return SimpleNamespace(returncode=0, stdout=body, stderr='')

        original_read = Path.read_text

        def read(path, *args, **kwargs):
            return json.dumps(manifest) if str(path).endswith('-build-563.json') else original_read(path, *args, **kwargs)

        def write(path, data, **kwargs):
            output[str(path)] = data
            return len(data)

        response = MagicMock()
        response.__enter__.return_value.status = 200
        module = SimpleNamespace(resolve=resolve)
        entry = Path(__file__).parents[1] / 'google' / 'release-service.py'
        with patch.dict('sys.modules', {'billing_config': module}), patch('sys.argv', [str(entry), '--environment', 'production', '--account', 'andershaf@gmail.com']), \
                patch('subprocess.run', run), patch('urllib.request.urlopen', return_value=response), \
                patch.object(Path, 'read_text', read), patch.object(Path, 'write_text', write), contextlib.redirect_stdout(io.StringIO()):
            runpy.run_path(str(entry), run_name='__main__')
        self.assertEqual(resolved[0][0:2], ('production', 'femlab-app'))
        self.assertEqual(resolved[0][3:], (True, 'preserve'))
        api = next(call for call in calls if call[1:3] == ['run', 'deploy'])
        jobs = next(call for call in calls if call[1:4] == ['run', 'jobs', 'deploy'])
        for command in (api, jobs):
            env = next(value for value in command if value.startswith('--set-env-vars='))
            secrets = next(value for value in command if value.startswith('--set-secrets='))
            self.assertIn('APP_RETURN_ORIGIN=https://femlab.app', env)
            for name, value in binding['env'].items():
                self.assertIn(name + '=' + value, env)
            for name, value in binding['secrets'].items():
                self.assertIn(name + '=' + value, secrets)
        self.assertIn('PGPASSWORD=database-api-password:1', ' '.join(api))
        self.assertIn('PGPASSWORD=database-jobs-password:1', ' '.join(jobs))
        self.assertNotIn('OPENAI_API_KEY', ' '.join(jobs))
        release = json.loads(next(iter(output.values())))
        self.assertTrue(release['apiRevision'].startswith('femlab-api-rabc12345-'))
        self.assertEqual(release['rollbackRevisions'], {'previous': 100})


if __name__ == '__main__':
    unittest.main()
