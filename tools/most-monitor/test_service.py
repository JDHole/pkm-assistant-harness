import json, tempfile, threading, time, unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from monitor import Service, _handler
from test_core import account, T

class ServiceTests(unittest.TestCase):
 def setUp(self):
  self.d=tempfile.TemporaryDirectory(); self.calls=0; self.lock=threading.Lock()
  def good():
   with self.lock: self.calls+=1
   time.sleep(.05); return account(20,now=time.time())
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
  self.s.core.db.execute("UPDATE state SET value=? WHERE key='snapshot'",(json.dumps({**s,'accounts':[account(20,time.time()-90)]}),));self.s.core.db.commit()
  self.s.last_refresh=0;self.s.account_cache={}
  s=self.s.usage(60);self.assertTrue(s['maxAgeSatisfied']);self.assertEqual(2,self.calls)
 def test_cli_max_age(self):
  from unittest.mock import patch,MagicMock
  from monitor import main
  response=MagicMock();response.__enter__.return_value.read.return_value=b'{}'
  with patch('monitor.load_config',return_value={'port':1236}),patch('urllib.request.urlopen',return_value=response) as urlopen,patch('builtins.print'):
   self.assertEqual(0,main(['usage_status','--max-age','60','--provider','claude']))
   self.assertIn('maxAge=60',urlopen.call_args.args[0].full_url);self.assertEqual(45,urlopen.call_args.kwargs['timeout'])
