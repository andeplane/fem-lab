"""Issue 3: bounded capacity evidence, never model admission or execution.

Only an explicit manual preflight may call main. Cgroup writes are confined to an
exclusively created child of the caller's already delegated unified subtree. The
idle child proves configuration, membership and kill/cleanup, not OOM enforcement.
No ancestor control, privilege escalation, compiler, engine or model is involved.
"""

import argparse
from dataclasses import dataclass
import errno
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import selectors
import signal
import subprocess
import sys
import time
from typing import Protocol


PROBE_BYTES = 64 * 1024**2
FILE_BYTES = 64 * 1024
COMMAND_BYTES = 1024**2
TOTAL_SECONDS = 180


class Forbidden(RuntimeError):
    pass


class Unavailable(Forbidden):
    """Expected lack of delegated containment, before starting the idle child."""


def capability_error(error: OSError) -> None:
    if error.errno in {errno.EACCES, errno.EPERM, errno.EROFS, errno.ENOENT}:
        raise Unavailable(str(error)) from error
    raise error


def manual_mode(event: str, enabled: str) -> bool:
    return event == 'workflow_dispatch' and enabled == 'true'


def membership(text: str) -> str:
    rows = text.strip().splitlines()
    if len(rows) != 1 or not rows[0].startswith('0::/'):
        raise Forbidden('a single unified cgroup-v2 membership is required')
    name = rows[0][3:]
    if '\x00' in name or '..' in name.split('/') or '.' in name.split('/'):
        raise Forbidden('unsafe cgroup membership')
    return name


def cgroup_parent(member: str, mountinfo: str) -> Path:
    mounts = []
    for row in mountinfo.splitlines():
        left, separator, right = row.partition(' - ')
        if separator and right.split() and right.split()[0] == 'cgroup2':
            fields = left.split()
            # Ambiguous namespace/root mappings fail closed rather than guessing.
            if len(fields) < 5 or fields[3] != '/':
                raise Forbidden('unsupported cgroup mount root')
            path = fields[4]
            if '\\' in path or not path.startswith('/'):
                raise Forbidden('escaped or relative cgroup mount is unsupported')
            mounts.append(Path(path))
    if len(mounts) != 1:
        raise Forbidden('one unambiguous cgroup-v2 mount is required')
    return mounts[0] / member.lstrip('/')


def numbers(text: str) -> set[int]:
    result = set()
    for token in text.split():
        if not token.isdecimal() or int(token) <= 0:
            raise Forbidden('invalid cgroup process identifier')
        result.add(int(token))
    return result


def empty_group(procs: str, events: str) -> None:
    rows = [row.split() for row in events.splitlines()]
    if numbers(procs) or [r for r in rows if r and r[0] == 'populated'] != [['populated', '0']]:
        raise Forbidden('owned cgroup is not verifiably empty')


def exact_limits(read) -> dict:
    observed = {}
    for name, wanted in [('memory.max', str(PROBE_BYTES)), ('memory.swap.max', '0'), ('memory.oom.group', '1')]:
        observed[name] = read(name).strip()
        if observed[name] != wanted:
            raise Forbidden('cgroup limit readback mismatch: ' + name)
    return observed


def child_identity(info: dict, pid: int, wanted_member: str) -> None:
    if info != {'pid': pid, 'pgid': pid, 'member': wanted_member}:
        raise Forbidden('owned idle-child identity or membership mismatch')


class Group(Protocol):
    member: str

    def read(self, name: str) -> str: ...
    def write(self, name: str, value: str) -> None: ...
    def remove(self) -> None: ...
    def close(self) -> None: ...


class Child(Protocol):
    pid: int

    def hello(self) -> dict: ...
    def confirm(self) -> dict: ...
    def wait(self) -> int: ...
    def stop(self) -> None: ...


class Boundary(Protocol):
    member: str

    def current_member(self) -> str: ...
    def delegated(self) -> None: ...
    def create(self) -> Group: ...
    def spawn(self) -> Child: ...
    def child_member(self, pid: int) -> str: ...


