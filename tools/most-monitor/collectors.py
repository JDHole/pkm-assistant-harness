"""Read-only official-client collectors. Never issue a model turn or read credential files."""
from __future__ import annotations
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import re
import subprocess
import tempfile
import threading
import time
from datetime import datetime

VERSION = '1.0.0'
FLAGS = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
CLAUDE_OVERRIDES = ('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY')

class CollectionError(Exception):
    """Safe fixed reason, never raw provider output (may include personal data)."""

def number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None

def percent(value):
    value = number(value)
    return value if value is not None and 0 <= value <= 100 else None

def alias(provider, identity, config):
    # Local pepper prevents offline guessing of account emails from synced snapshots.
    salt = config.get('identitySalt')
    if not salt:
        raise CollectionError('identity_salt_missing')
    if not identity:
        raise CollectionError('account_identity_unavailable')
    return provider + '-' + hashlib.sha256((salt + '\0' + str(identity)).encode()).hexdigest()[:20]

def base(provider):
    return dict(provider=provider, accountRef=provider+'-unknown', label='Codex / Work' if provider=='codex' else 'Claude',
        authMode='unknown', status='unknown', reason=None, source='codex-app-server' if provider=='codex' else 'claude-usage',
        observedAt=None, receivedAt=time.time(), validUntil=None, plan=None,
        coverage=['Codex / Work; bez limitów zwykłych czatów ChatGPT'] if provider=='codex' else ['Claude: wszystkie okna zwrócone przez /usage'], windows=[])

def finish(account, now):
    account.update(status='fresh', reason=None, observedAt=now, receivedAt=now,
        validUntil=min([now+300] + [w['resetsAt'] for w in account['windows'] if w.get('resetsAt') and w['resetsAt']>now]))
    if not account['windows']:
        account.update(status='unknown', reason='no_usage_windows', observedAt=None, validUntil=None)
    return account

def error(account, exc):
    reason = str(exc) if isinstance(exc, CollectionError) else ('timeout' if isinstance(exc, (TimeoutError, subprocess.TimeoutExpired, queue.Empty)) else 'collector_failed')
    status = 'auth_required' if reason=='login_required' else 'unsupported' if reason in ('not_subscription','claude_version_requires_2_1_277','provider_override') else 'unknown' if reason=='unconfirmed_live_usage' else 'error'
    account.update(status=status, reason=reason, receivedAt=time.time(), validUntil=None)
    return account

class Rpc:
    def __init__(self, path, cwd, timeout=30):
        self.deadline=time.monotonic()+timeout
        self.q=queue.Queue()
        self.p=subprocess.Popen([str(path),'app-server','--stdio'], cwd=cwd, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,encoding='utf-8',errors='replace',creationflags=FLAGS)
        self.thread=threading.Thread(target=self._read,daemon=True)
        self.thread.start()
        self.seq=0
    def _read(self):
        try:
            for line in self.p.stdout:
                try:self.q.put(json.loads(line))
                except ValueError:pass
        finally:self.q.put(None)
    def send(self, payload):
        self.p.stdin.write(json.dumps(payload)+'\n');self.p.stdin.flush()
    def call(self, method, params):
        self.seq+=1
        self.send(dict(id=self.seq,method=method,params=params))
        while True:
            remaining=self.deadline-time.monotonic()
            if remaining<=0:raise CollectionError('timeout')
            result=self.q.get(timeout=remaining)
            if result is None:raise CollectionError('client_exited')
            if result.get('id')!=self.seq:continue
            if 'error' in result:
                # Do not persist messages: backend errors can contain account data.
                code=result['error'].get('code')
                raise CollectionError('rate_limited' if code==429 else 'usage_fetch_failed')
            return result.get('result',{})
    def close(self):
        if self.p.poll() is None:
            self.p.terminate()
            try:self.p.wait(timeout=3)
            except subprocess.TimeoutExpired:self.p.kill();self.p.wait(timeout=3)
        self.thread.join(timeout=1)
        for stream in (self.p.stdin,self.p.stdout):
            if stream:stream.close()

