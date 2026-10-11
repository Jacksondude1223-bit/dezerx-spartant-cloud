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


if __name__ == '__main__':
    unittest.main()
