import hashlib,json,tempfile,unittest
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
        self.home=self.vault/'99_System/Scripts/views/widgetHome.js'
        self.home.parent.mkdir(parents=True)
        self.stop='    if (siatkaPulpitu) { try { siatkaPulpitu.stop(); } catch (_) { /* nic */ } siatkaPulpitu = null; }\n'
        self.cleanup='    WU.sprzataj(contentContainer);\n'
        self.before='async function refreshContent() {\n'+self.stop+'    // cleanup\n'+self.cleanup+'}\nreturn {\nstop: () => {\n'+self.stop+self.cleanup+'}\n};\n'
        self.home.write_text(self.before,encoding='utf-8')
        for name in ('pulpit_core.js','pulpit_kafle.js'):
            target=self.vault/'99_System/Scripts/components/home'/name
            target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(b'old')
        (self.src/'home/baseline-hashes.json').write_text(json.dumps({name:hashlib.sha256(b'old').hexdigest() for name in ('pulpit_core.js','pulpit_kafle.js')}))
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
    def test_install_preserves_independent_banner_change(self):
        current='const BANERY = require("new-banner.js");\n'+self.before
        self.home.write_text(current,encoding='utf-8')
        self.install()
        merged=self.home.read_text(encoding='utf-8')
        self.assertIn('const BANERY = require("new-banner.js");',merged)
        self.assertEqual(2,merged.count(self.cleanup))
        for block in merged.split('function ')[1:]:
            self.assertLess(block.index('WU.sprzataj'),block.index('siatkaPulpitu.stop'))
    def test_unrecognized_home_fails_before_mutation(self):
        self.home.write_text('new home without known lifecycle',encoding='utf-8')
        with self.assertRaises(ValueError):self.install()
        self.assertFalse(self.dest.exists());self.assertEqual('old',self.manifest.read_text())
    def test_concurrent_pulpit_change_fails_before_mutation(self):
        (self.vault/'99_System/Scripts/components/home/pulpit_core.js').write_text('someone elses change')
        with self.assertRaises(ValueError):self.install()
        self.assertFalse(self.dest.exists());self.assertEqual('old',self.manifest.read_text())
    def test_cleanup_idempotent_and_crlf_preserved(self):
        before=('// unrelated banner\n'+self.before).replace('\n','\r\n').encode()
        after=install_local.patch_home_cleanup(before)
        self.assertEqual(after,install_local.patch_home_cleanup(after))
        self.assertEqual(before.count(b'\r\n'),after.count(b'\r\n'))
        self.assertNotIn(b'\n',after.replace(b'\r\n',b''))
        self.assertTrue(after.startswith(b'// unrelated banner\r\n'))
    def test_unknown_executable_between_cleanup_and_stop_is_rejected(self):
        raw=self.before.replace('    // cleanup\n','    otherOperation();\n').encode()
        with self.assertRaises(ValueError):install_local.patch_home_cleanup(raw)
    def test_two_pairs_in_one_lifecycle_scope_are_rejected(self):
        raw=('async function refreshContent() {\n'+(self.cleanup+self.stop)*2+'}\nreturn {\nstop: () => {\n}\n};\n').encode()
        with self.assertRaises(ValueError):install_local.patch_home_cleanup(raw)
    def test_two_separated_pairs_in_refresh_and_zero_in_stop_are_rejected(self):
        raw=('async function refreshContent() {\n'+self.cleanup+self.stop+'    other();\n'+self.cleanup+self.stop+'}\nreturn {\nstop: () => {\n}\n};\n').encode()
        with self.assertRaisesRegex(ValueError,'scope changed'):install_local.patch_home_cleanup(raw)
