import json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import install_local

class InstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.src=self.root/'source';self.vault=self.root/'vault';self.dest=self.root/'private runtime'
        for n in ['monitor.py','core.py','collectors.py','notifier.py','zoneinfo/Europe/Berlin','build/main.js','ui/styles.css','ui/manifest.json','ui/monitor_core.js','home/pulpit_core.js','home/pulpit_kafle.js','home/widgetHome.js']:
            p=self.src/n;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('new',encoding='utf-8')
        self.manifest=self.vault/'.obsidian/plugins/most-status/manifest.json';self.manifest.parent.mkdir(parents=True);self.manifest.write_text('old')
        self.exe=self.root/'some exe.exe';self.exe.write_bytes(b'fixture')
        self.env=patch.dict('os.environ',{'APPDATA':str(self.root/'appdata')});self.env.start()
        self.source=patch.object(install_local,'__file__',str(self.src/'install_local.py'));self.source.start()
        self.registration=patch.object(install_local,'register_notifications');self.registration.start()
    def tearDown(self):self.registration.stop();self.source.stop();self.env.stop();self.tmp.cleanup()
    def install(self,dest=None):
        with patch('builtins.print'):install_local.install(self.vault,dest or self.dest,self.exe,self.exe,self.exe)
    def test_private_runtime_rejected_inside_vault(self):
        with self.assertRaises(ValueError):self.install(self.vault/'private')
        self.assertEqual('old',self.manifest.read_text())
    def test_corrupt_config_no_target_mutation(self):
        self.dest.mkdir();(self.dest/'config.json').write_text('{broken');(self.dest/'core.py').write_text('old')
        with self.assertRaises(json.JSONDecodeError):self.install()
        self.assertEqual('old',(self.dest/'core.py').read_text());self.assertEqual('old',self.manifest.read_text())
        self.assertFalse((self.vault/'90_Archiwum').exists())
    def test_missing_salt_no_target_mutation(self):
        self.dest.mkdir();(self.dest/'config.json').write_text('{}')
        with self.assertRaises(ValueError):self.install()
        self.assertFalse((self.dest/'core.py').exists())
    def test_placeholder_salt_no_mutation(self):
        self.dest.mkdir();(self.dest/'config.json').write_text(json.dumps({'identitySalt':'GENERATE_LOCAL_RANDOM_32_BYTES_DO_NOT_SYNC'}))
        with self.assertRaises(ValueError):self.install()
        self.assertFalse((self.dest/'core.py').exists())
    def test_runtime_ancestor_rejected(self):
        with self.assertRaises(ValueError):self.install(self.root)
        self.assertEqual('old',self.manifest.read_text())
    def test_backup_quotes_zoneinfo_and_private_salt(self):
        self.install()
        backup=list((self.vault/'90_Archiwum').glob('monitor-deploy-*'))[0]
        self.assertEqual('old',(backup/'plugin/manifest.json').read_text())
        self.assertTrue((self.dest/'zoneinfo/Europe/Berlin').exists())
        vbs=(self.dest/'Start-Most-Monitor.vbs').read_text()
        self.assertIn('""'+str(self.exe)+'""',vbs);self.assertIn(', 0, False',vbs)
        salt=json.loads((self.dest/'config.json').read_text())['identitySalt']
        for p in self.vault.rglob('*'):
            if p.is_file():self.assertNotIn(salt,p.read_text(errors='replace'))
    def test_no_process_restart_code(self):
        # Install only copies artifacts and emits a launcher; executing is separate.
        import inspect
        source=inspect.getsource(install_local.install)
        self.assertNotIn('Popen(',source);self.assertNotIn('subprocess.run(',source)
