import tempfile, unittest, time, json
from pathlib import Path
from core import MonitorCore
T=1789927200

def account(value=20, now=T, **extra):
    a={'provider':'codex','accountRef':'a','label':'A','authMode':'subscription','status':'fresh','reason':None,'source':'fixture','observedAt':now,'receivedAt':now,'validUntil':now+300,'coverage':[],'plan':'p','windows':[{'poolId':'p','windowId':'w','label':'week','scope':{},'windowKind':'unknown','windowMinutes':10080,'metricKind':'usage_percent','unit':'percent','value':value,'usedPercent':value,'resetsAt':T+604800}]}
    a.update(extra); return a

class CoreTests(unittest.TestCase):
    def setUp(self): self.d=tempfile.TemporaryDirectory(); self.c=MonitorCore(self.d.name,host_id='h')
    def tearDown(self): self.c.close(); self.d.cleanup()
    def put(self,value,now=T,**kw): return self.c.ingest([account(value,now,**kw)],now)
    def alerts(self,s,kind): return [a for a in s['alerts'] if a['kind']==kind]
    def test_daily_29_30_restart(self):
        self.put(20)
        s=self.put(49,T+60);self.assertEqual(29,s['accounts'][0]['daily'][0]['deltaPp']);self.assertEqual([],s['alerts'])
        s=self.put(50,T+120);self.assertEqual(1,len(self.alerts(s,'daily')))
        self.c.close();self.c=MonitorCore(self.d.name,host_id='h')
        s=self.put(55,T+180);self.assertEqual(1,len(self.alerts(s,'daily')))
    def test_new_reset_alerts_again(self):
        self.put(97)
        a=account(97,T+60);a['windows'][0]['resetsAt']+=604800
        s=self.c.ingest([a],T+60);self.assertEqual(2,len(self.alerts(s,'window')))
    def test_next_day_new_baseline_and_daily_alert(self):
        self.put(5);self.put(35,T+60)
        s=self.put(35,T+86400);self.assertEqual(0,s['accounts'][0]['daily'][0]['deltaPp'])
        s=self.put(65,T+86460);self.assertEqual(2,len(self.alerts(s,'daily')))
    def test_drop_unknown_reset_new_segment(self):
        def send(v,n):
            a=account(v,n);a['windows'][0]['resetsAt']=None
            return self.c.ingest([a],n)
        send(10,T);send(40,T+60);send(2,T+120)
        s=send(32,T+180);self.assertEqual(2,len(self.alerts(s,'daily')))
    def test_plan_return_does_not_reuse_baseline(self):
        self.put(10);self.put(40,T+60);self.put(10,T+120,plan='q')
        s=self.put(45,T+180,plan='p');self.assertEqual(0,s['accounts'][0]['daily'][0]['deltaPp'])
    def test_jitter_near_exact_minute(self):
        a=account(10);a['windows'][0]['resetsAt']=T+604800-.4;self.c.ingest([a],T)
        b=account(40,T+60);b['windows'][0]['resetsAt']=T+604800+.4
        s=self.c.ingest([b],T+60);self.assertEqual(30,s['accounts'][0]['daily'][0]['deltaPp'])
    def test_first_high_only_highest(self):
        s=self.put(97);self.assertEqual([95],[a['threshold'] for a in self.alerts(s,'window')])
        s=self.put(98,T+60);self.assertEqual(1,len(self.alerts(s,'window')))
    def test_same_observation_not_double_saved(self):
        self.put(20);self.c.ingest([account(20)],T+10);self.assertEqual(1,len(self.c.history()))
    def test_error_preserves_without_freshness(self):
        self.put(40)
        s=self.put(None,T+60,status='error',reason='offline',accountRef='codex-unknown',windows=[])
        a=s['accounts'][0];self.assertEqual('error',a['status']);self.assertEqual(40,a['windows'][0]['usedPercent']);self.assertEqual(T,a['observedAt']);self.assertEqual('a',a['accountRef'])
    def test_expiry_materializes_top_and_account(self):
        self.put(20);s=self.c.snapshot(T+301);self.assertEqual('stale',s['status']);self.assertEqual('stale',s['accounts'][0]['status'])
        s=self.put(95,T+400,validUntil=None);self.assertEqual('unknown',s['accounts'][0]['status']);self.assertEqual([],s['alerts'])
    def test_unknown_claude_retains_last_known(self):
        self.put(81,provider='claude',accountRef='claude-fixture')
        s=self.put(None,T+60,provider='claude',accountRef='claude-fixture',status='unknown',reason='unconfirmed_live_usage',windows=[])
        a=s['accounts'][0];self.assertEqual(81,a['windows'][0]['usedPercent']);self.assertEqual('unknown',a['status']);self.assertEqual(T,a['observedAt'])
    def test_stale_no_alert(self):
        s=self.put(99,T,status='stale');self.assertEqual([],s['alerts'])
    def test_gap_and_null(self):
        self.put(10);s=self.put(45,T+700);self.assertTrue(s['accounts'][0]['daily'][0]['hasGap'])
        s=self.put(None,T+760);self.assertEqual([],s['accounts'][0]['daily'])
    def test_local_day_dst_and_old_day_not_today(self):
        before=1792882740  # bounded dates are computed in Europe/Berlin
        a=account(10,before);a['windows'][0]['resetsAt']=before+604800;self.c.ingest([a],before)
        s=self.c.snapshot(before+172800);self.assertEqual(s['accounts'][0]['daily'][0]['date'],self.c.snapshot(before)['accounts'][0]['daily'][0]['date'])
    def test_stable_snapshot_filter_export(self):
        self.c.close();path=Path(self.d.name)/'vault/snapshot.json';self.c=MonitorCore(self.d.name,host_id='h',snapshot_path=path)
        s=self.put(20);self.assertEqual(s['snapshotId'],self.c.snapshot(T+2)['snapshotId']);self.assertEqual(s['snapshotId'],json.loads(path.read_text())['snapshotId'])
        with self.assertRaises(ValueError):self.c.snapshot(T,host_id='wrong')
    def test_notifications_once_outside_ingest(self):
        class Note:
            def __init__(self):self.items=[]
            def notify(self,a):self.items.append(a);return True
        self.c.close();n=Note();self.c=MonitorCore(self.d.name,host_id='h',notifier=n)
        self.put(97);self.assertEqual([],n.items);self.c.deliver_pending();self.put(98,T+60);self.c.deliver_pending()
        self.assertEqual(1,len(n.items));self.assertEqual('submitted',self.c.snapshot(T+60)['notificationStatus'])
    def test_error_notification_persists(self):
        class Note:
            def notify(self,a):return False
        self.c.close();self.c=MonitorCore(self.d.name,host_id='h',notifier=Note());self.put(97);self.c.deliver_pending();self.put(98,T+60)
        self.assertEqual('error',self.c.snapshot(T+60)['notificationStatus'])
