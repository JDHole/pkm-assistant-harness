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

    def test_tray_adapter_reads_only_fresh_codex_snapshot_and_keeps_windows_separate(self):
        source=Path(__file__).with_name('legacy').joinpath('most.py').read_text(encoding='utf-8')
        tree=ast.parse(source)
        fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_monitor_usage')
        import math
        scope={'WEEKLY_MIN_MINUTES':10080,'math':math}
        exec(compile(ast.Module(body=[fn],type_ignores=[]),'legacy-usage-adapter','exec'),scope)
        snapshot={'validUntil':500,'accounts':[
            {'provider':'codex','status':'fresh','validUntil':500,'observedAt':400,'windows':[
                {'poolId':'a','windowId':'short','label':'5h','windowMinutes':300,'usedPercent':4,'resetsAt':600},
                {'poolId':'b','windowId':'week','label':'7d','windowMinutes':10080,'usedPercent':12,'resetsAt':700},
            ]},
            {'provider':'claude','status':'fresh','validUntil':500,'observedAt':400,'windows':[
                {'poolId':'claude','windowId':'week','windowMinutes':10080,'usedPercent':91,'resetsAt':700},
            ]},
        ]}
        usage=scope['_monitor_usage'](snapshot,450)
        self.assertEqual([w['used_percent'] for w in usage['windows']], [4,12])
        self.assertEqual(usage['short']['used_percent'],4)
        self.assertEqual(usage['weekly']['used_percent'],12)
        stale=scope['_monitor_usage'](snapshot,501)
        self.assertIsNone(stale['short'])
        self.assertIsNone(stale['weekly'])
        self.assertTrue(all(w['used_percent'] is None for w in stale['windows']))
        aged=dict(snapshot,validUntil=900,accounts=[dict(snapshot['accounts'][0],validUntil=900,observedAt=100)])
        old=scope['_monitor_usage'](aged,450)
        self.assertEqual(old['status'],'stale')
        self.assertTrue(all(w['used_percent'] is None for w in old['windows']))

    def test_tray_keeps_fresh_codex_while_another_provider_fails(self):
        import json,math,tempfile
        from core import MonitorCore
        source=Path(__file__).with_name('legacy').joinpath('most.py').read_text(encoding='utf-8')
        fn=next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name=='_monitor_usage')
        scope={'WEEKLY_MIN_MINUTES':10080,'math':math}
        exec(compile(ast.Module(body=[fn],type_ignores=[]),'legacy-usage-adapter','exec'),scope)
        def codex(now):return {'provider':'codex','accountRef':'a','status':'fresh','observedAt':now,'receivedAt':now,'validUntil':now+300,'plan':'p',
            'windows':[{'poolId':'p','windowId':'w','label':'week','scope':{},'windowMinutes':10080,'usedPercent':7,'resetsAt':now+604800}]}
        with tempfile.TemporaryDirectory() as d:
            core=MonitorCore(d,host_id='h',enabled_providers=['codex','claude'])
            try:
                core.ingest([codex(1000),dict(codex(1000),provider='claude',accountRef='c')],1000)
                core.ingest([codex(1400),{'provider':'claude','accountRef':'c','status':'unknown','reason':'unconfirmed_live_usage','windows':[],'receivedAt':1400}],1400)
                exported=json.loads((Path(d)/'most-snapshot.json').read_text())
            finally:core.close()
        usage=scope['_monitor_usage'](exported,1450)
        self.assertEqual('fresh',usage['status']);self.assertEqual(7,usage['weekly']['used_percent'])

    def test_legacy_never_reads_chatmock_quota_file(self):
        source=Path(__file__).with_name('legacy').joinpath('most.py').read_text(encoding='utf-8')
        tree=ast.parse(source)
        read=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='read_usage')
        self.assertIn('MONITOR_SNAPSHOT_PATH',ast.unparse(read))
        self.assertNotIn('USAGE_PATH',ast.unparse(read))
        self.assertIn('BASE_DIR / "most-monitor" / "state" / "most-snapshot.json"',source)

    def test_tray_warns_for_high_usage_when_window_duration_is_unknown(self):
        source=Path(__file__).with_name('legacy').joinpath('most.py').read_text(encoding='utf-8')
        tree=ast.parse(source)
        fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_usage_warning')
        scope={}
        exec(compile(ast.Module(body=[fn],type_ignores=[]),'legacy-warning','exec'),scope)
        usage={'status':'fresh','windows':[{'fresh':True,'used_percent':95,'window_minutes':None}]}
        self.assertTrue(scope['_usage_warning'](usage))
        self.assertFalse(scope['_usage_warning']({'status':'stale','windows':[{'fresh':False,'used_percent':95}]}))
