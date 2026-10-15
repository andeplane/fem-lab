"""Exercise migration environment selection and the staging admission reset boundary."""
import contextlib
import io
import os
from pathlib import Path
import runpy
import subprocess
import unittest
from unittest.mock import patch


class MigrationSafety(unittest.TestCase):
    def migrate(self, environment, *, pause_fails=False):
        script = Path(__file__).with_name('migrate.py')
        calls = []

        def execute(command, **kwargs):
            calls.append((command, kwargs))
            if pause_fails and command[-1].endswith('sql-staging-ai-paused.sql'):
                raise subprocess.CalledProcessError(1, command)
            return subprocess.CompletedProcess(command, 0)

        arguments = [str(script), '--environment', environment, '--account', 'selected-owner',
                     '--port', '16469', '--source', '/committed-source']
        with patch('sys.argv', arguments), patch.dict(os.environ, {'GOOGLE_APPLICATION_CREDENTIALS': '/unrelated-credentials'}), \
                patch('subprocess.check_output', return_value='private-test-password') as secret, \
                patch('subprocess.run', execute), contextlib.redirect_stdout(io.StringIO()) as output:
            try:
                runpy.run_path(str(script), run_name='__main__')
            except subprocess.CalledProcessError:
                self.assertTrue(pause_fails)
        self.assertNotIn('private-test-password', output.getvalue())
        return calls, secret.call_args.args[0]

    def test_staging_pauses_even_with_no_new_schema_before_granting_runtime_access(self):
        calls, secret = self.migrate('staging')
        self.assertEqual(calls[0][0], ['node', 'packages/service/dist/main.mjs', '--migrate'])
        self.assertEqual([Path(command[-1]).name for command, _ in calls[1:]],
                         ['sql-staging-ai-paused.sql', 'sql-runtime-grants.sql'])
        self.assertIn('--project=femlab-app-staging', secret)
        self.assertIn('--account=selected-owner', secret)
        for command, arguments in calls:
            self.assertNotIn('private-test-password', command)
            self.assertEqual(arguments['env']['FIREBASE_PROJECT_ID'], 'femlab-app-staging')
            self.assertEqual(arguments['env']['PGPORT'], '16469')
            self.assertNotIn('GOOGLE_APPLICATION_CREDENTIALS', arguments['env'])
            self.assertTrue(arguments['check'])

    def test_production_does_not_reset_operator_spend_policy(self):
        calls, secret = self.migrate('production')
        self.assertEqual(len(calls), 2)
        self.assertEqual(Path(calls[1][0][-1]).name, 'sql-runtime-grants.sql')
        self.assertIn('--project=femlab-app', secret)
        self.assertEqual(calls[1][1]['env']['FIREBASE_PROJECT_ID'], 'femlab-app')

    def test_failed_staging_pause_stops_before_runtime_grants(self):
        calls, _ = self.migrate('staging', pause_fails=True)
        self.assertEqual(len(calls), 2)
        self.assertEqual(Path(calls[-1][0][-1]).name, 'sql-staging-ai-paused.sql')


if __name__ == '__main__':
    unittest.main()
