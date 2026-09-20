"""Explicit local deployment with per-file backups. Never restarts applications."""
import argparse,hashlib,json,os,secrets,shutil,socket,time,re
from pathlib import Path

def register_notifications():
    if os.name != 'nt':return
    import winreg
    # Register only this application's identity. Never change global/user notification settings.
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER,r'Software\Classes\AppUserModelId\JDHole.MostMonitor') as key:
        winreg.SetValueEx(key,'DisplayName',0,winreg.REG_SZ,'Most Monitor')
        winreg.SetValueEx(key,'ShowInSettings',0,winreg.REG_DWORD,1)

def install(vault, destination, codex, claude, pythonw):
    src=Path(__file__).resolve().parent
    vault=Path(vault).resolve();dest=Path(destination).resolve()
    if dest == vault or vault in dest.parents or dest in vault.parents or dest == src or src in dest.parents or dest in src.parents:
        raise ValueError('Private runtime must stay outside vault and source repository')
    if not (vault/'.obsidian/plugins/most-status/manifest.json').is_file():raise ValueError('Expected existing Most Status vault')
    required=['monitor.py','core.py','collectors.py','notifier.py','zoneinfo/Europe/Berlin',
        'build/main.js','ui/styles.css','ui/manifest.json','ui/monitor_core.js','home/pulpit_core.js','home/pulpit_kafle.js','home/widgetHome.js']
    if any(not (src/name).is_file() for name in required):raise ValueError('Deployment sources incomplete')
    for exe in (codex,claude,pythonw):
        if not Path(exe).is_file():raise ValueError('Missing runtime executable')
    config_path=dest/'config.json'
    config=json.loads(config_path.read_text(encoding='utf-8')) if config_path.exists() else {'identitySalt':secrets.token_hex(32)}
    if not isinstance(config,dict) or not isinstance(config.get('identitySalt'),str) or not re.fullmatch(r'[0-9a-fA-F]{64}',config['identitySalt']):
        raise ValueError('Existing config needs a valid private identitySalt')
    vendor=dest/'vendor'/'claude-2.1.278.exe'
    config.update(dataDir=str(dest/'state'),snapshotPath=str(vault/'99_System/State/subscription-usage.json'),
        codexPath=str(Path(codex).resolve()),claudePath=str(vendor),port=1236)
    config.setdefault('pollSeconds',300);config.setdefault('notifications',True)
    config.setdefault('hostId','host-'+hashlib.sha256((config['identitySalt']+socket.gethostname()).encode()).hexdigest()[:16])
    stamp=time.strftime('%Y%m%d-%H%M%S')
    backup=vault/'90_Archiwum'/('monitor-deploy-'+stamp)
    dest.mkdir(parents=True,exist_ok=True);backup.mkdir(parents=True)
    manifest=[]
    def copy(source,target,label):
        target=Path(target);target.parent.mkdir(parents=True,exist_ok=True)
        if target.exists():
            old=backup/label;old.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(target,old)
        shutil.copy2(source,target)
        manifest.append({'path':str(target),'sha256':hashlib.sha256(target.read_bytes()).hexdigest()})
    for name in ('monitor.py','core.py','collectors.py','notifier.py'):
        copy(src/name,dest/name,'runtime/'+name)
    for zone in (src/'zoneinfo').rglob('*'):
        if zone.is_file():copy(zone,dest/'zoneinfo'/zone.relative_to(src/'zoneinfo'),'runtime/zoneinfo/'+str(zone.relative_to(src/'zoneinfo')))
    copy(claude,vendor,'runtime/vendor/claude-2.1.278.exe')
    if config_path.exists():
        # Local identity pepper never goes into the synced vault backup.
        shutil.copy2(config_path,dest/('config.backup-'+stamp+'.json'))
    (dest/'state').mkdir(exist_ok=True)
    config_path.write_text(json.dumps(config,indent=2),encoding='utf-8')
    copy(src/'build/main.js',vault/'.obsidian/plugins/most-status/main.js','plugin/main.js')
    for name in ('styles.css','manifest.json','monitor_core.js'):
        copy(src/'ui'/name,vault/'.obsidian/plugins/most-status'/name,'plugin/'+name)
    for name in ('pulpit_core.js','pulpit_kafle.js'):
        copy(src/'home'/name,vault/'99_System/Scripts/components/home'/name,'home/'+name)
    copy(src/'home/widgetHome.js',vault/'99_System/Scripts/views/widgetHome.js','home/widgetHome.js')
    startup=Path(os.environ['APPDATA'])/'Microsoft/Windows/Start Menu/Programs/Startup/Most-Monitor.vbs'
    command='"'+str(Path(pythonw).resolve())+'" "'+str(dest/'monitor.py')+'" serve'
    vbs='Set shell = CreateObject("WScript.Shell")\nshell.Run "'+command.replace('"','""')+'", 0, False\n'
    staged=dest/'Start-Most-Monitor.vbs';staged.write_text(vbs,encoding='utf-8')
    copy(staged,startup,'startup/Most-Monitor.vbs')
    register_notifications()
    (backup/'deployed-manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    print(json.dumps({'installed':True,'destination':str(dest),'backup':str(backup),'files':len(manifest),'started':False}))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--vault',required=True);p.add_argument('--destination',required=True)
    p.add_argument('--codex',required=True);p.add_argument('--claude',required=True);p.add_argument('--pythonw',required=True)
    a=p.parse_args();install(a.vault,a.destination,a.codex,a.claude,a.pythonw)
