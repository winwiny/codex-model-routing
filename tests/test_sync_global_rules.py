import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / 'scripts' / 'sync_global_rules.py'
SPEC = importlib.util.spec_from_file_location('sync_global_rules', SCRIPT)
sync = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(sync)
BEGIN = sync.BEGIN
END = sync.END

BLOCK = '''<!-- model-task-routing:begin -->
## Codex / Jev / 代码分工
托管规则。
<!-- model-task-routing:end -->
'''


class SyncGlobalRulesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.rules = self.root / 'global-routing.md'
        self.rules.write_text(BLOCK, encoding='utf-8')
        self.previous = sync.RULES_PATH
        sync.RULES_PATH = self.rules

    def tearDown(self):
        sync.RULES_PATH = self.previous
        self.temp.cleanup()

    def invoke(self, *args):
        return sync.run(list(args), env={})

    def test_default_preview_does_not_write(self):
        home = self.root / 'home'
        out = self.invoke('--user-home', str(home))
        self.assertEqual(out['status'], 'preview')
        self.assertFalse(home.exists())

    def test_apply_is_idempotent(self):
        home = self.root / 'home'
        args = ('--user-home', str(home), '--apply')
        self.assertEqual(self.invoke(*args)['status'], 'applied')
        self.assertEqual(self.invoke(*args)['status'], 'nochange')

    def test_preserves_bom_crlf_and_surrounding_bytes(self):
        home = self.root / 'home'
        target = home / '.codex' / 'AGENTS.md'
        target.parent.mkdir(parents=True)
        old = '\ufeff前缀\r\n后缀\r\n'.encode('utf-8')
        target.write_bytes(old)
        self.invoke('--user-home', str(home), '--apply')
        data = target.read_bytes()
        self.assertTrue(data.startswith(old))
        self.assertIn(BEGIN.encode(), data)
        self.assertNotIn(b'\n', data.replace(b'\r\n', b''))

    def test_override_preferred_and_empty_override_falls_back(self):
        home = self.root / 'home'
        codex = home / '.codex'
        codex.mkdir(parents=True)
        (codex / 'AGENTS.override.md').write_text('x', encoding='utf-8')
        self.assertTrue(self.invoke('--user-home', str(home))['path'].endswith('AGENTS.override.md'))
        (codex / 'AGENTS.override.md').write_text('', encoding='utf-8')
        self.assertTrue(self.invoke('--user-home', str(home))['path'].endswith('AGENTS.md'))
        (codex / 'AGENTS.override.md').write_text('\ufeff \r\n', encoding='utf-8')
        self.assertTrue(self.invoke('--user-home', str(home))['path'].endswith('AGENTS.md'))

    def test_explicit_codex_home_environment_beats_user_home(self):
        env_home = self.root / 'configured-codex-home'
        out = sync.run(['--user-home', str(self.root / 'other-home')], env={'CODEX_HOME': str(env_home)})
        self.assertEqual(Path(out['path']), env_home / 'AGENTS.md')

    def test_existing_file_gets_backup_and_new_file_gets_written(self):
        home = self.root / 'home'
        target = home / '.codex' / 'AGENTS.md'
        target.parent.mkdir(parents=True)
        target.write_text('old', encoding='utf-8')
        self.assertEqual(self.invoke('--user-home', str(home), '--apply')['status'], 'applied')
        backups = list(target.parent.glob('AGENTS.md.backup.*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(encoding='utf-8'), 'old')
        fresh = self.root / 'fresh'
        self.assertEqual(self.invoke('--user-home', str(fresh), '--apply')['status'], 'applied')

    def test_corrupt_duplicate_and_reversed_markers_refused(self):
        home = self.root / 'home'
        target = home / '.codex' / 'AGENTS.md'
        target.parent.mkdir(parents=True)
        for content in (BEGIN, BEGIN + '\n' + END + '\n' + END, END + '\n' + BEGIN):
            target.write_text(content, encoding='utf-8')
            self.assertEqual(self.invoke('--user-home', str(home))['status'], 'managed_marker_corrupt')

    def test_inline_markers_are_refused(self):
        home = self.root / 'home'
        target = home / '.codex' / 'AGENTS.md'
        target.parent.mkdir(parents=True)
        target.write_text('x' + BEGIN + '\nbody\n' + END + 'x', encoding='utf-8')
        self.assertEqual(self.invoke('--user-home', str(home))['status'], 'managed_marker_corrupt')

    def test_old_manual_heading_refused(self):
        home = self.root / 'home'
        target = home / '.codex' / 'AGENTS.md'
        target.parent.mkdir(parents=True)
        target.write_text('## Codex / Jev / 代码分工\nold', encoding='utf-8')
        self.assertEqual(self.invoke('--user-home', str(home))['status'], 'unmanaged_rules_needs_merge')

    def test_antigravity_capacity_refused(self):
        self.rules.write_text(BLOCK + ('x' * 12000), encoding='utf-8')
        out = self.invoke('--client', 'antigravity', '--user-home', str(self.root / 'home'))
        self.assertEqual(out['status'], 'antigravity_size_limit')

    def test_accio_path_rules(self):
        self.assertEqual(self.invoke('--client', 'accio-work')['status'], 'needs_agent_path')
        core = self.root / 'agent-core'
        core.mkdir()
        target = core / 'AGENTS.md'
        target.write_text('host rules', encoding='utf-8')
        out = self.invoke('--client', 'accio-work', '--agent-core', str(core), '--apply')
        self.assertEqual(out['status'], 'applied')
        self.assertIn(BEGIN, target.read_text(encoding='utf-8'))

    def test_export_never_overwrites_different_content(self):
        export = self.root / 'export.md'
        self.assertEqual(self.invoke('--client', 'accio-work', '--export', str(export))['status'], 'exported')
        self.assertEqual(self.invoke('--client', 'accio-work', '--export', str(export))['status'], 'nochange')
        export.write_text('other', encoding='utf-8')
        self.assertEqual(self.invoke('--client', 'accio-work', '--export', str(export))['status'], 'export_exists_different')


if __name__ == '__main__':
    unittest.main()
