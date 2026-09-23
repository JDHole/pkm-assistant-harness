"""Windows toast, submitted locally without Obsidian. Never evaluates alert text as code."""
import base64
import json
import os
import subprocess

LAST_STATUS = 'not_attempted'

SCRIPT = r'''
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$title = [System.Security.SecurityElement]::Escape([string]$payload.title)
$message = [System.Security.SecurityElement]::Escape([string]$payload.message)
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>' + $title + '</text><text>' + $message + '</text></binding></visual></toast>')
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$toast.ExpirationTime = [DateTimeOffset]::Now.AddMinutes(30)
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('JDHole.MostMonitor')
if ($notifier.Setting -ne [Windows.UI.Notifications.NotificationSetting]::Enabled) { Write-Output ('blocked:' + $notifier.Setting); exit 2 }
$notifier.Show($toast)
Write-Output 'submitted'
'''

def notify(alert):
    global LAST_STATUS
    if os.name != 'nt':return False
    payload={'title':'Most | limity subskrypcji', 'message':str(alert.get('message') or 'Nowe ostrzeżenie limitu')[:800]}
    try:
        result=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',
            base64.b64encode(SCRIPT.encode('utf-16-le')).decode('ascii')], input=json.dumps(payload),capture_output=True,
            text=True,encoding='utf-8',errors='replace',timeout=12,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        ok=result.returncode==0 and 'submitted' in result.stdout
        blocked=next((s.strip() for s in result.stdout.splitlines() if s.startswith('blocked:')),None)
        LAST_STATUS='submitted' if ok else blocked or 'submission_failed'
        return ok
    except (OSError,subprocess.TimeoutExpired):
        LAST_STATUS='submission_failed'
        return False
