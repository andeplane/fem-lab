"""Keep the diagnostic's aggregate status honest even when its first control fails."""
import contextlib
import io
from pathlib import Path
import runpy
import subprocess
import unittest
from unittest import mock


class RunnerTests(unittest.TestCase):
    def run_controls(self, effects):
        output = io.StringIO()
        script = str(Path(__file__).with_name('run.py'))
        args = [script, '--baseline', '.', '--cli', './baseline-cli', '--replay', './matrix-replay']
        with mock.patch('sys.argv', args), mock.patch('subprocess.run', side_effect=effects) as run, contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as stopped:
                runpy.run_path(script, run_name='__main__')
        return stopped.exception.code, run, output.getvalue()

    def test_all_six_successes_are_required(self):
        code, run, output = self.run_controls([subprocess.CompletedProcess([], 0) for _ in range(6)])
        self.assertEqual(code, 0)
        self.assertEqual(run.call_count, 6)
        self.assertIn('baseline-direct-default', output)
        self.assertIn('captured-matrix-rayon4', output)
        self.assertNotIn('--threads', run.call_args_list[0].args[0])
        self.assertEqual(run.call_args_list[1].args[0][-2:], ['--threads', '1'])
        self.assertEqual(run.call_args_list[2].args[0][-2:], ['--threads', '4'])
        self.assertEqual([call.args[0][-1] for call in run.call_args_list[3:]], ['seq', 'rayon1', 'rayon4'])

    def test_failure_does_not_skip_remaining_controls_or_report_success(self):
        code, run, output = self.run_controls([subprocess.CompletedProcess([], 1)] + [subprocess.CompletedProcess([], 0) for _ in range(5)])
        self.assertEqual(code, 1)
        self.assertEqual(run.call_count, 6)
        self.assertIn('baseline-direct-default: exit_code=1', output)
        self.assertIn('captured-matrix-rayon4: exit_code=0', output)

    def test_timeout_does_not_skip_remaining_controls_or_report_success(self):
        code, run, output = self.run_controls([subprocess.TimeoutExpired('baseline-cli', 1200)] + [subprocess.CompletedProcess([], 0) for _ in range(5)])
        self.assertEqual(code, 1)
        self.assertEqual(run.call_count, 6)
        self.assertIn('baseline-direct-default: exit_code=124', output)

    def test_rejects_a_changed_fixture_before_running_controls(self):
        with mock.patch.object(Path, 'read_bytes', return_value=b'changed fixture'):
            with self.assertRaises(AssertionError):
                self.run_controls([])


if __name__ == '__main__':
    unittest.main()