def parse_codex(payload, auth, config, now):
    a=base('codex')
    if auth.get('type')!='chatgpt':raise CollectionError('not_subscription' if auth else 'login_required')
    a.update(accountRef=alias('codex',payload.get('accountId'),config),authMode='subscription',plan=auth.get('planType'))
    buckets=payload.get('rateLimitsByLimitId')
    if not isinstance(buckets,dict) or not buckets:
        legacy=payload.get('rateLimits')
        buckets={(legacy or {}).get('limitId') or 'codex':legacy} if isinstance(legacy,dict) else {}
    for key,bucket in buckets.items():
        if not isinstance(bucket,dict):continue
        pool=bucket.get('limitId') or str(key)
        for slot in ('primary','secondary'):
            raw=bucket.get(slot)
            if not isinstance(raw,dict):continue
            mins=number(raw.get('windowDurationMins'))
            if mins is not None and mins<=0:continue
            used=percent(raw.get('usedPercent'))
            scope={'limitId':pool}
            if bucket.get('normalModelSlug'):scope['modelSlug']=bucket['normalModelSlug']
            a['windows'].append(dict(poolId=pool,windowId=slot,label=bucket.get('limitName') or ('Tydzień' if mins==10080 else str(int(mins/60))+' h' if mins and mins%60==0 else slot),
                scope=scope,windowKind='unknown',windowMinutes=mins,metricKind='usage_percent',unit='percent',value=used,usedPercent=used,resetsAt=number(raw.get('resetsAt'))))
    # Backend permission is authoritative and not inferred from percentage.
    a['ordinaryUsageAllowed']=payload.get('ordinaryUsageAllowed') if isinstance(payload.get('ordinaryUsageAllowed'),bool) else None
    return finish(a,now)

def collect_codex(config):
    a=base('codex');rpc=None
    try:
        rpc=Rpc(config['codexPath'],config['dataDir'])
        rpc.call('initialize',{'clientInfo':{'name':'most-monitor','version':VERSION},'capabilities':{'experimentalApi':True}})
        rpc.send({'method':'initialized'})
        auth=rpc.call('account/read',{'refreshToken':False}).get('account') or {}
        if auth.get('type')!='chatgpt':raise CollectionError('not_subscription' if auth else 'login_required')
        usage=rpc.call('account/rateLimits/read',{})
        # Re-read auth to catch a login/plan change during collection.
        after=rpc.call('account/read',{'refreshToken':False}).get('account') or {}
        if after!=auth:raise CollectionError('account_changed_during_read')
        return parse_codex(usage,auth,config,time.time())
    except Exception as exc:return error(a,exc)
    finally:
        if rpc:rpc.close()

def _run(args, config, deadline):
    left=deadline-time.monotonic()
    if left<=0:raise CollectionError('timeout')
    r=subprocess.run([str(config['claudePath']),*args],cwd=config['dataDir'],capture_output=True,text=True,
        encoding='utf-8',errors='replace',timeout=left,creationflags=FLAGS)
    if r.returncode:raise CollectionError('client_exited')
    return r.stdout

def _confirmed_live_usage_debug(raw):
    """Accept only a usage endpoint HTTP 200 logged after its GET in this invocation."""
    requested=False
    for line in raw.splitlines():
        if re.search(r'fetchUtilization: GET /api/oauth/usage \(attempt \d+\)\s*$',line):
            requested=True
        elif requested and re.search(r'fetchUtilization: 200 after \d+ attempt\(s\)\s*$',line):
            return True
    return False

def _run_usage(config, deadline):
    # Claude 2.1.278 can attach cached rows even when every network request fails.
    # A unique debug log lets us require the current invocation's endpoint HTTP 200.
    fd,path=tempfile.mkstemp(prefix='claude-usage-',suffix='.log',dir=config['dataDir'])
    os.close(fd)
    try:
        output=_run(['--debug','api','--debug-file',path,'--safe-mode','--strict-mcp-config','--tools','',
            '--no-session-persistence','-p','/usage','--output-format','stream-json','--verbose','--max-turns','1'],config,deadline)
        try:debug=Path(path).read_text(encoding='utf-8',errors='replace')
        except OSError:raise CollectionError('unconfirmed_live_usage')
        if not _confirmed_live_usage_debug(debug):raise CollectionError('unconfirmed_live_usage')
        return output
    finally:
        try:os.remove(path)
        except OSError:pass

