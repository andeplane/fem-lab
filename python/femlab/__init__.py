"""FEM Lab registry client, for CPython and the browser's Pyodide worker.

Client methods block over local/server HTTP. AsyncClient uses an injected async RPC
(for Pyodide or another async host). Neither client implements any FEM numerics.
"""
from .client import HTTP, FemError, Command
from .generated import API, AsyncAPI

class Client(API):
    def __init__(self, url="http://127.0.0.1:7777", *, transport=None, timeout=120):
        self._call = transport if transport is not None else HTTP(url, timeout)
    def close(self):
        if hasattr(self._call, 'close'):
            self._call.close()
    def __enter__(self):
        return self
    def __exit__(self, error_type, error, traceback):
        if error_type is None:
            self.close()
        else:
            try:
                self.close()
            except Exception:
                # A cleanup/connection failure must not replace the analysis failure.
                pass
    def dispatch(self, command):
        return self._call('dispatch', command.wire() if isinstance(command, Command) else command)
    def query(self, query):
        return self._call('query', query.wire() if isinstance(query, Command) else query)

class AsyncClient(AsyncAPI):
    def __init__(self, transport):
        self._call = transport
    async def dispatch(self, command):
        return await self._call('dispatch', command.wire() if isinstance(command, Command) else command)
    async def query(self, query):
        return await self._call('query', query.wire() if isinstance(query, Command) else query)
