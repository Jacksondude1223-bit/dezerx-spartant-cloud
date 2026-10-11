#!/usr/bin/env python3
import glob
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request
import urllib.parse

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
    if stamp == 0 or not 0 <= time.time() - stamp <= 180:
        raise RuntimeError('No recent WireGuard handshake; check both peers and UDP 51820 firewall rules')


def public_address(value):
    address = ipaddress.ip_address(value)
    if not address.is_global or getattr(address, 'scope_id', None):
        raise RuntimeError('A public IP address without a scope identifier is required')
    return address


def prepare():
    run('apt-get', 'update')
    run('apt-get', 'install', '-y', 'wireguard-tools', 'iptables', 'iproute2', 'iputils-ping', 'python3')
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
    if not re.fullmatch(r'[A-Za-z0-9+/]{43}=', result.stdout.strip()):
        raise RuntimeError('Invalid generated public key')
    private_write(WG_ROOT / 'spartan-db.pub', result.stdout.strip() + '\n')
    print('WireGuard public key: ' + result.stdout.strip())


def configure(region, address=None, public_key=None):
    keyfile = WG_ROOT / 'spartan-db.key'
    if not keyfile.exists():
        raise RuntimeError('Run prepare first on both nodes and exchange their public keys')
    if keyfile.is_symlink() or keyfile.stat().st_uid != 0 or keyfile.stat().st_mode & 0o077:
        raise RuntimeError('Invalid WireGuard key file')
    address = public_address(address or input('Other node public IP: ').strip())
    public_key = public_key or input('Other node WireGuard public key: ').strip()
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
    if path.exists() and path.read_text() == config:
        run('systemctl', 'enable', '--now', 'wg-quick@' + INTERFACE)
        return
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


def activate(region, fresh_only=False):
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
    if fresh_only and any(record.get('status') != 'terminated' for record in records):
        raise RuntimeError('Instances were created during setup; schedule manual activation in a maintenance window')
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
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=10) as response:
            primary = json.loads(response.read(4097))
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


def guarded_activate(region, fresh_only=False):
    import fcntl
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
            activate(region, fresh_only=fresh_only)
    finally:
        marker.unlink(missing_ok=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def peer_key(env, region):
    path = '/control/network/key'
    origin = env['DE_ORIGIN' if region == 'us' else 'US_ORIGIN'].rstrip('/')
    parsed = urllib.parse.urlsplit(origin)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path:
        raise RuntimeError('Peer origin must be a plain HTTPS origin')
    stamp = str(int(time.time() * 1000))
    body = b'{}'
    secret = env.get('NODE_CONTROL_SECRET') or env['ORIGIN_SECRET']
    signature = hmac.new(secret.encode(), (stamp + '\nPOST\n' + path + '\n').encode() + body, hashlib.sha256).hexdigest()
    request = urllib.request.Request(origin + path, data=body, method='POST', headers={
        'Content-Type': 'application/json', 'User-Agent': 'Spartan-Node/1.0',
        'X-Spartan-Timestamp': stamp, 'X-Spartan-Signature': signature,
    })
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=10) as response:
        result = json.loads(response.read(4097))
    if result.get('region') != ('de' if region == 'us' else 'us') or not re.fullmatch(r'[A-Za-z0-9+/]{43}=', result.get('publicKey', '')):
        raise RuntimeError('Peer public key or region invalid')
    return result['publicKey']


def install_automatic(region, address=None):
    env = env_read()
    if env.get('NODE_REGION') != region:
        raise RuntimeError('Node region mismatch')
    plan_path = ROOT / 'database-network.json'
    if plan_path.exists():
        plan = json.loads(plan_path.read_text())
        if plan.get('region') != region:
            raise RuntimeError('Saved network region mismatch')
        if address and address != plan['peerIp']:
            raise RuntimeError('Changing the saved peer IP requires a planned maintenance procedure')
    else:
        if env.get('DATABASE_MODE') == 'us-central':
            print('Existing central database configuration preserved. Use spartan-db-network ' + region + ' status to verify it.')
            return
        address = str(public_address(address or input('Other node public IP (WireGuard): ').strip()))
        plan = {'region': region, 'peerIp': address, 'publicKey': None}
        private_write(plan_path, json.dumps(plan) + '\n')
    prepare()
    units = Path('/etc/systemd/system')
    private_write(units / 'spartan-db-network.service', '[Unit]\nAfter=network-online.target spartan-agent.service spartan-tunnel.service\nWants=network-online.target\n[Service]\nType=oneshot\nExecStart=/usr/local/bin/spartan-db-network ' + region + ' auto\nTimeoutStartSec=300\nUMask=0077\n')
    private_write(units / 'spartan-db-network.timer', '[Unit]\n[Timer]\nOnBootSec=45s\nOnUnitInactiveSec=30s\n[Install]\nWantedBy=timers.target\n')
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', '--now', 'spartan-db-network.timer')
    print('Automatic database setup queued. Allow inbound UDP 51820 from ' + plan['peerIp'] + ' in this node Contabo firewall.')
    print('Check: journalctl -u spartan-db-network -n 30 --no-pager')


