#!/usr/bin/env python3
import glob
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request

US_IP = '10.77.0.1'
DE_IP = '10.77.0.2'
INTERFACE = 'spartan-db'
ROOT = Path('/etc/spartan-cloud')
WG_ROOT = Path('/etc/wireguard')


def run(*args, capture=False, check=True):
    return subprocess.run(args, check=check, text=True, stdout=subprocess.PIPE if capture else None)


def private_write(path, content):
    if path.is_symlink():
        raise RuntimeError('Refusing a symbolic link: ' + str(path))
    temp = path.with_name(path.name + '.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write(content)
    os.chmod(temp, 0o600)
    temp.replace(path)


def env_read():
    env = {}
    for line in (ROOT / 'node.env').read_text().splitlines():
        if not line or line.startswith('#'):
            continue
        key, value = line.split('=', 1)
        env[key] = value[1:-1].replace('\\"', '"').replace('\\\\', '\\') if value.startswith('"') else value
    return env


def env_text(env):
    return ''.join(key + '="' + value.replace('\\', '\\\\').replace('"', '\\"') + '"\n' for key, value in env.items())


def health(env):
    request = urllib.request.Request('http://127.0.0.1:8788/__cloud_node_health', headers={'X-Spartan-Origin': env['ORIGIN_SECRET']})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


def handshake():
    rows = run('wg', 'show', INTERFACE, 'latest-handshakes', capture=True).stdout.strip().splitlines()
    if len(rows) != 1:
        raise RuntimeError('WireGuard must have exactly one peer')
    stamp = int(rows[0].split()[1])
    if stamp == 0 or time.time() - stamp > 180:
        raise RuntimeError('No recent WireGuard handshake; check both peers and UDP 51820 firewall rules')


def prepare():
    run('apt-get', 'update')
    run('apt-get', 'install', '-y', 'wireguard-tools', 'iptables', 'iproute2', 'python3')
    WG_ROOT.mkdir(mode=0o700, exist_ok=True)
    keyfile = WG_ROOT / 'spartan-db.key'
    if keyfile.is_symlink():
        raise RuntimeError('Invalid WireGuard key file')
    if not keyfile.exists():
        private_write(keyfile, run('wg', 'genkey', capture=True).stdout)
    else:
        if keyfile.stat().st_uid != 0 or keyfile.stat().st_mode & 0o077:
            raise RuntimeError('WireGuard private key must be root-owned with mode 600')
    result = subprocess.run(['wg', 'pubkey'], input=keyfile.read_text(), text=True, capture_output=True, check=True)
    print('WireGuard public key: ' + result.stdout.strip())


def configure(region):
    keyfile = WG_ROOT / 'spartan-db.key'
    if not keyfile.exists():
        raise RuntimeError('Run prepare first on both nodes and exchange their public keys')
    if keyfile.is_symlink() or keyfile.stat().st_uid != 0 or keyfile.stat().st_mode & 0o077:
        raise RuntimeError('Invalid WireGuard key file')
    address = ipaddress.ip_address(input('Other node public IP: ').strip())
    if not address.is_global:
        raise RuntimeError('A public IP address is required')
    public_key = input('Other node WireGuard public key: ').strip()
    if not re.fullmatch(r'[A-Za-z0-9+/]{43}=', public_key):
        raise RuntimeError('Invalid WireGuard public key')
    own = US_IP if region == 'us' else DE_IP
    peer = DE_IP if region == 'us' else US_IP
    network = ipaddress.ip_network('10.77.0.0/30')
    for route in json.loads(run('ip', '-j', '-4', 'route', 'show', capture=True).stdout):
        dest = route.get('dst', 'default')
        if dest == 'default' or route.get('dev') == INTERFACE:
            continue
        if ipaddress.ip_network(dest, strict=False).overlaps(network):
            raise RuntimeError('10.77.0.0/30 overlaps an existing route; do not activate this configuration')
    endpoint = '[' + str(address) + ']' if address.version == 6 else str(address)
    udp_tool = 'ip6tables' if address.version == 6 else 'iptables'
    rules = [(udp_tool, 'INPUT', ['-s', str(address), '-p', 'udp', '--dport', '51820', '-j', 'ACCEPT'])]
    rules += [('iptables', 'INPUT', ['-i', INTERFACE, '-s', peer + '/32', '-d', own + '/32', '-p', 'icmp', '-j', 'ACCEPT'])]
    if region == 'us':
        rules += [('iptables', 'INPUT', ['-i', INTERFACE, '-s', peer + '/32', '-d', own + '/32', '-p', 'tcp', '--dport', '3306', '-j', 'ACCEPT'])]
    else:
        rules += [('iptables', 'FORWARD', ['-o', INTERFACE, '-d', US_IP + '/32', '-p', 'tcp', '--dport', '3306', '-j', 'ACCEPT']),
                  ('iptables', 'FORWARD', ['-i', INTERFACE, '-s', US_IP + '/32', '-p', 'tcp', '--sport', '3306', '-m', 'conntrack', '--ctstate', 'ESTABLISHED', '-j', 'ACCEPT']),
                  ('iptables -t nat', 'POSTROUTING', ['-o', INTERFACE, '-d', US_IP + '/32', '-p', 'tcp', '--dport', '3306', '-j', 'SNAT', '--to-source', DE_IP])]
    private_key = keyfile.read_text().strip()
    config = '[Interface]\nAddress = ' + own + '/32\nPrivateKey = ' + private_key + '\nListenPort = 51820\nMTU = 1380\n'
    for tool, chain, args in rules:
        config += 'PostUp = ' + tool + ' -I ' + chain + ' 1 ' + ' '.join(args) + '\n'
        config += 'PostDown = ' + tool + ' -D ' + chain + ' ' + ' '.join(args) + '\n'
    config += '\n[Peer]\nPublicKey = ' + public_key + '\nEndpoint = ' + endpoint + ':51820\nAllowedIPs = ' + peer + '/32\nPersistentKeepalive = 25\n'
    path = WG_ROOT / (INTERFACE + '.conf')
    active = run('systemctl', 'is-active', '--quiet', 'wg-quick@' + INTERFACE, check=False).returncode == 0
    if active:
        if (ROOT / 'node.env').exists() and env_read().get('DATABASE_MODE') == 'us-central':
            raise RuntimeError('Database networking is already active; changing peers requires a planned maintenance procedure')
        run('systemctl', 'stop', 'wg-quick@' + INTERFACE)
    if path.exists():
        history = ROOT / 'history' / ('wireguard-' + str(time.time_ns()))
        history.mkdir(parents=True, mode=0o700)
        private_write(history / path.name, path.read_text())
    private_write(path, config)
    run('systemctl', 'enable', '--now', 'wg-quick@' + INTERFACE)
    print('WireGuard configured. Allow inbound UDP 51820 from the other node public IP in Contabo Firewall on both nodes.')
    print('Once both peers are configured, run activate on US first, then Germany.')


def activate(region):
    if not Path('/opt/spartan-cloud/central-database.mjs').is_file():
        raise RuntimeError('Install or update the latest node code first')
    env = env_read()
    if env.get('NODE_REGION') != region:
        raise RuntimeError('Node region mismatch')
    status = health(env)
    for attempt in range(120):
        if not status.get('pendingControls', 0):
            break
        time.sleep(1)
        status = health(env)
    else:
        raise RuntimeError('Node has active jobs; activation postponed')
    handshake()
    records = [json.loads(Path(name).read_text()) for name in glob.glob(env.get('DATA_ROOT', '/srv/spartan-cloud') + '/t-*/state.json')]
    if any(record.get('primary') != 'us' and record.get('status') != 'terminated' for record in records):
        raise RuntimeError('An instance has a non-US primary; migrate its data before changing database topology')
    history = ROOT / 'history' / ('database-network-' + str(time.time_ns()))
    history.mkdir(parents=True, mode=0o700)
    old_env = (ROOT / 'node.env').read_text()
    private_write(history / 'node.env', old_env)
    if region == 'us':
        cnf = Path('/etc/mysql/mariadb.conf.d/99-spartan.cnf')
        if cnf.exists():
            private_write(history / '99-spartan.cnf', cnf.read_text())
        dropin = Path('/etc/systemd/system/mariadb.service.d')
        dropin.mkdir(parents=True, exist_ok=True)
        private_write(dropin / 'spartan-network.conf', '[Unit]\nRequires=wg-quick@spartan-db.service\nAfter=wg-quick@spartan-db.service\n')
        private_write(cnf, '[mysqld]\nbind-address = ' + US_IP + '\nmax_connections = 500\n')
        os.chmod(cnf, 0o644)
        run('systemctl', 'daemon-reload')
        run('systemctl', 'restart', 'mariadb')
        run('mysqladmin', '--protocol=socket', '-uroot', 'ping')
        program = "import {createMysql} from '/opt/spartan-cloud/mysql.mjs';import {execFile} from 'node:child_process';import {promisify} from 'node:util';const records=JSON.parse(await new Promise(r=>{let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>r(s));}));const db=createMysql({run:promisify(execFile),remoteClientHost:'10.77.0.2'});for(const x of records){if(x.role==='primary'&&x.status!=='terminated'&&x.dbPassword)await db.ensureTenant(x.id,x.dbPassword);}"
        subprocess.run(['node', '--input-type=module', '-e', program], input=json.dumps(records), text=True, check=True)
    else:
        request = urllib.request.Request(env['US_ORIGIN'].rstrip('/') + '/__cloud_node_health', headers={'X-Spartan-Origin': env['ORIGIN_SECRET'], 'User-Agent': 'Spartan-Node/1.0'})
        with urllib.request.urlopen(request, timeout=10) as response:
            primary = json.load(response)
        if primary.get('databaseMode') != 'us-central' or primary.get('region') != 'us' or primary.get('status') != 'ready':
            raise RuntimeError('Activate and verify the US database node first')
        run('systemctl', 'mask', '--now', 'mariadb')
        run('systemctl', 'disable', '--now', 'spartan-backup.timer')
    env.update(DATABASE_MODE='us-central', US_DATABASE_HOST=US_IP, DE_DATABASE_HOST=DE_IP)
    private_write(ROOT / 'node.env', env_text(env))
    run('systemctl', 'restart', 'spartan-agent')
    for attempt in range(30):
        try:
            result = health(env)
            if result.get('databaseMode') == 'us-central' and result.get('status') == 'ready':
                print('US-only database mode active: ' + region)
                print('Existing containers are unchanged. Reprovision their environment and upgrade/recreate them through the API before expecting local DE serving.')
                return
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError('Agent readiness failed. Configuration checkpoint: ' + str(history))


def main():
    if os.geteuid() != 0:
        raise RuntimeError('Run with sudo')
    if len(sys.argv) != 3 or sys.argv[1] not in ('us', 'de') or sys.argv[2] not in ('prepare', 'configure', 'activate', 'status'):
        raise RuntimeError('Usage: spartan-db-network us|de prepare|configure|activate|status')
    ROOT.mkdir(mode=0o700, exist_ok=True)
    import fcntl
    with open('/run/spartan-install.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        region, command = sys.argv[1:]
        if command == 'prepare':
            prepare()
        elif command == 'configure':
            configure(region)
        elif command == 'activate':
            status = health(env_read())
            if status.get('maintenance'):
                raise RuntimeError('Node is already in maintenance')
            marker = Path('/run/spartan-cloud/node-maintenance')
            marker.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            os.close(fd)
            try:
                with open('/run/spartan-backup.lock', 'a') as backup_lock:
                    fcntl.flock(backup_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    activate(region)
            finally:
                marker.unlink(missing_ok=True)
        else:
            run('wg', 'show', INTERFACE)
            handshake()
            env = env_read()
            result = health(env)
            print(json.dumps({key: result.get(key) for key in ['region', 'status', 'databaseMode', 'databaseRegion', 'databaseReady']}, indent=2))
            if region == 'de':
                active = run('systemctl', 'is-active', '--quiet', 'mariadb', check=False).returncode == 0
                print('Local MariaDB running: ' + str(active))
                if active:
                    raise RuntimeError('Germany must not run local MariaDB in central database mode')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Database network setup failed. Check peer configuration, service logs, and the saved checkpoint; no tenant data was deleted.', file=sys.stderr)
        raise
