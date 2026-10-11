import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess

spec = importlib.util.spec_from_file_location('network', 'scripts/setup-db-network.py')
network = importlib.util.module_from_spec(spec)
spec.loader.exec_module(network)


class NetworkTests(unittest.TestCase):
    def configure(self, region, routes=None):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        key = root / 'spartan-db.key'
        key.write_text('a' * 43 + '=\n')
        key.chmod(0o600)
        calls = []

        def run(*args, **kwargs):
            calls.append(args)
            if args[:3] == ('ip', '-j', '-4'):
                return subprocess.CompletedProcess(args, 0, json.dumps(routes or []))
            return subprocess.CompletedProcess(args, 1 if 'is-active' in args else 0, '')

        with patch.object(network, 'ROOT', root), patch.object(network, 'WG_ROOT', root), patch.object(network, 'run', run), patch('builtins.input', side_effect=['8.8.8.8', 'b' * 43 + '=']):
            network.configure(region)
        return (root / 'spartan-db.conf').read_text(), calls

    def test_us_database_listener_rule_is_limited_to_authenticated_peer_interface(self):
        config, calls = self.configure('us')
        self.assertIn('Address = 10.77.0.1/32', config)
        self.assertIn('AllowedIPs = 10.77.0.2/32', config)
        self.assertIn('-i spartan-db -s 10.77.0.2/32 -d 10.77.0.1/32 -p tcp --dport 3306', config)
        self.assertNotIn('AllowedIPs = 0.0.0.0/0', config)
        self.assertNotIn('FORWARD', config)

    def test_de_container_database_traffic_is_translated_to_its_vpn_address(self):
        config, calls = self.configure('de')
        self.assertIn('Address = 10.77.0.2/32', config)
        self.assertIn('AllowedIPs = 10.77.0.1/32', config)
        self.assertIn('-j SNAT --to-source 10.77.0.2', config)
        self.assertIn('FORWARD 1 -o spartan-db -d 10.77.0.1/32 -p tcp --dport 3306', config)
        self.assertNotIn('INPUT 1 -i spartan-db -s 10.77.0.1/32 -d 10.77.0.2/32 -p tcp', config)

    def test_route_collision_is_rejected_before_interface_or_firewall_changes(self):
        with self.assertRaisesRegex(RuntimeError, 'overlaps'):
            self.configure('de', [{'dst': '10.77.0.0/16', 'dev': 'docker0'}])

    def test_stale_handshake_is_not_ready(self):
        with patch.object(network, 'run', return_value=subprocess.CompletedProcess([], 0, 'peer\t0\n')):
            with self.assertRaisesRegex(RuntimeError, 'handshake'):
                network.handshake()

    def test_repeating_configure_preserves_live_interface_without_restart(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        (root / 'spartan-db.key').write_text('a' * 43 + '=\n')
        (root / 'spartan-db.key').chmod(0o600)
        calls = []
        active = False
        def run(*args, **kwargs):
            calls.append(args)
            return subprocess.CompletedProcess(args, 0 if active or 'is-active' not in args else 1, '[]')
        with patch.object(network, 'ROOT', root), patch.object(network, 'WG_ROOT', root), patch.object(network, 'run', run):
            network.configure('us', '8.8.8.8', 'b' * 43 + '=')
            original = (root / 'spartan-db.conf').read_text()
            calls.clear()
            active = True
            network.configure('us', '8.8.8.8', 'b' * 43 + '=')
            self.assertEqual((root / 'spartan-db.conf').read_text(), original)
            self.assertFalse(any('stop' in call or 'restart' in call for call in calls))

    def test_prepare_preserves_existing_private_key_and_publishes_only_public_key(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        private_key = 'a' * 43 + '=\n'
        public_key = 'b' * 43 + '=\n'
        (root / 'spartan-db.key').write_text(private_key)
        (root / 'spartan-db.key').chmod(0o600)
        with patch.object(network, 'WG_ROOT', root), patch.object(network, 'run') as run, patch.object(network.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, public_key)) as process:
            network.prepare()
            self.assertEqual((root / 'spartan-db.key').read_text(), private_key)
            self.assertEqual((root / 'spartan-db.pub').read_text(), public_key)
            self.assertFalse(any(call.args[:2] == ('wg', 'genkey') for call in run.call_args_list))
            self.assertEqual(process.call_args.kwargs['input'], private_key)

    def auto_case(self, region='us', records=None, key='b' * 43 + '=', pinned=None, primary=None, mode='local'):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        data = root / 'data'
        data.mkdir()
        for index, record in enumerate(records or []):
            folder = data / ('t-' + str(index))
            folder.mkdir()
            (folder / 'state.json').write_text(json.dumps(record))
        (root / 'database-network.json').write_text(json.dumps({'region': region, 'peerIp': '8.8.8.8', 'publicKey': pinned}))
        env = {'NODE_REGION': region, 'DATABASE_MODE': mode, 'DATA_ROOT': str(data), 'US_ORIGIN': 'https://node-us.example.com', 'ORIGIN_SECRET': 's' * 64}
        response = unittest.mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(primary or {}).encode()
        with patch.object(network, 'ROOT', root), patch.object(network, 'env_read', return_value=env), patch.object(network, 'peer_key', side_effect=key if isinstance(key, Exception) else None, return_value=key) as discovery, patch.object(network, 'configure') as configure, patch.object(network, 'handshake'), patch.object(network, 'guarded_activate') as activate, patch.object(network, 'run') as run, patch.object(network, 'health', return_value={'status': 'ready', 'databaseReady': True}), patch.object(network.urllib.request, 'build_opener') as opener:
            opener.return_value.open.return_value = response
            network.automatic(region)
            return discovery, configure, activate, run

    def test_first_node_waits_without_database_changes_when_peer_not_installed(self):
        discovery, configure, activate, run = self.auto_case(key=OSError('offline'))
        discovery.assert_called_once()
        configure.assert_not_called()
        activate.assert_not_called()
        run.assert_not_called()

    def test_existing_instances_never_activate_automatically(self):
        discovery, configure, activate, run = self.auto_case(records=[{'primary': 'us', 'status': 'ready'}])
        discovery.assert_not_called()
        configure.assert_not_called()
        activate.assert_not_called()
        run.assert_called_once_with('systemctl', 'disable', '--now', 'spartan-db-network.timer')

    def test_peer_rotation_is_rejected_before_network_changes(self):
        with self.assertRaisesRegex(RuntimeError, 'public key changed'):
            self.auto_case(pinned='c' * 43 + '=')

    def test_fresh_us_activates_with_empty_instance_guard(self):
        discovery, configure, activate, run = self.auto_case()
        configure.assert_called_once_with('us', '8.8.8.8', 'b' * 43 + '=')
        activate.assert_called_once_with('us', fresh_only=True)

    def test_de_waits_for_us_database_before_stopping_local_database(self):
        discovery, configure, activate, run = self.auto_case(region='de', primary={'region': 'us', 'status': 'ready', 'databaseMode': 'local'})
        configure.assert_called_once()
        activate.assert_not_called()

    def test_de_activates_only_after_us_database_ready(self):
        discovery, configure, activate, run = self.auto_case(region='de', primary={'region': 'us', 'status': 'ready', 'databaseMode': 'us-central'})
        activate.assert_called_once_with('de', fresh_only=True)

    def test_completed_setup_never_restarts_database_or_changes_keys(self):
        discovery, configure, activate, run = self.auto_case(mode='us-central')
        discovery.assert_not_called()
        configure.assert_not_called()
        activate.assert_not_called()
        run.assert_called_once_with('systemctl', 'disable', '--now', 'spartan-db-network.timer')

    def test_peer_discovery_is_signed_https_without_redirects_or_private_key(self):
        public_key = 'b' * 43 + '='
        response = unittest.mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({'region': 'de', 'publicKey': public_key}).encode()
        env = {'DE_ORIGIN': 'https://node-de.example.com', 'ORIGIN_SECRET': 's' * 64}
        with patch.object(network.urllib.request, 'build_opener') as opener:
            opener.return_value.open.return_value = response
            self.assertEqual(network.peer_key(env, 'us'), public_key)
            request = opener.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url, 'https://node-de.example.com/control/network/key')
            self.assertEqual(request.data, b'{}')
            stamp = request.get_header('X-spartan-timestamp')
            expected = network.hmac.new(env['ORIGIN_SECRET'].encode(), (stamp + '\nPOST\n/control/network/key\n{}').encode(), network.hashlib.sha256).hexdigest()
            self.assertEqual(request.get_header('X-spartan-signature'), expected)
            self.assertIsInstance(opener.call_args.args[0], network.NoRedirect)
            response.__enter__.return_value.read.return_value = json.dumps({'region': 'us', 'publicKey': public_key}).encode()
            with self.assertRaisesRegex(RuntimeError, 'region invalid'):
                network.peer_key(env, 'us')


if __name__ == '__main__':
    unittest.main()
