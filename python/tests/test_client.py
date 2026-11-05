import asyncio
import inspect
import json
from pathlib import Path
import unittest
from femlab import AsyncClient, Client
from femlab.client import FemError, wire
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
if __name__ == '__main__':
    unittest.main()
