import json, tempfile, threading, time, unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from monitor import Service, _handler, enabled_providers
from test_core import account, T

def live(value=20, now=None, **extra):
  # Windows reset a week after the observation, so wall-clock tests never age into a past reset.
  now=time.time() if now is None else now; a=account(value, now=now, **extra)
  for w in a['windows']: w['resetsAt']=now+604800
  return a

class ServiceTests(unittest.TestCase):
 def setUp(self):
  self.d=tempfile.TemporaryDirectory(); self.calls=0; self.lock=threading.Lock()
  def good():
   with self.lock: self.calls+=1
   time.sleep(.05); return live(20)
  def bad(): return dict(account(0,provider="claude",accountRef="c"),status="error",windows=[])
  self.s=Service({"dataDir":self.d.name,"notifications":False},collectors=[good,bad]); self.http=ThreadingHTTPServer(("127.0.0.1",0),_handler(self.s)); threading.Thread(target=self.http.serve_forever,daemon=True).start()
 def tearDown(self): self.http.shutdown(); self.http.server_close(); self.s.stop(); self.s.core.close(); self.d.cleanup()
 def req(self,path,headers=None,method="GET"):
  c=HTTPConnection("127.0.0.1",self.http.server_port); c.request(method,path,headers=headers or {}); r=c.getresponse(); result=(r.status,json.loads(r.read()));c.close();return result
 def test_singleflight_five_requests_and_independent_failure(self):
  out=[]
  ts=[threading.Thread(target=lambda:out.append(self.req("/most/v1/usage?maxAge=60",{"X-Most-Client":"local-v1"}))) for _ in range(5)]
  [t.start() for t in ts]; [t.join() for t in ts]
  self.assertEqual(1,self.calls); self.assertTrue(all(x[0]==200 for x in out)); self.assertEqual("error",[a for a in out[0][1]["accounts"] if a["provider"]=="claude"][0]["status"])
  self.assertEqual('fresh',out[0][1]['accounts'][0]['status']);self.assertFalse(out[0][1]['maxAgeSatisfied']);self.assertEqual(1,len({x[1]['snapshotId'] for x in out}))
 def test_protection_and_input_rejection(self):
  self.assertEqual(403,self.req("/most/v1/usage")[0])
  self.assertEqual(403,self.req("/most/v1/usage",{"X-Most-Client":"local-v1","Origin":"x"})[0])
  self.assertEqual(403,self.req("/most/v1/usage",{"X-Most-Client":"local-v1","Origin":""})[0])
  self.assertEqual(403,self.req("/most/v1/usage",{"X-Most-Client":"local-v1","Host":"evil.test"})[0])
  self.assertEqual(400,self.req("/most/v1/usage?maxAge=bad",{"X-Most-Client":"local-v1"})[0])
  self.assertEqual(400,self.req("/most/v1/usage?hostId=no",{"X-Most-Client":"local-v1"})[0])
 def test_routing_status(self):
  status,body=self.req("/most/v1/routing-status",{"X-Most-Client":"local-v1"}); self.assertEqual(200,status); self.assertEqual("unsupported",body["recommend_model"])
 def test_failure_exception_and_cooldown(self):
  count=[0]
  def bad():count[0]+=1;raise RuntimeError('fixture')
  self.s.collectors[1]=bad
  one=self.s.usage(60);self.assertEqual('fresh',one['accounts'][0]['status']);self.assertEqual('error',one['accounts'][1]['status'])
  self.s.last_refresh=0;self.s.usage(60);self.assertEqual(1,count[0]);self.assertEqual(1,self.calls)
 def test_requested_age_checks_observation(self):
  self.s.collectors=self.s.collectors[:1]
  s=self.s.usage(60);self.assertTrue(s['maxAgeSatisfied'])
  self.s.core.db.execute("UPDATE state SET value=? WHERE key='snapshot'",(json.dumps({**s,'accounts':[live(20,time.time()-90)]}),));self.s.core.db.commit()
  self.s.last_refresh=0;self.s.account_cache={}
  s=self.s.usage(60);self.assertTrue(s['maxAgeSatisfied']);self.assertEqual(2,self.calls)
 def test_cli_max_age(self):
  from unittest.mock import patch,MagicMock
  from monitor import main
  response=MagicMock();response.__enter__.return_value.read.return_value=b'{}'
  with patch('monitor.load_config',return_value={'port':1236}),patch('urllib.request.urlopen',return_value=response) as urlopen,patch('builtins.print'):
   self.assertEqual(0,main(['usage_status','--max-age','60','--provider','claude']))
   self.assertIn('maxAge=60',urlopen.call_args.args[0].full_url);self.assertEqual(45,urlopen.call_args.kwargs['timeout'])
 def test_enabled_codex_only_does_not_call_claude_collector(self):
  calls=[]
  def codex(): calls.append('codex');return live(20)
  def claude(): calls.append('claude');return live(20,provider='claude',accountRef='c')
  service=Service({'dataDir':self.d.name,'notifications':False,'enabledProviders':['codex']},collectors={'codex':codex,'claude':claude})
  try:
   snapshot=service.refresh()
   self.assertEqual(['codex'],calls);self.assertEqual(['codex'],[a['provider'] for a in snapshot['accounts']])
  finally:
   # refresh publishes its result just before starting the notifier worker.
   while service.delivery_thread and service.delivery_thread.ident is None: time.sleep(.001)
   service.stop();service.core.close()
 def test_enabled_provider_validation_rejects_bad_shapes(self):
  for value in ([],['codex','codex'],['unsupported'],[None],True):
   with self.assertRaises(ValueError):enabled_providers({'enabledProviders':value})
 def test_load_config_default_providers_stay_two(self):
  from monitor import load_config
  with tempfile.TemporaryDirectory() as d:
   path=__import__('pathlib').Path(d)/'config.json';path.write_text(json.dumps({'dataDir':d}),encoding='utf-8')
   self.assertEqual(['codex','claude'],load_config(path)['enabledProviders'])
 def test_claude_hard_minimum_manual_refresh_and_restart_seed(self):
  calls=[]
  def claude(): calls.append(1);return live(20,provider='claude',accountRef='c')
  with tempfile.TemporaryDirectory() as d:
   config={'dataDir':d,'notifications':False,'enabledProviders':['claude'],'minIntervalSeconds':{'claude':0}}
   service=Service(config,collectors={'claude':claude})
   try:
    self.assertEqual(60,service.min_interval['claude'])
    service.min_interval['claude']=220
    now=time.time();service.account_cache['claude']=dict(status='fresh',observedAt=now-90,validUntil=now+200)
    service.attempted['claude']=now-90;self.assertFalse(service._due('claude',0,now));self.assertTrue(service._due('claude',0,now,manual=True))
    service.attempted['claude']=now-30;self.assertFalse(service._due('claude',0,now,manual=True));self.assertFalse(service._due('claude',1,now))
    service.account_cache={};service.attempted={};service.refresh();self.assertEqual(1,len(calls))
   finally:
    while service.delivery_thread and service.delivery_thread.ident is None: time.sleep(.001)
    service.stop();service.core.close()
   # A restart seeds the fresh account from the stored snapshot instead of reading again.
   restarted=Service({**config,'minIntervalSeconds':{}},collectors={'claude':claude})
   try:
    self.assertEqual('fresh',restarted.account_cache['claude']['status']);self.assertFalse(restarted._due('claude'))
    restarted.refresh();self.assertEqual(1,len(calls))
   finally:
    while restarted.delivery_thread and restarted.delivery_thread.ident is None: time.sleep(.001)
    restarted.stop();restarted.core.close()
 def test_manual_refresh_gets_its_own_round(self):
  import concurrent.futures
  calls=[]
  def claude(): calls.append(1);return live(20,provider='claude',accountRef='c')
  with tempfile.TemporaryDirectory() as d:
   service=Service({'dataDir':d,'notifications':False,'enabledProviders':['claude']},collectors={'claude':claude})
   try:
    service.refresh();service.refresh_thread.join();self.assertEqual(1,len(calls))
    # Inside the 5 s guard a click still reads a provider past its 60 s manual floor.
    service.attempted['claude']-=61;service.refresh(manual=True);service.refresh_thread.join();self.assertEqual(2,len(calls))
    # A click that joins a round started without it gets one more round of its own.
    service.attempted['claude']-=61;pending=concurrent.futures.Future();service.refreshing=pending
    worker=threading.Thread(target=lambda:service.refresh(manual=True));worker.start();time.sleep(.05)
    self.assertEqual(2,len(calls));pending.set_result(service._visible_snapshot(service.core.snapshot()))
    worker.join(5);service.refresh_thread.join();self.assertEqual(3,len(calls))
   finally:
    while service.delivery_thread and service.delivery_thread.ident is None: time.sleep(.001)
    service.stop();service.core.close()
 def test_manual_refresh_after_long_join_answers_and_reads_behind(self):
  import concurrent.futures, itertools
  from unittest.mock import patch
  calls=[]
  def claude(): calls.append(1);return live(20,provider='claude',accountRef='c')
  with tempfile.TemporaryDirectory() as d:
   service=Service({'dataDir':d,'notifications':False,'enabledProviders':['claude']},collectors={'claude':claude})
   try:
    service.refresh();service.refresh_thread.join();service.attempted['claude']-=61
    pending=concurrent.futures.Future();service.refreshing=pending;out=[]
    # Every monotonic read is 20 s later: the joined round looks long, so the click
    # answers with it and its own round runs behind the answer.
    clock=itertools.count(0,20)
    with patch('monitor.time.monotonic',side_effect=lambda:next(clock)):
     click=threading.Thread(target=lambda:out.append(service.refresh(manual=True)));click.start();time.sleep(.05)
     pending.set_result({'from':'joined'});click.join(5)
     self.assertEqual([{'from':'joined'}],out)
     deadline=time.time()+5
     while len(calls)<2 and time.time()<deadline: time.sleep(.01)
    self.assertEqual(2,len(calls))
   finally:
    while service.refresh_thread and service.refresh_thread.is_alive(): time.sleep(.01)
    while service.delivery_thread and service.delivery_thread.ident is None: time.sleep(.001)
    service.stop();service.core.close()
 def test_restart_after_failed_claude_read_keeps_hard_minimum(self):
  def bad(): return dict(live(0,provider='claude',accountRef='c'),status='unknown',reason='unconfirmed_live_usage',windows=[])
  with tempfile.TemporaryDirectory() as d:
   config={'dataDir':d,'notifications':False,'enabledProviders':['claude']}
   service=Service(config,collectors={'claude':bad})
   try: service.refresh();service.refresh_thread.join()
   finally:
    while service.delivery_thread and service.delivery_thread.ident is None: time.sleep(.001)
    service.stop();service.core.close()
   restarted=Service(config,collectors={'claude':bad})
   try:
    now=time.time();self.assertEqual('unknown',restarted.account_cache['claude']['status'])
    self.assertFalse(restarted._due('claude',0,now));self.assertTrue(restarted._due('claude',0,now+61))
   finally: restarted.stop();restarted.core.close()
 def test_agy_aliases_are_salted_and_reach_the_synced_file(self):
  from pathlib import Path
  with tempfile.TemporaryDirectory() as d:
   root=Path(d)
   (root/'usage_export.py').write_text("def summary_for_day(data_dir):\n    return {'status':'ok','totals':{'total':5},'accounts':[{'accountAlias':'raw-usage-alias','requests':1,'totals':{'total':5}}]}\n",encoding='utf-8')
   (root/'quota_export.py').write_text("def read_quotas(data_dir):\n    return {'status':'ok','accounts':[{'accountAlias':'raw-quota-alias','email':'fixture@example.test','status':'fresh','models':[]}]}\n",encoding='utf-8')
   synced=root/'vault'/'subscription-usage.json'
   config={'dataDir':str(root/'state'),'notifications':False,'enabledProviders':['codex'],'identitySalt':'local-test',
           'agyUsageModule':str(root/'usage_export.py'),'snapshotPath':str(synced)}
   service=Service(config,collectors={'codex':lambda:live(20)})
   try:
    http=service.usage(300);exported=json.loads(synced.read_text(encoding='utf-8'))
    for body in (http,exported):
     text=json.dumps(body['agyUsage'])
     for secret in ('raw-usage-alias','raw-quota-alias','fixture@example.test'):self.assertNotIn(secret,text)
     self.assertTrue(body['agyUsage']['quotas']['accounts'][0]['accountAlias'].startswith('google-'))
    # One alias everywhere: the tab numbers Google accounts by it, from HTTP or from the file.
    self.assertEqual(http['agyUsage']['quotas']['accounts'][0]['accountAlias'],exported['agyUsage']['quotas']['accounts'][0]['accountAlias'])
    self.assertNotIn('agyUsage',service.usage(300,provider='codex'))
    # Live HTTP keeps the reader's status; the stored record cannot expire, so it is never fresh.
    self.assertEqual('fresh',http['agyUsage']['quotas']['accounts'][0]['status'])
    self.assertEqual('stale',exported['agyUsage']['quotas']['accounts'][0]['status']);self.assertEqual('live_only',exported['agyUsage']['freshness'])
    self.assertEqual('stale',service.core.snapshot()['agyUsage']['quotas']['accounts'][0]['status'])
    service.config={**config,'identitySalt':None};self.assertIsNone(service._private_agy({'accountAlias':'raw'})['accountAlias'])
   finally:
    while service.delivery_thread and service.delivery_thread.ident is None: time.sleep(.001)
    service.stop();service.core.close()
 def test_agy_record_survives_odd_values(self):
  self.assertEqual('stale',Service._agy_record({'quotas':{'accounts':[{'status':'fresh'}]}})['quotas']['accounts'][0]['status'])
  for odd in ({'quotas':'broken'},{'quotas':{'accounts':'broken'}},['not','an','object'],{'bad':object()}):
   record=Service._agy_record(odd)
   self.assertIsInstance(record,dict);self.assertEqual('live_only',record['freshness'])
  self.assertEqual('agy_record_failed',Service._agy_record({'bad':object()})['reason'])
 def test_enabled_providers_accept_deepseek_and_default_stays_two(self):
  self.assertEqual(('codex','claude','deepseek'),enabled_providers({'enabledProviders':['codex','claude','deepseek']}))
  self.assertEqual(('codex','claude'),enabled_providers({}))
 def test_failing_provider_in_backoff_does_not_trigger_refresh(self):
  count=[0]
  def bad(): count[0]+=1;return dict(live(0,provider='claude',accountRef='c'),status='error',reason='usage_fetch_failed',windows=[])
  self.s.collectors[1]=bad
  first=self.s.usage(300);self.s.last_refresh=0
  for _ in range(3): again=self.s.usage(300)
  # A polling reader re-reads the stored snapshot: no collector call and no new ingest.
  self.assertEqual(1,count[0]);self.assertEqual(1,self.calls);self.assertEqual(first['snapshotId'],again['snapshotId'])
  self.s.cooldown['claude']=0;self.s.usage(300);self.assertEqual(2,count[0]);self.assertEqual(1,self.calls)
 def test_fresh_provider_interval_limits_polling(self):
  calls=[]
  def claude(): calls.append(1);return live(20,provider='claude',accountRef='c')
  with tempfile.TemporaryDirectory() as d:
   service=Service({'dataDir':d,'notifications':False,'enabledProviders':['claude']},collectors={'claude':claude})
   try:
    def again():
     # refresh() returns before its worker clears the in-flight future; wait for it.
     service.refresh_thread.join();service.last_refresh=0;service.refresh()
    service.refresh();again();self.assertEqual(1,len(calls))
    service.attempted['claude']-=221;again();self.assertEqual(2,len(calls))
   finally:
    while service.delivery_thread and service.delivery_thread.ident is None: time.sleep(.001)
    service.stop();service.core.close()
 def test_interval_floor_rules(self):
  with tempfile.TemporaryDirectory() as d:
   service=Service({'dataDir':d,'notifications':False,'enabledProviders':['claude'],'minIntervalSeconds':{'deepseek':600}},collectors={})
   try:
    now=time.time();self.assertEqual(600,service.min_interval['deepseek']);self.assertEqual(220,service.min_interval['claude'])
    service.account_cache['claude']=dict(status='fresh',observedAt=now-90,validUntil=now+200);service.attempted['claude']=now-90
    self.assertFalse(service._due('claude',0,now));self.assertFalse(service._due('claude',300,now));self.assertTrue(service._due('claude',60,now))
    service.attempted['claude']=now-30;self.assertFalse(service._due('claude',60,now))
    service.account_cache['claude']['validUntil']=now-1;service.attempted['claude']=now-61;self.assertTrue(service._due('claude',0,now))
    service.account_cache['claude']=dict(status='error');service.cooldown['claude']=now+100;self.assertFalse(service._due('claude',60,now))
   finally: service.stop();service.core.close()
  with self.assertRaises(ValueError):Service({'dataDir':self.d.name,'notifications':False,'minIntervalSeconds':[1]})
