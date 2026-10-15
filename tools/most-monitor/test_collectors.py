import copy,json,tempfile,threading,unittest,urllib.error
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch,MagicMock
from collectors import parse_codex,parse_claude,collect_claude,CollectionError,percent,alias,_confirmed_live_usage_debug,_run_usage,resolve_codex_executable,collect_codex
from collectors import _run,parse_deepseek,collect_deepseek,_deepseek_key,DEEPSEEK_BALANCE_URL
from codex_resolver import resolve_codex_path

DS_KEY='sk-fixture-not-a-real-key'
def balance():
    return {'is_available':True,'balance_infos':[{'currency':'USD','total_balance':'4.30','granted_balance':'0.01','topped_up_balance':'4.28'}]}

CONFIG={'identitySalt':'local-test-only','dataDir':'.','claudePath':'fake'}
AUTH={'loggedIn':True,'authMethod':'claude.ai','apiProvider':'firstParty','email':'fixture@example.test','orgId':'org-fixture','subscriptionType':'max'}
def events():
    return [{'type':'system','subtype':'init','claude_code_version':'2.1.278'},
        {'type':'assistant','local_command_run':{'command':'usage','args':''},'usage_report':{'rate_limits':{'limits':[
            {'kind':'session','group':'session','percent':0,'resets_at':'2030-01-01T01:00:00Z','scope':None,'severity':'normal','is_active':False},
            {'kind':'weekly_all','group':'weekly','percent':81,'resets_at':'2030-01-04T01:00:00Z','scope':None,'severity':'warning','is_active':False},
            {'kind':'weekly_scoped','group':'weekly','percent':97,'resets_at':'2030-01-04T01:00:00.323Z','scope':{'model':{'display_name':'Fable'}},'severity':'critical','is_active':True}]}}},
        {'type':'result','subtype':'success','local_command':'usage','num_turns':0,'total_cost_usd':0,'usage':{'input_tokens':0,'output_tokens':0}}]
def codex():
    return {'accountId':'raw-account-id','rateLimitsByLimitId':{'codex':{'limitId':'codex','primary':{'usedPercent':55,'windowDurationMins':10080,'resetsAt':1900000000},'secondary':None}},'ordinaryUsageAllowed':False}

