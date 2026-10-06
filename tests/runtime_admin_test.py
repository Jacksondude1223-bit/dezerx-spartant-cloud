import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cloud_admin', Path(__file__).resolve().parents[1] / 'runtime/create-admin.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
admin = {'displayName': 'Customer Owner', 'email': 'owner@example.test', 'password': 'My-chosen-password!'}


class AdminTests(unittest.TestCase):
    def test_real_pty_drives_hidden_password_confirmation_and_superadmin_choice(self):
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / 'php'
            script.write_text('''#!/usr/bin/env python3
import sys, termios
answers=[]
for prompt in ['Enter display name:', 'Enter email:', 'Enter password (hidden):', 'Confirm password (hidden):', 'Select role [user]:\\n [0] user\\n [1] admin\\n [2] superadmin']:
    if 'password' in prompt.lower():
        attrs=termios.tcgetattr(sys.stdin.fileno())
        attrs[3] &= ~termios.ECHO
        termios.tcsetattr(sys.stdin.fileno(),termios.TCSANOW,attrs)
    print(prompt, flush=True)
    answers.append(input('> '))
sys.exit(0 if answers == ['Customer Owner', 'owner@example.test', 'My-chosen-password!', 'My-chosen-password!', '2'] else 1)
''')
            script.chmod(0o755)
            with patch.dict(os.environ, {'PATH': directory + ':' + os.environ['PATH']}):
                self.assertTrue(module.create(admin))

    def test_retry_detects_existing_matching_superadmin_without_running_command(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(module, 'state', return_value=10), patch.object(module, 'create') as create:
                self.assertEqual(module.bootstrap(admin, directory), 0)
                self.assertEqual(module.bootstrap(admin, directory), 0)
                create.assert_not_called()
            marker = (Path(directory) / '.cloud-first-user-created').read_text()
            self.assertNotIn(admin['password'], marker)
            self.assertIn('superadmin', marker)

    def test_conflict_and_failed_creation_do_not_mark_complete(self):
        for code, created in [(20, True), (0, False)]:
            with tempfile.TemporaryDirectory() as directory:
                with patch.object(module, 'state', return_value=code), patch.object(module, 'create', return_value=created):
                    self.assertEqual(module.bootstrap(admin, directory), 1)
                    self.assertFalse((Path(directory) / '.cloud-first-user-created').exists())

    def test_success_requires_superadmin_verification_after_command(self):
        for verified, expected in [(10, 0), (0, 1), (20, 1)]:
            with tempfile.TemporaryDirectory() as directory:
                with patch.object(module, 'state', side_effect=[0, verified]), patch.object(module, 'create', return_value=True):
                    self.assertEqual(module.bootstrap(admin, directory), expected)


if __name__ == '__main__':
    unittest.main()
