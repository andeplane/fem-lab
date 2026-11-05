"""Transport only. All model interpretation and validation belongs to the engine."""
from __future__ import annotations
from dataclasses import fields, is_dataclass
import json
from urllib.request import Request, urlopen
from urllib.error import HTTPError

class _Omit:
    pass
OMIT = _Omit()

class FemError(RuntimeError):
    def __init__(self, error):
        self.error = error
        super().__init__(f"{error.get('code', 'internal')}: {error.get('cause', error)}")

def wire(value):
    if isinstance(value, Command):
        return value.wire()
    if is_dataclass(value):
        return {f.name: wire(getattr(value, f.name)) for f in fields(value) if getattr(value, f.name) is not OMIT}
    if isinstance(value, dict):
        return {k: wire(v) for k, v in value.items() if v is not OMIT}
    if isinstance(value, (list, tuple)):
        return [wire(v) for v in value]
    return value

class Command:
    def wire(self):
        return {self._tag: self._name, **{self._keys[f.name]: wire(getattr(self, f.name)) for f in fields(self) if getattr(self, f.name) is not OMIT}}

class HTTP:
    def __init__(self, url="http://127.0.0.1:7777", timeout=120):
        self.url, self.timeout, self.session, self.seq = url.rstrip('/'), timeout, None, 0
        self.session = self.request("/session", {})['session']
    def request(self, path, body):
        data = json.dumps(body, allow_nan=False).encode()
        headers = {'Content-Type': 'application/json'}
        if self.session:
            headers['X-Femlab-Session'] = self.session
        try:
            with urlopen(Request(self.url+path, data=data, headers=headers), timeout=self.timeout) as response:
                result = json.load(response, parse_int=lambda text: -0.0 if text == '-0' else int(text))
        except HTTPError as error:
            result = json.load(error)
        if 'error' in result:
            raise FemError(result['error'])
        return result
    def __call__(self, op, payload):
        self.seq += 1
        return self.request('/rpc', {'id': self.seq, 'op': op, 'payload': wire(payload)})['value']
    def close(self):
        if self.session:
            try:
                self.request('/close', {})
            except FemError as error:
                # Inactivity expiry already released this server-side owner.
                if error.error.get('code') != 'session.expired':
                    raise
            finally:
                self.session = None