def containment(host: Boundary) -> dict:
    result = {'configuration_and_cleanup_verified': False, 'target_forbidden': True,
              'probe_memory_bytes': PROBE_BYTES, 'probe_swap_bytes': 0,
              'meaning': 'idle-child configuration/kill cleanup only; not OOM or model capacity'}
    group = None
    child = None
    errors = []
    unavailable = None
    try:
        host.delegated()
        result['monitor_member'] = host.member
        group = host.create()  # Exclusive creation; a collision never becomes ours.
        empty_group(group.read('cgroup.procs'), group.read('cgroup.events'))
        for name, value in [('memory.max', str(PROBE_BYTES)), ('memory.swap.max', '0'), ('memory.oom.group', '1')]:
            group.write(name, value)
        result['limit_readback_before_child'] = exact_limits(group.read)
        child = host.spawn()
        child_identity(child.hello(), child.pid, host.member)
        if host.current_member() != host.member:
            raise Forbidden('monitor changed cgroup before assignment')
        group.write('cgroup.procs', str(child.pid))
        if numbers(group.read('cgroup.procs')) != {child.pid} or host.child_member(child.pid) != group.member:
            raise Forbidden('owned cgroup must contain exactly the owned idle child')
        if host.current_member() == group.member:
            raise Forbidden('monitor must remain outside the probe cgroup')
        result['limit_readback_inside_child'] = exact_limits(group.read)
        # The child cannot progress past its first handshake until parent verification.
        child_identity(child.confirm(), child.pid, group.member)
        group.write('cgroup.kill', '1')
        if child.wait() != -signal.SIGKILL:
            raise Forbidden('scoped cgroup.kill did not reap the idle child with SIGKILL')
        result['owned_child_pid'] = child.pid
        result['owned_child_pgid'] = child.pid
        result['owned_member'] = group.member
    except Unavailable as error:
        if child is None:
            unavailable = str(error)
        else:
            errors.append('containment capability changed after child start: ' + str(error))
    except Exception as error:
        errors.append(str(error))
    finally:
        if child is not None:
            try:
                child.stop()  # Only this Popen handle's new process group; never a claimed PID.
            except Exception as error:
                errors.append('owned-child cleanup: ' + str(error))
        if group is not None:
            try:
                empty_group(group.read('cgroup.procs'), group.read('cgroup.events'))
                group.remove()
            except Exception as error:
                errors.append('owned-cgroup cleanup: ' + str(error))
            finally:
                try:
                    group.close()
                except Exception as error:
                    errors.append('owned-cgroup descriptor cleanup: ' + str(error))
    result['errors'] = errors
    result['status'] = 'failed' if errors else 'unavailable' if unavailable is not None else 'verified'
    result['unavailable_reason'] = unavailable
    result['configuration_and_cleanup_verified'] = not errors and unavailable is None
    return result


def read_file(path: Path, limit: int = FILE_BYTES) -> str:
    with path.open('rb') as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise Forbidden('metadata file exceeded byte cap: ' + str(path))
    return data.decode('utf-8', errors='replace')


def observe_exit(process: subprocess.Popen, seconds: float) -> int:
    """Observe without reaping: the reserved leader PID prevents PGID reuse."""
    deadline = time.monotonic() + seconds
    while True:
        info = os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        if info is not None:
            return info.si_status if info.si_code == os.CLD_EXITED else -info.si_status
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise subprocess.TimeoutExpired(process.args, seconds)
        time.sleep(min(0.01, remaining))


def group_running(pgid: int) -> bool:
    """Bounded Linux observation; zombies cannot execute or retain a pipe writer."""
    deadline = time.monotonic() + 1
    with os.scandir('/proc') as entries:
        for count, entry in enumerate(entries):
            if count >= 32768 or time.monotonic() >= deadline:
                raise Forbidden('owned-group cleanup observation exceeded its cap')
            if not entry.name.isdecimal():
                continue
            try:
                fields = read_file(Path(entry.path) / 'stat', 4096).rpartition(') ')[2].split()
            except FileNotFoundError:
                continue  # A process exited between directory observation and read.
            if len(fields) < 4:
                raise Forbidden('unreadable process identity during owned-group cleanup')
            if int(fields[2]) == pgid:
                if int(fields[3]) != pgid:
                    raise Forbidden('owned process-group session identity changed')
                if fields[0] not in {'Z', 'X', 'x'}:
                    return True
    return False