def parse_claude(events, auth, config, now, live_confirmed=False):
    a=base('claude')
    if auth.get('loggedIn') is not True:raise CollectionError('login_required')
    if auth.get('authMethod')!='claude.ai' or auth.get('apiProvider')!='firstParty':raise CollectionError('not_subscription')
    identity=(auth.get('email') or '').strip().lower()+'\0'+str(auth.get('orgId') or '')
    if not auth.get('email'):raise CollectionError('account_identity_unavailable')
    a.update(accountRef=alias('claude',identity,config),authMode='subscription',plan=auth.get('subscriptionType'))
    init=next((e for e in events if e.get('type')=='system' and e.get('subtype')=='init'),{})
    version=tuple(int(n) for n in re.findall(r'\d+',init.get('claude_code_version',''))[:3])
    if version < (2,1,277):raise CollectionError('claude_version_requires_2_1_277')
    results=[e for e in events if e.get('type')=='result']
    if len(results)!=1:raise CollectionError('usage_result_missing')
    result=results[0]
    if result.get('subtype')!='success' or result.get('local_command')!='usage' or result.get('num_turns')!=0 or result.get('total_cost_usd')!=0:
        raise CollectionError('nonlocal_usage_result')
    usage=result.get('usage',{})
    if any(usage.get(k,0)!=0 for k in ('input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens')):
        raise CollectionError('nonzero_usage_tokens')
    reports=[e['usage_report'] for e in events if e.get('type')=='assistant'
        and e.get('local_command_run')=={'command':'usage','args':''} and isinstance(e.get('usage_report'),dict)]
    if len(reports)!=1:raise CollectionError('usage_result_missing')
    if not live_confirmed:raise CollectionError('unconfirmed_live_usage')
    rows=(reports[0].get('rate_limits',{}).get('limits') or [])
    if not rows:raise CollectionError('usage_fetch_failed')
    for raw in rows:
        # >=2.1.277 emits these only from a live server response, never cache.
        if 'severity' not in raw or not isinstance(raw.get('is_active'),bool):raise CollectionError('unconfirmed_live_usage')
        kind=raw.get('kind','unknown');scope=raw.get('scope') or {}
        if not isinstance(scope,dict):scope={'unknown':scope}
        suffix=hashlib.sha256(json.dumps(scope,sort_keys=True).encode()).hexdigest()[:12]
        model=scope.get('model')
        name=model.get('display_name') if isinstance(model,dict) else None
        mins=10080 if raw.get('group')=='weekly' else 300 if kind=='session' else None
        label=name or ('Tydzień ogólny' if kind=='weekly_all' else 'Sesja' if kind=='session' else kind)
        try:reset=datetime.fromisoformat(raw['resets_at'].replace('Z','+00:00')).timestamp() if raw.get('resets_at') else None
        except (TypeError,ValueError):reset=None
        used=percent(raw.get('percent'))
        a['windows'].append(dict(poolId='claude-plan',windowId=kind+'-'+suffix,label=label,scope=scope,
            windowKind='unknown',windowMinutes=mins,metricKind='usage_percent',unit='percent',value=used,usedPercent=used,resetsAt=reset))
    return finish(a,now)

def collect_claude(config):
    a=base('claude');deadline=time.monotonic()+38
    try:
        if any(os.environ.get(k) for k in CLAUDE_OVERRIDES):raise CollectionError('provider_override')
        auth=json.loads(_run(['auth','status','--json'],config,deadline))
        if auth.get('loggedIn') is not True:raise CollectionError('login_required')
        if auth.get('authMethod')!='claude.ai' or auth.get('apiProvider')!='firstParty':raise CollectionError('not_subscription')
        a['accountRef']=alias('claude',(auth.get('email') or '').strip().lower()+'\0'+str(auth.get('orgId') or ''),config)
        version=tuple(int(n) for n in re.findall(r'\d+',_run(['--version'],config,deadline))[:3])
        if version < (2,1,277):raise CollectionError('claude_version_requires_2_1_277')
        # Builtin command, safe mode disables hooks/skills/plugins. No project context.
        output=_run_usage(config,deadline)
        events=[]
        for line in output.splitlines():
            try:events.append(json.loads(line))
            except ValueError:pass
        after=json.loads(_run(['auth','status','--json'],config,deadline))
        if any(auth.get(k)!=after.get(k) for k in ('loggedIn','email','orgId','authMethod','apiProvider','subscriptionType')):raise CollectionError('account_changed_during_read')
        return parse_claude(events,auth,config,time.time(),live_confirmed=True)
    except Exception as exc:return error(a,exc)