class CollectorsTest(unittest.TestCase):
    def test_missing_secondary_is_not_zero(self):
        a=parse_codex(codex(),{'type':'chatgpt','planType':'prolite'},CONFIG,1000)
        self.assertEqual(len(a['windows']),1);self.assertEqual(a['windows'][0]['windowMinutes'],10080)
        self.assertFalse(a['ordinaryUsageAllowed']);self.assertNotIn('raw-account-id',json.dumps(a))
    def test_multiple_buckets_preserved_without_legacy_double_count(self):
        data=codex();data['rateLimitsByLimitId']['other']={'limitId':'other','primary':{'usedPercent':20,'windowDurationMins':60,'resetsAt':2000}}
        data['rateLimits']=data['rateLimitsByLimitId']['codex']
        self.assertEqual(len(parse_codex(data,{'type':'chatgpt'},CONFIG,1000)['windows']),2)
    def test_null_and_zero_duration(self):
        data=codex();r=data['rateLimitsByLimitId']['codex']['primary'];r['usedPercent']=None;r['windowDurationMins']=None
        w=parse_codex(data,{'type':'chatgpt'},CONFIG,1000)['windows'][0];self.assertIsNone(w['usedPercent']);self.assertIsNone(w['windowMinutes'])
        r['windowDurationMins']=0
        self.assertEqual(parse_codex(data,{'type':'chatgpt'},CONFIG,1000)['status'],'unknown')
    def test_identity_required(self):
        data=codex();data['accountId']=None
        with self.assertRaisesRegex(CollectionError,'identity'):parse_codex(data,{'type':'chatgpt'},CONFIG,1000)
    def test_claude_keeps_inactive_rows_and_scopes(self):
        a=parse_claude(events(),AUTH,CONFIG,1000,live_confirmed=True)
        self.assertEqual(len(a['windows']),3);self.assertEqual(a['windows'][2]['scope']['model']['display_name'],'Fable')
        self.assertEqual(a['windows'][0]['usedPercent'],0);self.assertNotIn(AUTH['email'],json.dumps(a))
        self.assertNotIn(AUTH['orgId'],json.dumps(a))
    def test_old_cli_cache_never_fresh(self):
        e=events();e[0]['claude_code_version']='2.1.275'
        with self.assertRaisesRegex(CollectionError,'version'):parse_claude(e,AUTH,CONFIG,1000,live_confirmed=True)
    def test_empty_report_error_not_full_limit(self):
        e=events();e[1]['usage_report']['rate_limits']['limits']=[]
        with self.assertRaisesRegex(CollectionError,'fetch_failed'):parse_claude(e,AUTH,CONFIG,1000,live_confirmed=True)
    def test_cache_unconfirmed(self):
        e=events();del e[1]['usage_report']['rate_limits']['limits'][0]['severity']
        with self.assertRaisesRegex(CollectionError,'unconfirmed'):parse_claude(e,AUTH,CONFIG,1000,live_confirmed=True)
    def test_live_debug_confirmation_required(self):
        with self.assertRaisesRegex(CollectionError,'unconfirmed_live_usage'):
            parse_claude(events(),AUTH,CONFIG,1000,live_confirmed=False)
        self.assertTrue(_confirmed_live_usage_debug(
            'x [DEBUG] fetchUtilization: GET /api/oauth/usage (attempt 1)\n'
            'x [DEBUG] fetchUtilization: 200 after 1 attempt(s)\n'))
        self.assertFalse(_confirmed_live_usage_debug(
            'x [DEBUG] fetchUtilization: GET /api/oauth/usage (attempt 1)\n'
            'x [ERROR] fetchUtilization: network failed\n'))
        self.assertFalse(_confirmed_live_usage_debug(
            'x [DEBUG] fetchUtilization: 200 after 1 attempt(s)\n'
            'x [DEBUG] fetchUtilization: GET /api/oauth/usage (attempt 1)\n'))
    def test_usage_debug_file_is_unique_gated_and_removed(self):
        with tempfile.TemporaryDirectory() as d:
            config={**CONFIG,'dataDir':d};paths=[]
            def good(args,config,deadline):
                path=Path(args[args.index('--debug-file')+1]);paths.append(path)
                path.write_text('x fetchUtilization: GET /api/oauth/usage (attempt 1)\n'
                    'x fetchUtilization: 200 after 1 attempt(s)\n',encoding='utf-8')
                return 'stream'
            with patch('collectors._run',side_effect=good):self.assertEqual('stream',_run_usage(config,1000))
            self.assertEqual(1,len(paths));self.assertFalse(paths[0].exists())
            def stale(args,config,deadline):
                Path(args[args.index('--debug-file')+1]).write_text('no live marker',encoding='utf-8');return 'cached'
            with patch('collectors._run',side_effect=stale),self.assertRaisesRegex(CollectionError,'unconfirmed'):
                _run_usage(config,1000)
            self.assertEqual([],list(Path(d).glob('claude-usage-*.log')))
    def test_report_must_belong_to_usage_local_command(self):
        for command,args in [('cost',''),('usage','unexpected')]:
            e=events();e[1]['local_command_run']={'command':command,'args':args}
            with self.assertRaisesRegex(CollectionError,'usage_result_missing'):
                parse_claude(e,AUTH,CONFIG,1000,live_confirmed=True)
    def test_nonlocal_or_nonzero_rejected(self):
        for key,val in [('num_turns',1),('total_cost_usd',.01),('local_command',None)]:
            e=events();e[-1][key]=val
            with self.assertRaises(CollectionError):parse_claude(e,AUTH,CONFIG,1000,live_confirmed=True)
        e=events();e[-1]['usage']['input_tokens']=1
        with self.assertRaises(CollectionError):parse_claude(e,AUTH,CONFIG,1000,live_confirmed=True)
    def test_api_auth_rejected(self):
        auth={**AUTH,'authMethod':'api_key'}
        with self.assertRaises(CollectionError):parse_claude(events(),auth,CONFIG,1000,live_confirmed=True)
        with self.assertRaises(CollectionError):parse_codex(codex(),{'type':'apiKey'},CONFIG,1000)
    def test_env_override_blocks_before_process(self):
        with patch.dict('os.environ',{'ANTHROPIC_API_KEY':'fixture'}),patch('collectors._run') as run:
            a=collect_claude(CONFIG);self.assertEqual(a['reason'],'provider_override');run.assert_not_called()
    def test_old_version_blocked_before_usage_command(self):
        with patch.dict('os.environ',{},clear=True),patch('collectors._run',side_effect=[json.dumps(AUTH),'2.1.275 (Claude Code)']) as run:
            a=collect_claude(CONFIG);self.assertEqual(a['status'],'unsupported');self.assertEqual(run.call_count,2)
    def test_auth_provider_change_during_read_rejected(self):
        output='\n'.join(json.dumps(e) for e in events())
        for changed in ({**AUTH,'loggedIn':False},{**AUTH,'apiProvider':'thirdParty'}):
            with patch.dict('os.environ',{},clear=True),\
                 patch('collectors._run',side_effect=[json.dumps(AUTH),'2.1.278 (Claude Code)',json.dumps(changed)]),\
                 patch('collectors._run_usage',return_value=output):
                a=collect_claude(CONFIG)
            self.assertEqual(a['reason'],'account_changed_during_read')
    def test_alias_changes_with_identity_and_local_salt(self):
        self.assertNotEqual(alias('claude','a',CONFIG),alias('claude','b',CONFIG))
        self.assertNotEqual(alias('claude','a',CONFIG),alias('claude','a',{'identitySalt':'other'}))
    def test_bad_numeric_values(self):
        for v in (None,True,'0',float('nan'),-1,101):self.assertIsNone(percent(v))
        self.assertEqual(percent(0),0)
    def test_codex_executable_reloads_rotated_app_path_from_toml(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); old=root/'old.exe'; current=root/'current.exe'
            old.write_bytes(b'old');current.write_bytes(b'current')
            toml=root/'config.toml';toml.write_text('CODEX_CLI_PATH = "'+str(old).replace('\\','\\\\')+'"\n[mcp_servers.node_repl.env]\nCODEX_CLI_PATH = "'+str(current).replace('\\','\\\\')+'"\nOTHER_SECRET = "must not be used or returned"\n',encoding='utf-8')
            with patch.dict('os.environ',{},clear=True):
                self.assertEqual(current.resolve(),resolve_codex_executable({'codexPath':str(old)},toml))
                newer=root/'newer.exe';newer.write_bytes(b'newer')
                toml.write_text('CODEX_CLI_PATH = "'+str(old).replace('\\','\\\\')+'"\n[mcp_servers.node_repl.env]\nCODEX_CLI_PATH = "'+str(newer).replace('\\','\\\\')+'"\nOTHER_SECRET = "must not be used or returned"\n',encoding='utf-8')
                self.assertEqual(newer.resolve(),resolve_codex_executable({'codexPath':str(old)},toml))
    def test_codex_executable_environment_wins_without_leaking_settings(self):
        with tempfile.TemporaryDirectory() as d:
            env=Path(d)/'env.exe';pinned=Path(d)/'pinned.exe';env.write_bytes(b'e');pinned.write_bytes(b'p')
            with patch.dict('os.environ',{'CODEX_CLI_PATH':str(env)}):
                self.assertEqual(env.resolve(),resolve_codex_executable({'codexPath':str(pinned)},Path(d)/'missing.toml'))
    def test_codex_collection_reloads_config_path_without_restart(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);one=root/'one.exe';two=root/'two.exe';one.write_bytes(b'1');two.write_bytes(b'2')
            settings=root/'.codex'/'config.toml';settings.parent.mkdir();
            captured=[]
            class FakeRpc:
                def __init__(self,path,cwd):captured.append(Path(path));self.reads=0
                def call(self,method,params):
                    if method=='account/read':return {'account':{'type':'chatgpt','planType':'pro'}}
                    if method=='account/rateLimits/read':return {'accountId':'fixture-account','rateLimitsByLimitId':{'codex':{'limitId':'codex','primary':{'usedPercent':4,'windowDurationMins':10080}}}}
                    return {}
                def send(self,payload):pass
                def close(self):pass
            config={'codexPath':str(root/'missing.exe'),'dataDir':d,'identitySalt':'local-test'}
            with patch.dict('os.environ',{},clear=True),patch('collectors.Path.home',return_value=root),patch('collectors.Rpc',FakeRpc):
                for binary in (one,two):
                    settings.write_text('CODEX_CLI_PATH = "'+str(binary).replace('\\','\\\\')+'"\n',encoding='utf-8')
                    self.assertEqual('fresh',collect_codex(config)['status'])
            self.assertEqual([one.resolve(),two.resolve()],captured)
    def test_official_install_fallback_works_when_pins_are_stale(self):
        with tempfile.TemporaryDirectory() as d:
            app=Path(d)/'AppData/Local/OpenAI/Codex/bin/fallback';app.mkdir(parents=True)
            binary=app/'codex.exe';binary.write_bytes(b'fixture')
            with patch.dict('os.environ',{},clear=True),patch('codex_resolver.Path.home',return_value=Path(d)),patch('codex_resolver._reported_version',return_value=(1,2,3,(1,()))):
                self.assertEqual(binary.resolve(),resolve_codex_executable({'codexPath':str(Path(d)/'stale.exe')},Path(d)/'missing.toml'))
    def test_official_fallback_chooses_highest_reported_version(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); low=root/'OpenAI/Codex/bin/900/codex.exe'; high=root/'OpenAI/Codex/bin/100/codex.exe'
            low.parent.mkdir(parents=True);high.parent.mkdir(parents=True);low.write_bytes(b'l');high.write_bytes(b'h')
            versions={low:(1,9,0,(1,())),high:(2,0,0,(1,()))}
            with patch.dict('os.environ',{},clear=True),patch('codex_resolver._reported_version',side_effect=lambda p,timeout=2:versions[Path(p)]):
                self.assertEqual(high.resolve(),resolve_codex_path(Path(root/'missing.toml'),local_appdata=root))
    def test_codex_missing_executable_has_safe_actionable_reason(self):
        with tempfile.TemporaryDirectory() as d,patch.dict('os.environ',{},clear=True),patch('collectors.Path.home',return_value=Path(d)):
            a=collect_codex({'codexPath':str(Path(d)/'missing.exe'),'dataDir':d})
        self.assertEqual('error',a['status']);self.assertEqual('codex_executable_unavailable',a['reason'])
    def test_claude_subprocess_never_autoupdates(self):
        with patch('collectors.subprocess.run') as run:
            run.return_value.returncode=0;run.return_value.stdout='2.1.299 (Claude Code)'
            _run(['--version'],CONFIG,10**12)
        self.assertEqual('1',run.call_args.kwargs['env']['DISABLE_AUTOUPDATER'])
    def test_deepseek_balance_text_kept_and_key_not_disclosed(self):
        a=parse_deepseek(balance(),DS_KEY,CONFIG,1000)
        self.assertEqual('fresh',a['status']);self.assertEqual(1300,a['validUntil']);self.assertEqual([],a['windows'])
        self.assertEqual('4.30',a['balance_infos'][0]['total_balance']);self.assertTrue(a['is_available'])
        self.assertNotIn(DS_KEY,json.dumps(a));self.assertTrue(a['accountRef'].startswith('deepseek-'))
        self.assertNotEqual(a['accountRef'],parse_deepseek(balance(),DS_KEY+'x',CONFIG,1000)['accountRef'])
    def test_deepseek_unexpected_shape_is_error_not_zero(self):
        for change in ({'is_available':'yes'},{'balance_infos':None},{'balance_infos':[{'currency':'USD','total_balance':4.3}]},
                       {'balance_infos':[{'currency':'usd','total_balance':'4.30'}]},{'balance_infos':[{'currency':'USD'}]}):
            with self.assertRaisesRegex(CollectionError,'balance_shape_unexpected'):parse_deepseek({**balance(),**change},DS_KEY,CONFIG,1000)
    def test_deepseek_key_from_dotenv_and_env_wins(self):
        with tempfile.TemporaryDirectory() as d:
            env=Path(d)/'.env.local';env.write_text('# local\nOTHER=1\nexport DEEPSEEK_API_KEY="from-file" \n',encoding='utf-8')
            with patch.dict('os.environ',{},clear=True):self.assertEqual('from-file',_deepseek_key({'deepseekKeyFile':str(env)}))
            with patch.dict('os.environ',{'DEEPSEEK_API_KEY':'from-env'},clear=True):self.assertEqual('from-env',_deepseek_key({'deepseekKeyFile':str(env)}))
            with patch.dict('os.environ',{},clear=True),patch('collectors._http_get') as get:
                a=collect_deepseek({**CONFIG,'deepseekKeyFile':str(Path(d)/'missing')})
            self.assertEqual('deepseek_key_unavailable',a['reason']);get.assert_not_called()
            env.write_text("DEEPSEEK_API_KEY='sk-quoted' # klucz z TaskRound\n",encoding='utf-8')
            with patch.dict('os.environ',{},clear=True):self.assertEqual('sk-quoted',_deepseek_key({'deepseekKeyFile':str(env)}))
    def test_deepseek_http_failure_maps_to_safe_reason(self):
        err=urllib.error.HTTPError(DEEPSEEK_BALANCE_URL,401,'Unauthorized',{},None)
        with patch.dict('os.environ',{'DEEPSEEK_API_KEY':DS_KEY},clear=True),patch('collectors._http_get',side_effect=err):
            a=collect_deepseek(CONFIG)
        self.assertEqual('auth_required',a['status']);self.assertNotIn(DS_KEY,json.dumps(a));self.assertTrue(a['accountRef'].startswith('deepseek-'))
    def test_deepseek_live_shape_collected(self):
        with patch.dict('os.environ',{'DEEPSEEK_API_KEY':DS_KEY},clear=True),patch('collectors._http_get',return_value=json.dumps(balance()).encode()) as get:
            a=collect_deepseek(CONFIG)
        self.assertEqual('fresh',a['status']);self.assertEqual('Bearer '+DS_KEY,get.call_args.args[0].get_header('Authorization'))
    def test_deepseek_key_never_follows_a_redirect(self):
        seen=[]
        class Target(BaseHTTPRequestHandler):
            def log_message(self,*a):pass
            def do_GET(self):seen.append(self.headers.get('Authorization'));self.send_response(200);self.end_headers();self.wfile.write(json.dumps(balance()).encode())
        target=ThreadingHTTPServer(('127.0.0.1',0),Target)
        class Bounce(BaseHTTPRequestHandler):
            def log_message(self,*a):pass
            def do_GET(self):self.send_response(302);self.send_header('Location','http://127.0.0.1:%d/'%target.server_port);self.end_headers()
        bounce=ThreadingHTTPServer(('127.0.0.1',0),Bounce)
        for s in (target,bounce):threading.Thread(target=s.serve_forever,daemon=True).start()
        try:
            with patch.dict('os.environ',{'DEEPSEEK_API_KEY':DS_KEY},clear=True),patch('collectors.DEEPSEEK_BALANCE_URL','http://127.0.0.1:%d/user/balance'%bounce.server_port):
                a=collect_deepseek(CONFIG)
        finally:
            for s in (target,bounce):s.shutdown();s.server_close()
        self.assertEqual('usage_fetch_failed',a['reason']);self.assertEqual([],seen)

if __name__=='__main__':unittest.main()
