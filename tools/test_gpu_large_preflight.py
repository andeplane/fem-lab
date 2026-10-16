"""Pure guard tests only: no process, real cgroup, Vulkan or engine is invoked."""

import copy
import errno
import importlib.util
from pathlib import Path
import signal
import sys
import unittest


spec = importlib.util.spec_from_file_location('gpu_large_preflight', Path(__file__).with_name('gpu-large-preflight.py'))
probe = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = probe
spec.loader.exec_module(probe)


class FakeChild:
    pid = 42

    def __init__(self, host):
        self.host = host
        self.running = True
        self.member = host.member
        self.stopped = False

    def hello(self):
        return {'pid': self.pid + int(self.host.bad_pid), 'pgid': self.pid, 'member': self.member}

    def confirm(self):
        self.host.events.append('confirm')
        if self.member != self.host.group.member:
            raise AssertionError('parent released an unassigned child')
        return {'pid': self.pid, 'pgid': self.pid,
                'member': self.member if not self.host.bad_confirmation else '/wrong'}

    def wait(self):
        if self.running:
            raise TimeoutError('child was not killed')
        return -signal.SIGKILL

    def stop(self):
        self.running = False
        self.stopped = True
        self.host.events.append('reap-owned')
        if self.host.stop_denied:
            raise RuntimeError('reap status unavailable')


class FakeGroup:
    member = '/job/owned'

    def __init__(self, host):
        self.host = host
        self.controls = {}
        self.removed = False
        self.closed = False

    def read(self, name):
        if name == 'cgroup.procs':
            ids = []
            if self.host.child and self.host.child.running and self.host.child.member == self.member:
                ids.append('42')
            if self.host.foreign_pid and self.host.child:
                ids.append('999')
            return '\n'.join(ids)
        if name == 'cgroup.events':
            return 'populated ' + str(int(bool(self.read('cgroup.procs')))) + '\nfrozen 0\n'
        if name == 'memory.max' and self.host.bad_limit:
            return str(probe.PROBE_BYTES + 1)
        return self.controls[name]

    def write(self, name, value):
        self.host.events.append((name, value))
        if name == 'cgroup.procs':
            self.host.child.member = self.member
        elif name == 'cgroup.kill':
            if self.host.kill_denied:
                raise PermissionError('kill unavailable')
            self.host.child.running = False
        else:
            self.controls[name] = value

    def remove(self):
        if self.host.remove_denied:
            raise PermissionError('remove unavailable')
        self.removed = True

    def close(self):
        self.closed = True
        if self.host.close_denied:
            raise OSError('descriptor cleanup unavailable')


class FakeBoundary:
    member = '/job'

    def __init__(self, **options):
        self.group = FakeGroup(self)
        self.child = None
        self.events = []
        for key in ['not_delegated', 'collision', 'bad_limit', 'bad_pid', 'foreign_pid',
                    'bad_confirmation', 'kill_denied', 'remove_denied', 'monitor_moved',
                    'stop_denied', 'close_denied']:
            setattr(self, key, options.get(key, False))

    def delegated(self):
        if self.not_delegated:
            raise probe.Unavailable('memory not already delegated')

    def current_member(self):
        if self.monitor_moved and self.child and self.child.member == self.group.member:
            return self.group.member
        return self.member

    def create(self):
        if self.collision:
            raise FileExistsError('existing directory is not ours')
        return self.group

    def spawn(self):
        self.events.append('spawn')
        self.child = FakeChild(self)
        return self.child

    def child_member(self, pid):
        if pid != 42:
            raise AssertionError('a claimed PID was used')
        return self.child.member


