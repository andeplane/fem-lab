import asyncio
import inspect
import json
from pathlib import Path
import unittest
from femlab import AsyncClient, Client
from femlab.client import FemError, HTTP, wire
from femlab.generated import GeometryAddBoxArgs, ModelDuplicateArgs

class ClientTest(unittest.TestCase):
    def test_all_engine_commands_and_queries_generated_once(self):
        schema = json.loads((Path(__file__).parents[2] / 'packages/registry/src/generated/engine.schema.json').read_text())
        import re, keyword
        def snake(name):
            value = re.sub(r'([a-z0-9])([A-Z])', r'\1_\2', name).replace('.', '_').lower()
            return value + '_' if keyword.iskeyword(value) else value
        for root, tag in [('commands', 'cmd'), ('queries', 'query')]:
            for variant in schema[root]['oneOf']:
                self.assertTrue(callable(getattr(Client, snake(variant['properties'][tag]['const']))))
    def test_omitted_quantities_and_reserved_words(self):
        self.assertEqual(wire(GeometryAddBoxArgs(name='bar', size=['1 m']*3)), {'cmd':'geometry.addBox', 'name':'bar', 'size':['1 m']*3})
        calls = []
        client = Client(transport=lambda op, payload: calls.append((op, payload)))
        client.model_duplicate(kind='body', name='bar', as_='other')
        self.assertEqual(calls[-1], ('dispatch', {'cmd':'model.duplicate','kind':'body','name':'bar','as':'other'}))
        with self.assertRaises(TypeError):
            client.geometry_add_box(name='bar')
    def test_async_adapter_preserves_schema_payload(self):
        async def run():
            async def call(op, payload):
                return [op, payload]
            value = await AsyncClient(call).query_model()
            self.assertEqual(value, ['query', {'query':'query.model'}])
        asyncio.run(run())
    def test_structured_error(self):
        error = FemError({'code':'schema','cause':'bad unit','where':'size'})
        self.assertEqual(error.error['where'], 'size')
        self.assertIn('schema: bad unit', str(error))
class ClientLifetimeTest(unittest.TestCase):
    def test_context_cleanup_preserves_original_analysis_failure(self):
        class BrokenClose:
            def __call__(self, op, payload):
                return None
            def close(self):
                raise RuntimeError('connection lost during close')
        with self.assertRaisesRegex(ValueError, 'independent numerical check failed'):
            with Client(transport=BrokenClose()):
                raise ValueError('independent numerical check failed')
        with self.assertRaisesRegex(RuntimeError, 'connection lost during close'):
            with Client(transport=BrokenClose()):
                pass

    def test_expired_close_is_idempotent_and_other_failures_surface(self):
        transport = object.__new__(HTTP)
        calls = []
        def expired(path, body):
            calls.append(path)
            raise FemError({'code':'session.expired','cause':'open a new client'})
        transport.request = expired
        transport.session = 'expired capability'
        transport.close()
        transport.close()
        self.assertEqual(calls, ['/close'])
        self.assertIsNone(transport.session)
        def unavailable(path, body):
            raise FemError({'code':'internal','cause':'database unavailable'})
        transport.request = unavailable
        transport.session = 'live capability'
        with self.assertRaises(FemError):
            transport.close()
        self.assertIsNone(transport.session)

if __name__ == '__main__':
    unittest.main()