def stop_owned(process: subprocess.Popen) -> None:
    # No caller polls/waits before this boundary. Even an exited leader stays a
    # zombie, reserving its PID/session identity until all group members are stopped.
    if process.returncode is not None:
        raise Forbidden('cleanup requires the unreaped owned session leader')
    if os.getpgid(process.pid) != process.pid or os.getsid(process.pid) != process.pid:
        raise Forbidden('refusing to signal a non-owned process group/session')
    try:
        os.killpg(process.pid, signal.SIGKILL)
        deadline = time.monotonic() + 2
        while group_running(process.pid):
            if time.monotonic() >= deadline:
                raise Forbidden('owned process group did not become terminal')
            time.sleep(0.01)
    finally:
        process.wait(timeout=2)  # Reap only our Popen child after group cleanup.


class RealChild:
    def __init__(self):
        self.process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--idle-member'],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, start_new_session=True)
        self.pid = self.process.pid
        self.selector = None
        try:
            self.selector = selectors.DefaultSelector()
            self.selector.register(self.process.stdout, selectors.EVENT_READ)
        except Exception:
            self.stop()  # Popen already owns a child even if selector setup fails.
            raise

    def message(self) -> dict:
        data = bytearray()
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and len(data) < 4096:
            if self.selector.select(timeout=min(0.1, max(0, deadline - time.monotonic()))):
                byte = os.read(self.process.stdout.fileno(), 1)
                if not byte:
                    break
                if byte == b'\n':
                    return json.loads(data)
                data.extend(byte)
        raise Forbidden('idle-child handshake timeout, EOF or byte cap')

    def hello(self) -> dict:
        return self.message()

    def confirm(self) -> dict:
        self.process.stdin.write(b'confirm\n')
        self.process.stdin.flush()
        return self.message()

    def wait(self) -> int:
        return observe_exit(self.process, 2)

    def stop(self) -> None:
        errors = []
        try:
            stop_owned(self.process)
        except Exception as error:
            errors.append(str(error))
        for resource in [self.selector, self.process.stdin, self.process.stdout]:
            if resource is not None:
                try:
                    resource.close()
                except Exception as error:
                    errors.append(str(error))
        if errors:
            raise Forbidden('owned idle-child cleanup failed: ' + '; '.join(errors))