class PreflightGuards(unittest.TestCase):
    def test_only_explicit_manual_mode_is_allowed(self):
        for event in ['push', 'pull_request', 'workflow_call', '', 'workflow_dispatch']:
            for enabled in ['', 'false', '1', 'True', 'true']:
                self.assertEqual(probe.manual_mode(event, enabled),
                                 event == 'workflow_dispatch' and enabled == 'true')

    def test_membership_and_mount_mapping_reject_ambiguous_or_escaping_paths(self):
        self.assertEqual(probe.membership('0::/job\n'), '/job')
        self.assertEqual(probe.cgroup_parent('/job', '1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw'),
                         Path('/sys/fs/cgroup/job'))
        for text in ['1:memory:/job', '0::relative', '0::/../escape', '0::/./escape',
                     '0::/job\n0::/other', '0::/job\x00']:
            with self.subTest(text=text), self.assertRaises(probe.Forbidden):
                probe.membership(text)
        for text in ['', '1 0 0:1 /sub /sys/fs/cgroup rw - cgroup2 cgroup rw',
                     '1 0 0:1 / /sys/fs/cgroup\\040escape rw - cgroup2 cgroup rw']:
            with self.subTest(text=text), self.assertRaises(probe.Forbidden):
                probe.cgroup_parent('/job', text)

    def test_success_verifies_handshake_before_kill_and_never_admits_a_target(self):
        host = FakeBoundary()
        result = probe.containment(host)
        self.assertTrue(result['configuration_and_cleanup_verified'])
        self.assertEqual(result['status'], 'verified')
        self.assertTrue(result['target_forbidden'])
        self.assertEqual(host.group.controls,
                         {'memory.max': str(64 * 1024**2), 'memory.swap.max': '0', 'memory.oom.group': '1'})
        self.assertEqual(result['limit_readback_inside_child'], host.group.controls)
        self.assertLess(host.events.index(('cgroup.procs', '42')), host.events.index('confirm'))
        self.assertLess(host.events.index('confirm'), host.events.index(('cgroup.kill', '1')))
        self.assertTrue(host.child.stopped and host.group.removed and host.group.closed)

    def test_no_delegation_or_collision_never_touches_an_existing_group(self):
        for option in ['not_delegated', 'collision']:
            host = FakeBoundary(**{option: True})
            result = probe.containment(host)
            self.assertFalse(result['configuration_and_cleanup_verified'])
            self.assertTrue(result['target_forbidden'])
            self.assertEqual(host.events, [])
            self.assertFalse(host.group.removed or host.group.closed)
            self.assertEqual(result['status'], 'unavailable' if option == 'not_delegated' else 'failed')

    def test_bad_limit_fails_before_child_allocation(self):
        host = FakeBoundary(bad_limit=True)
        result = probe.containment(host)
        self.assertFalse(result['configuration_and_cleanup_verified'])
        self.assertIsNone(host.child)
        self.assertTrue(host.group.removed)

    def test_unverified_child_or_monitor_never_receives_scoped_kill(self):
        for option in ['bad_pid', 'foreign_pid', 'bad_confirmation', 'monitor_moved']:
            host = FakeBoundary(**{option: True})
            result = probe.containment(host)
            self.assertFalse(result['configuration_and_cleanup_verified'])
            self.assertTrue(result['target_forbidden'])
            self.assertNotIn(('cgroup.kill', '1'), host.events)
            self.assertTrue(host.child.stopped)
        self.assertFalse(host.group.read('cgroup.procs'))

    def test_foreign_membership_blocks_removal_and_never_signals_the_foreign_pid(self):
        host = FakeBoundary(foreign_pid=True)
        result = probe.containment(host)
        self.assertFalse(host.group.removed)
        self.assertTrue(any('cleanup' in e for e in result['errors']))
        self.assertNotIn(('cgroup.kill', '1'), host.events)
        self.assertTrue(host.child.stopped)

    def test_kill_and_cleanup_failures_keep_target_forbidden(self):
        for option in ['kill_denied', 'remove_denied', 'stop_denied', 'close_denied']:
            host = FakeBoundary(**{option: True})
            result = probe.containment(host)
            self.assertFalse(result['configuration_and_cleanup_verified'])
            self.assertTrue(result['target_forbidden'])
            self.assertTrue(host.child.stopped and host.group.closed)

    def test_populated_and_process_validation_fail_closed(self):
        probe.empty_group('', 'populated 0\nfrozen 0')
        for procs, events in [('42', 'populated 0'), ('', ''), ('', 'populated 1'),
                              ('', 'populated 0\npopulated 0'), ('invalid', 'populated 0')]:
            with self.subTest(procs=procs, events=events), self.assertRaises(probe.Forbidden):
                probe.empty_group(procs, events)

    def test_metadata_output_is_byte_bounded_and_truncation_is_explicit(self):
        output = probe.Output(4)
        output.add(b'ab')
        output.add(b'cd')
        self.assertEqual(output.data, b'abcd')
        self.assertFalse(output.truncated)
        output.add(b'efgh')
        self.assertEqual(output.data, b'abcd')
        self.assertEqual(output.observed_bytes, 8)
        self.assertTrue(output.truncated)
        empty = probe.Output(0)
        empty.add(b'x')
        self.assertEqual(empty.data, b'')
        self.assertTrue(empty.truncated)

    def test_evidence_cannot_hide_missing_memory_limits_truncation_or_cleanup_failure(self):
        sample = {'snapshot': {'files': {p: {'output': ''} for p in
                  ['/proc/meminfo', '/proc/swaps', '/proc/self/cgroup', '/proc/self/mountinfo']},
                  'cgroup_ancestry': [{'is_mount_root': False, 'memory.max': '1000', 'memory.swap.max': '0',
                                      'memory.current': '100', 'memory.swap.current': '0'},
                                      {'is_mount_root': True}]},
                  'expected_source_sha': 'a' * 40,
                  'disk': {'total_bytes': 100, 'available_bytes': 50},
                  'commands': [{'exit_code': 0, 'timed_out': False, 'truncated': False, 'output': 'a' * 40 + '\n'},
                               {'exit_code': 0, 'timed_out': False, 'truncated': False,
                                'output': 'VkPhysicalDeviceLimits VkPhysicalDeviceMemoryProperties maxStorageBufferRange'}],
                  'icds_truncated': False, 'containment': {'configuration_and_cleanup_verified': True,
                                                          'status': 'verified', 'errors': []}}
        sample['snapshot']['files']['/proc/meminfo']['output'] = 'MemTotal: 16000 kB\nMemAvailable: 12000 kB'
        self.assertTrue(probe.evidence_complete(sample))
        unavailable = copy.deepcopy(sample)
        unavailable['containment'] = probe.containment(FakeBoundary(not_delegated=True))
        self.assertTrue(probe.metadata_complete(unavailable))
        self.assertTrue(probe.evidence_complete(unavailable))
        self.assertEqual(unavailable['containment']['status'], 'unavailable')
        self.assertTrue(unavailable['containment']['target_forbidden'])
        self.assertFalse(unavailable['containment']['configuration_and_cleanup_verified'])
        for option in ['collision', 'bad_limit', 'kill_denied', 'remove_denied', 'close_denied']:
            failed = copy.deepcopy(sample)
            failed['containment'] = probe.containment(FakeBoundary(**{option: True}))
            self.assertTrue(probe.metadata_complete(failed))
            self.assertFalse(probe.evidence_complete(failed))
        for key in ['truncated', 'timed_out', 'cleanup_error']:
            changed = copy.deepcopy(sample)
            changed['commands'][1][key] = True
            self.assertFalse(probe.evidence_complete(changed))
        changed = copy.deepcopy(sample)
        changed['snapshot']['files']['/proc/meminfo'] = {'error': 'unavailable'}
        self.assertFalse(probe.evidence_complete(changed))
        changed = copy.deepcopy(sample)
        changed['containment']['configuration_and_cleanup_verified'] = False
        self.assertFalse(probe.evidence_complete(changed))
        changed = copy.deepcopy(sample)
        changed['commands'][1]['output'] = 'summary only'
        self.assertFalse(probe.evidence_complete(changed))
        for value in ['MemTotal: \nMemAvailable: 12 kB', 'MemTotal: 16 kB\nMemAvailable: 12',
                      'MemTotal: 16 MB\nMemAvailable: 12 kB', 'MemTotal: 16 kB\nMemAvailable: 0 kB']:
            changed = copy.deepcopy(sample)
            changed['snapshot']['files']['/proc/meminfo']['output'] = value
            self.assertFalse(probe.evidence_complete(changed))
        for value in [{'unknown': 'permission denied'}, '-1', '', 'unbounded']:
            changed = copy.deepcopy(sample)
            changed['snapshot']['cgroup_ancestry'][0]['memory.max'] = value
            self.assertFalse(probe.evidence_complete(changed))
        changed = copy.deepcopy(sample)
        changed['snapshot']['cgroup_ancestry'][0]['memory.max'] = 'max'
        self.assertTrue(probe.evidence_complete(changed))
        changed['snapshot']['cgroup_ancestry'][0]['memory.current'] = {'unknown': 'permission denied'}
        self.assertFalse(probe.evidence_complete(changed))
        changed['snapshot']['cgroup_ancestry'][0]['memory.current'] = {'unknown': 'not present', 'errno': errno.ENOENT}
        self.assertTrue(probe.evidence_complete(changed))
        changed = copy.deepcopy(sample)
        changed['commands'][0]['output'] = 'b' * 40
        self.assertFalse(probe.evidence_complete(changed))
        for key in ['cgroup_ancestry', 'disk', 'expected_source_sha']:
            changed = copy.deepcopy(sample)
            if key == 'cgroup_ancestry':
                changed['snapshot'][key] = []
            else:
                changed.pop(key)
            self.assertFalse(probe.evidence_complete(changed))

    def test_only_known_missing_capabilities_are_expected_unavailable(self):
        for code in [errno.EACCES, errno.EPERM, errno.EROFS, errno.ENOENT]:
            with self.subTest(code=code), self.assertRaises(probe.Unavailable):
                probe.capability_error(OSError(code, 'not delegated'))
        for code in [errno.EIO, errno.EEXIST, errno.ENOSPC]:
            with self.subTest(code=code), self.assertRaises(OSError):
                probe.capability_error(OSError(code, 'unexpected failure'))

    def test_workflow_has_no_target_selector_and_explicitly_skips_normal_paths(self):
        workflow = Path(__file__).parents[1] / '.github/workflows/release.yml'
        text = workflow.read_text()
        for job in ['metadata', 'validation', 'native', 'web-package', 'artifacts']:
            self.assertIn('  ' + job + ":\n    if: github.event_name != 'workflow_dispatch' || !inputs.large_gpu_preflight", text)
        self.assertIn("if: github.event_name == 'push' && !inputs.large_gpu_preflight", text)
        preflight = text.split('  large-gpu-preflight:', 1)[1].split('\n  metadata:', 1)[0]
        self.assertIn("if: github.event_name == 'workflow_dispatch' && inputs.large_gpu_preflight", preflight)
        self.assertIn('persist-credentials: false', preflight)
        self.assertIn('contents: read', preflight)
        self.assertIn('if: always()', preflight)
        for forbidden in ['cargo ', 'rustup ', '--ignored', 'million_dof', 'GH_TOKEN', 'id-token: write']:
            self.assertNotIn(forbidden, preflight)


if __name__ == '__main__':
    unittest.main()
