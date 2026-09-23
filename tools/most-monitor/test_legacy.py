"""Read the two legacy functions in isolation, with a client that forbids POST."""
import ast, asyncio, os, unittest
from pathlib import Path
from unittest.mock import patch

class LegacyTest(unittest.TestCase):
    def test_default_no_model_ping_and_health_stays_get(self):
        source=Path(__file__).with_name('legacy').joinpath('most.py').read_text(encoding='utf-8')
        tree=ast.parse(source)
        names={'micro_ping','_usage_needs_refresh'}
        body=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name in names]
        for n in body:
            n.returns=None
            for arg in n.args.args:arg.annotation=None
        scope={'os':os}
        exec(compile(ast.Module(body=body,type_ignores=[]),'legacy-functions','exec'),scope)
        with patch.dict(os.environ,{},clear=True):
            self.assertFalse(scope['_usage_needs_refresh']())
            self.assertFalse(asyncio.run(scope['micro_ping'](object())))
        health=next(n for n in tree.body if isinstance(n,ast.AsyncFunctionDef) and n.name=='backend_alive')
        self.assertIn('client.get',ast.unparse(health));self.assertNotIn('client.post',ast.unparse(health))
