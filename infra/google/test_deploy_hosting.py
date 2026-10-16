"""Release smoke checks without Google credentials or network access."""
import contextlib
import io
import json
from pathlib import Path
import runpy
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch


class HostingReleaseSmoke(unittest.TestCase):
    def test_app_entry_and_docs_html_revalidate_without_weakening_other_headers(self):
        for environment in ['production', 'staging']:
            config = json.loads(Path(__file__).with_name(f'hosting.{environment}.json').read_text())['hosting']
            headers = {rule['source']: {item['key']: item['value'] for item in rule['headers']} for rule in config['headers']}
            for path in ['/', '/index.html', '/fem-lab', '/fem-lab/', '/fem-lab/index.html', '/docs/**']:
                with self.subTest(environment=environment, path=path):
                    self.assertIn(path, headers)
                    self.assertEqual(headers[path], {'Cache-Control': 'no-cache'})
            self.assertEqual(headers['/assets/**'], {'Cache-Control': 'public,max-age=31536000,immutable'})
            self.assertEqual(headers['**'], {'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless'})
            self.assertEqual(headers['/signin.html'], {'Cross-Origin-Embedder-Policy': 'unsafe-none', 'Cache-Control': 'no-store'})
            self.assertNotIn('redirects', config)
            self.assertEqual(config['rewrites'], [{'source': '**', 'destination': '/index.html'}])

    def test_only_signin_document_leaves_engine_isolation_in_both_environments(self):
        for environment in ['production', 'staging']:
            with self.subTest(environment=environment):
                config = json.loads(Path(__file__).with_name(f'hosting.{environment}.json').read_text())['hosting']
                rules = config['headers']
                global_headers = {h['key']: h['value'] for r in rules if r['source'] == '**' for h in r['headers']}
                self.assertEqual(global_headers['Cross-Origin-Opener-Policy'], 'same-origin')
                self.assertEqual(global_headers['Cross-Origin-Embedder-Policy'], 'credentialless')
                exceptions = [r for r in rules if any(h['key'] == 'Cross-Origin-Embedder-Policy' and h['value'] != 'credentialless' for h in r['headers'])]
                self.assertEqual(len(exceptions), 1)
                self.assertEqual(exceptions[0]['source'], '/signin.html')
                self.assertEqual({h['key']: h['value'] for h in exceptions[0]['headers']}, {'Cross-Origin-Embedder-Policy': 'unsafe-none', 'Cache-Control': 'no-store'})
                self.assertGreater(rules.index(exceptions[0]), next(i for i, rule in enumerate(rules) if rule['source'] == '**'))

    def release(self, *, custom=False, other_source=False, hosted_project='femlab-app', readiness='ready', google=False, provider=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            infra = root / 'infra/google'
            infra.mkdir(parents=True)
            script = infra / 'deploy-hosting.py'
            shutil.copyfile(Path(__file__).with_name('deploy-hosting.py'), script)
            (infra / 'firebase.production.json').write_text(json.dumps({
                'projectId': 'femlab-app', 'appId': 'app-production', 'authDomain': 'femlab-app.web.app',
            }))
            (infra / 'hosting.production.json').write_text(json.dumps({'hosting': {'public': 'packages/app/dist'}}))
            source = root / 'checkout' if other_source else root
            commands = []
            environments = []

            def output(command, **kwargs):
                if command[:2] == ['gcloud', 'auth']: return 'test-access-token'
                return 'https://direct-api.example.test' if command[0] == 'gcloud' else 'source-commit'

            def execute(command, **kwargs):
                commands.append(command)
                if command[0] == 'npm':
                    environments.append(kwargs['env'])
                    dist = Path(kwargs['cwd']) / 'packages/app/dist'
                    dist.mkdir(parents=True)
                    (dist / 'index.html').write_text('compiled artifact')
                return subprocess.CompletedProcess(command, 0)

            def response(url, **kwargs):
                if hasattr(url, 'full_url'):
                    self.assertEqual(url.full_url, 'https://identitytoolkit.googleapis.com/admin/v2/projects/femlab-app/defaultSupportedIdpConfigs/google.com?fields=enabled,clientId')
                    return io.BytesIO(json.dumps(provider or {}).encode())
                if url == 'https://femlab.app/__/firebase/init.json':
                    return io.BytesIO(json.dumps({'projectId': hosted_project, 'appId': 'app-production'}).encode())
                if url == 'https://api.femlab.app/ready':
                    return io.BytesIO(json.dumps({'status': readiness}).encode())
                raise AssertionError('Unexpected network destination: ' + url)

            argv = [str(script), '--environment', 'production', '--account', 'selected-account', '--source', str(source), '--build-only']
            if custom: argv.append('--custom-domain')
            if google: argv.append('--google-sign-in')
            with patch('sys.argv', argv), patch('subprocess.check_output', output), patch('subprocess.run', execute), patch('urllib.request.urlopen', response), contextlib.redirect_stdout(io.StringIO()) as stdout:
                try:
                    runpy.run_path(str(script), run_name='__main__')
                except RuntimeError:
                    self.assertEqual(commands, [])
                    raise
            self.assertEqual((root / 'packages/app/dist/index.html').read_text(), 'compiled artifact')
            self.assertFalse(any(command[0] == 'firebase' for command in commands))
            self.assertEqual(list(root.glob('firebase-*.json')), [])
            manifest = json.loads(stdout.getvalue())
            self.assertEqual(manifest['billing'], 'runtime-controlled')
            return manifest, environments[0]

    def test_build_in_script_checkout_preserves_artifact(self):
        manifest, environment = self.release()
        self.assertFalse(manifest['published'])
        self.assertEqual(manifest['apiOrigin'], 'https://direct-api.example.test')
        self.assertEqual(json.loads(environment['FEMLAB_FIREBASE_CONFIG'])['authDomain'], 'femlab-app.web.app')

    def test_build_from_other_checkout_copies_artifact(self):
        self.release(other_source=True)

    def test_custom_domain_uses_same_origin_auth_and_custom_api(self):
        manifest, environment = self.release(custom=True)
        self.assertEqual(manifest['url'], 'https://femlab.app')
        self.assertEqual(environment['FEMLAB_AI_API_ORIGIN'], 'https://api.femlab.app')
        self.assertEqual(json.loads(environment['FEMLAB_FIREBASE_CONFIG'])['authDomain'], 'femlab.app')
        self.assertEqual(environment['FEMLAB_GOOGLE_SIGN_IN'], 'false')

    def test_wrong_domain_project_cannot_build_or_publish(self):
        with self.assertRaisesRegex(RuntimeError, 'unexpected Firebase'):
            self.release(custom=True, hosted_project='some-other-project')

    def test_unready_custom_api_cannot_build_or_publish(self):
        with self.assertRaisesRegex(RuntimeError, 'not ready'):
            self.release(custom=True, readiness='unavailable')

    def test_google_button_requires_enabled_provider_and_client(self):
        for provider in [{'enabled': False, 'clientId': 'public-id'}, {'enabled': True}]:
            with self.subTest(provider=provider), self.assertRaisesRegex(RuntimeError, 'enabled Google provider'):
                self.release(google=True, provider=provider)

    def test_google_button_can_be_enabled_without_embedding_oauth_credentials(self):
        manifest, environment = self.release(google=True, provider={'enabled': True, 'clientId': 'public-id'})
        self.assertEqual(manifest['googleLogin'], 'enabled')
        self.assertEqual(environment['FEMLAB_GOOGLE_SIGN_IN'], 'true')
        self.assertNotIn('test-access-token', json.dumps(manifest) + environment['FEMLAB_FIREBASE_CONFIG'])
        self.assertNotIn('public-id', environment['FEMLAB_FIREBASE_CONFIG'])


if __name__ == '__main__':
    unittest.main()