def automatic(region):
    plan_path = ROOT / 'database-network.json'
    plan = json.loads(plan_path.read_text())
    env = env_read()
    if plan.get('region') != region or env.get('NODE_REGION') != region:
        raise RuntimeError('Node region mismatch')
    public_address(plan['peerIp'])
    if env.get('DATABASE_MODE') == 'us-central':
        result = health(env)
        if result.get('status') != 'ready' or result.get('databaseReady') is not True:
            raise RuntimeError('Central database configuration needs inspection; automatic activation will not restart it')
        run('systemctl', 'disable', '--now', 'spartan-db-network.timer')
        print('Automatic setup complete: ' + region + ' uses the US database.')
        return
    records = [json.loads(Path(name).read_text()) for name in glob.glob(env.get('DATA_ROOT', '/srv/spartan-cloud') + '/t-*/state.json')]
    if any(record.get('status') != 'terminated' for record in records):
        run('systemctl', 'disable', '--now', 'spartan-db-network.timer')
        print('Existing instances detected. Use prepare/configure/activate during a maintenance window; automatic activation stopped.')
        return
    try:
        public_key = peer_key(env, region)
    except Exception:
        print('Waiting for the other node authenticated API and WireGuard public key.')
        return
    if plan.get('publicKey') and plan['publicKey'] != public_key:
        raise RuntimeError('Peer public key changed; verify it manually before replacing the saved configuration')
    plan['publicKey'] = public_key
    private_write(plan_path, json.dumps(plan) + '\n')
    configure(region, plan['peerIp'], public_key)
    run('ping', '-I', INTERFACE, '-c', '1', '-W', '2', DE_IP if region == 'us' else US_IP, capture=True, check=False)
    try:
        handshake()
    except RuntimeError:
        print('Waiting for the peer VPN; allow UDP 51820 between the two public IPs.')
        return
    if region == 'de':
        try:
            request = urllib.request.Request(env['US_ORIGIN'].rstrip('/') + '/__cloud_node_health', headers={'X-Spartan-Origin': env['ORIGIN_SECRET'], 'User-Agent': 'Spartan-Node/1.0'})
            with urllib.request.build_opener(NoRedirect()).open(request, timeout=10) as response:
                primary = json.loads(response.read(4097))
            if primary.get('databaseMode') != 'us-central' or primary.get('region') != 'us' or primary.get('status') != 'ready':
                raise RuntimeError('US not ready')
        except Exception:
            print('Waiting for US central database activation.')
            return
    guarded_activate(region, fresh_only=True)
    run('systemctl', 'disable', '--now', 'spartan-db-network.timer')


def main():
    if os.geteuid() != 0:
        raise RuntimeError('Run with sudo')
    if len(sys.argv) not in (3, 4) or sys.argv[1] not in ('us', 'de') or sys.argv[2] not in ('prepare', 'configure', 'activate', 'status', 'install', 'auto') or (len(sys.argv) == 4 and sys.argv[2] != 'install'):
        raise RuntimeError('Usage: spartan-db-network us|de prepare|configure|activate|status|install|auto [peer-public-ip]')
    ROOT.mkdir(mode=0o700, exist_ok=True)
    import fcntl
    with open('/run/spartan-install.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        region, command = sys.argv[1:3]
        if command == 'prepare':
            prepare()
        elif command == 'configure':
            configure(region)
        elif command == 'activate':
            guarded_activate(region)
        elif command == 'install':
            install_automatic(region, sys.argv[3] if len(sys.argv) == 4 else None)
        elif command == 'auto':
            automatic(region)
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
