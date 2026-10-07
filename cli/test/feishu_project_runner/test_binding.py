import importlib.util
import json
import pathlib
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2] / 'skills' / 'feishu-project-runner'

class BindingTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('binding', ROOT / 'scripts/check_binding.py')
        self.binding = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.binding)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.workspace = pathlib.Path(self.tmp.name)
        (self.workspace / '.feishu-project-runner').mkdir()
        self.config = {'workspace': str(self.workspace), 'branch_id': 'team', 'owner_open_id': 'me', 'chat_id': 'group', 'schedule': {'enabled': True}}
        self.path = self.workspace / '.feishu-project-runner/config.json'
        self.path.write_text(json.dumps(self.config))

    def check(self):
        return self.binding.check_binding(str(self.workspace), 'team', 'me', 'group', automatic=True)

    def test_real_branch_configuration_passes(self):
        self.assertEqual(self.check()['branch_id'], 'team')

    def test_missing_configuration_fails(self):
        self.path.unlink()
        with self.assertRaises(FileNotFoundError): self.check()

    def test_wrong_workspace_branch_identity_or_chat_fails(self):
        for key in ['workspace', 'branch_id', 'owner_open_id', 'chat_id']:
            value = dict(self.config, **{key: str(self.workspace.parent) if key == 'workspace' else 'wrong'})
            self.path.write_text(json.dumps(value))
            with self.assertRaises(ValueError, msg=key): self.check()

    def test_disabled_branch_does_not_automatically_execute(self):
        self.config['schedule']['enabled'] = False
        self.path.write_text(json.dumps(self.config))
        with self.assertRaises(ValueError): self.check()
