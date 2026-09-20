import copy,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from collectors import parse_codex,parse_claude,collect_claude,CollectionError,percent,alias,_confirmed_live_usage_debug,_run_usage

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

if __name__=='__main__':unittest.main()