class RealGroup:
    def __init__(self, parent: Path, parent_member: str):
        self.name = 'femlab-3-preflight-' + str(os.getpid()) + '-' + str(time.monotonic_ns())
        try:
            self.parent = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        except OSError as error:
            capability_error(error)
        self.fd = None
        self.identity = None
        self.member = str(PurePosixPath(parent_member) / self.name)
        try:
            os.mkdir(self.name, dir_fd=self.parent)
        except OSError as error:
            os.close(self.parent)
            capability_error(error)
        try:
            self.fd = os.open(self.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.parent)
            self.identity = os.fstat(self.fd)
            if self.identity.st_uid != os.geteuid():
                raise Forbidden('new cgroup owner differs from the current user')
            # Verify availability without issuing any kill or moving a process.
            fd = os.open('cgroup.kill', os.O_WRONLY | os.O_NOFOLLOW, dir_fd=self.fd)
            os.close(fd)
        except Exception as error:
            # Without an open, verified identity we cannot safely remove even this name.
            removed = False
            try:
                if self.identity is not None and self.identity.st_uid == os.geteuid():
                    empty_group(self.read('cgroup.procs'), self.read('cgroup.events'))
                    self.remove()
                    removed = True
            finally:
                self.close()
            if not removed:
                raise Forbidden('created cgroup cleanup could not be verified: ' + str(error)) from error
            if isinstance(error, OSError):
                capability_error(error)
            raise

    def read(self, name: str) -> str:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=self.fd)
        try:
            data = os.read(fd, FILE_BYTES + 1)
            if len(data) > FILE_BYTES:
                raise Forbidden('cgroup metadata byte cap')
            return data.decode()
        finally:
            os.close(fd)

    def write(self, name: str, value: str) -> None:
        try:
            fd = os.open(name, os.O_WRONLY | os.O_NOFOLLOW, dir_fd=self.fd)
        except OSError as error:
            capability_error(error)
        try:
            data = (value + '\n').encode()
            if os.write(fd, data) != len(data):
                raise Forbidden('short cgroup control write')
        except OSError as error:
            capability_error(error)
        finally:
            os.close(fd)

    def remove(self) -> None:
        current = os.stat(self.name, dir_fd=self.parent, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (self.identity.st_dev, self.identity.st_ino):
            raise Forbidden('owned cgroup directory identity changed')
        os.rmdir(self.name, dir_fd=self.parent)

    def close(self) -> None:
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        if self.parent is not None:
            os.close(self.parent)
            self.parent = None


class RealBoundary:
    def __init__(self):
        self.member = self.current_member()
        self.parent = cgroup_parent(self.member, read_file(Path('/proc/self/mountinfo')))

    def current_member(self) -> str:
        return membership(read_file(Path('/proc/self/cgroup')))

    def delegated(self) -> None:
        if self.current_member() != self.member:
            raise Forbidden('monitor cgroup changed')
        try:
            if 'memory' not in read_file(self.parent / 'cgroup.subtree_control').split():
                raise Unavailable('memory is not already active in the current delegated subtree')
            if read_file(self.parent / 'cgroup.type').strip() != 'domain':
                raise Unavailable('a domain cgroup is required')
        except OSError as error:
            capability_error(error)

    def create(self) -> RealGroup:
        return RealGroup(self.parent, self.member)

    def spawn(self) -> RealChild:
        return RealChild()

    def child_member(self, pid: int) -> str:
        return membership(read_file(Path('/proc') / str(pid) / 'cgroup'))


@dataclass
class Output:
    limit: int
    data: bytes = b''
    observed_bytes: int = 0
    truncated: bool = False

    def add(self, data: bytes) -> None:
        self.observed_bytes += len(data)
        room = self.limit - len(self.data)
        self.data += data[:room]
        self.truncated = self.truncated or len(data) > room


def capture(command: list[str], seconds: float, limit: int) -> dict:
    result = {'command': command, 'exit_code': None, 'timed_out': False, 'truncated': False}
    output = Output(limit)
    process = None
    selector = selectors.DefaultSelector()
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        selector.register(process.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + seconds
        while True:
            if time.monotonic() >= deadline:
                result['timed_out'] = True
                break
            if selector.select(timeout=min(0.1, max(0, deadline - time.monotonic()))):
                data = os.read(process.stdout.fileno(), 4096)
                if not data:
                    try:
                        observe_exit(process, max(0.001, deadline - time.monotonic()))
                    except subprocess.TimeoutExpired:
                        result['timed_out'] = True
                    break
                output.add(data)
                if output.truncated:
                    break
    except Exception as error:
        result['error'] = str(error)
    finally:
        if process is not None:
            try:
                stop_owned(process)
                result['exit_code'] = process.returncode
            except Exception as error:
                result['cleanup_error'] = str(error)
            process.stdout.close()
        selector.close()
    result.update(output=output.data.decode('utf-8', errors='replace'),
                  observed_bytes=output.observed_bytes, truncated=output.truncated)
    return result


def snapshot() -> dict:
    result = {'uname': list(os.uname()), 'cpu_count': os.cpu_count(), 'files': {}, 'cgroup_ancestry': []}
    for name in ['/proc/meminfo', '/proc/swaps', '/proc/self/cgroup', '/proc/self/mountinfo']:
        try:
            result['files'][name] = {'output': read_file(Path(name)), 'truncated': False}
        except Exception as error:
            result['files'][name] = {'error': str(error)}
    try:
        member = membership(read_file(Path('/proc/self/cgroup')))
        parent = cgroup_parent(member, read_file(Path('/proc/self/mountinfo')))
        mount = cgroup_parent('/', read_file(Path('/proc/self/mountinfo')))
        for depth in range(32):
            row = {'path': str(parent), 'is_mount_root': parent == mount}
            for name in ['memory.max', 'memory.current', 'memory.peak', 'memory.swap.max',
                         'memory.swap.current', 'memory.events', 'cgroup.controllers', 'cgroup.subtree_control']:
                try:
                    row[name] = read_file(parent / name, 4096)
                except Exception as error:
                    row[name] = {'unknown': str(error), 'errno': getattr(error, 'errno', None)}
            result['cgroup_ancestry'].append(row)
            if parent == mount:
                break
            parent = parent.parent
        else:
            result['ancestry_error'] = 'cgroup ancestry exceeds depth cap'
    except Exception as error:
        result['ancestry_error'] = str(error)
    return result


def metadata_complete(result: dict) -> bool:
    commands = result.get('commands', [])
    files = result.get('snapshot', {}).get('files', {})
    required = ['/proc/meminfo', '/proc/swaps', '/proc/self/cgroup', '/proc/self/mountinfo']
    if any('output' not in files.get(name, {}) or files[name].get('truncated', False)
           for name in required):
        return False
    memory = dict(row.split(':', 1) for row in files['/proc/meminfo']['output'].splitlines() if ':' in row)
    if not all(len(memory.get(key, '').split()) == 2 and
               memory[key].split()[0].isdecimal() and memory[key].split()[1] == 'kB' and
               int(memory[key].split()[0]) > 0 for key in ['MemTotal', 'MemAvailable']):
        return False
    ancestry = result['snapshot'].get('cgroup_ancestry', [])
    if not ancestry or not ancestry[-1].get('is_mount_root'):
        return False
    for row in ancestry:
        # The root legitimately has no memory.max/swap.max; every non-root limit
        # must be observed so a hidden ancestor cap cannot look like free memory.
        if not row.get('is_mount_root'):
            for name in ['memory.max', 'memory.swap.max']:
                value = row.get(name)
                if isinstance(value, dict) and value.get('errno') == errno.ENOENT:
                    continue  # Explicitly absent controller file, not an inferred unlimited cap.
                if not isinstance(value, str) or not (value.strip() == 'max' or value.strip().isdecimal()):
                    return False
            for name in ['memory.current', 'memory.swap.current']:
                value = row.get(name)
                if isinstance(value, dict) and value.get('errno') == errno.ENOENT:
                    continue
                if not isinstance(value, str) or not value.strip().isdecimal():
                    return False
    if len(commands) != 2 or any(c.get('exit_code') != 0 or c.get('timed_out', True) or
                                 c.get('truncated', True) or 'error' in c or 'cleanup_error' in c
                                 for c in commands):
        return False
    expected = result.get('expected_source_sha', '')
    if len(expected) != 40 or any(c not in '0123456789abcdef' for c in expected) or \
            commands[0].get('output', '').strip() != expected:
        return False
    vulkan = commands[1]['output']
    if not all(marker in vulkan for marker in ['VkPhysicalDeviceLimits', 'VkPhysicalDeviceMemoryProperties',
                                               'maxStorageBufferRange']):
        return False
    disk = result.get('disk', {})
    return bool('error' not in result and 'ancestry_error' not in result['snapshot'] and
                disk.get('total_bytes', 0) > 0 and disk.get('available_bytes', -1) >= 0 and
                not result.get('icds_truncated', True))


def evidence_complete(result: dict) -> bool:
    state = result.get('containment', {})
    return bool(metadata_complete(result) and state.get('status') in {'verified', 'unavailable'} and
                not state.get('errors') and
                (state.get('configuration_and_cleanup_verified') or state.get('unavailable_reason')))


def idle_member() -> None:
    def emit():
        print(json.dumps({'pid': os.getpid(), 'pgid': os.getpgrp(),
                          'member': membership(read_file(Path('/proc/self/cgroup')))}), flush=True)
    emit()
    if sys.stdin.readline() != 'confirm\n':
        raise Forbidden('idle-child confirmation missing')
    emit()
    sys.stdin.readline()  # Remain idle until the owned cgroup is killed or parent closes.


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != 'linux' or not manual_mode(os.environ.get('GITHUB_EVENT_NAME', ''),
                                                 os.environ.get('FEMLAB_LARGE_GPU_PREFLIGHT', '')):
        parser.error('only the explicit Linux manual preflight may run this helper')
    args.output.mkdir(exist_ok=False)
    started = time.monotonic()
    result = {'schema': 'femlab-large-gpu-preflight/1', 'target_forbidden': True,
              'scope': 'capacity and idle-child containment only; no model, OOM proof, Metal or timing acceptance',
              'source_helper_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'expected_source_sha': os.environ.get('GITHUB_SHA', ''),
              'runner_image': {key: os.environ.get(key) for key in ['ImageOS', 'ImageVersion']},
              'snapshot': {}, 'commands': []}
    try:
        result['snapshot'] = snapshot()
        root = Path(__file__).resolve().parents[1]
        result['source_files'] = {}
        for name in ['.github/workflows/release.yml', '.github/workflows/ci.yml', 'Cargo.lock',
                     'rust-toolchain.toml', 'tools/gpu-large-preflight.py',
                     'tools/test_gpu_large_preflight.py', 'crates/engine/src/solve/aggregation.rs',
                     'crates/engine/tests/gpu_kernels.rs']:
            with (root / name).open('rb') as stream:
                data = stream.read(2 * COMMAND_BYTES + 1)
            if len(data) > 2 * COMMAND_BYTES:
                raise Forbidden('source fingerprint file exceeded byte cap: ' + name)
            result['source_files'][name] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        for command, seconds, limit in [(['git', 'rev-parse', 'HEAD'], 3, 4096),
                                         (['vulkaninfo'], 60, COMMAND_BYTES)]:
            remaining = TOTAL_SECONDS - (time.monotonic() - started)
            if remaining <= 0:
                raise Forbidden('total metadata deadline exceeded')
            result['commands'].append(capture(command, min(seconds, remaining), limit))
        if TOTAL_SECONDS - (time.monotonic() - started) < 10:
            raise Forbidden('insufficient deadline for the bounded containment probe')
        try:
            result['containment'] = containment(RealBoundary())
        except Exception as error:
            result['containment'] = {'configuration_and_cleanup_verified': False,
                                     'status': 'failed', 'target_forbidden': True, 'errors': [str(error)]}
        disk = os.statvfs(args.output)
        result['disk'] = {'available_bytes': disk.f_bavail * disk.f_frsize,
                          'total_bytes': disk.f_blocks * disk.f_frsize}
        result['icds'] = []
        result['icds_truncated'] = False
        for index, path in enumerate(Path('/usr/share/vulkan/icd.d').glob('*.json')):
            if index == 16:
                result['icds_truncated'] = True
                break
            result['icds'].append({'path': str(path), 'output': read_file(path, 16 * 1024)})
    except Exception as error:
        result['error'] = str(error)
    result['elapsed_resource_seconds'] = time.monotonic() - started
    if result['elapsed_resource_seconds'] > TOTAL_SECONDS:
        result['error'] = 'total metadata deadline exceeded'
    result['metadata_collection_complete'] = metadata_complete(result)
    result['preflight_evidence_complete'] = evidence_complete(result)
    (args.output / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'target_forbidden': True, 'preflight_evidence_complete': result['preflight_evidence_complete'],
                      'containment_status': result.get('containment', {}).get('status', 'failed'),
                      'receipt': str(args.output / 'receipt.json')}))
    return 0 if result['preflight_evidence_complete'] else 1


if __name__ == '__main__':
    if sys.argv[1:] == ['--idle-member']:
        idle_member()
    else:
        sys.exit(main())
