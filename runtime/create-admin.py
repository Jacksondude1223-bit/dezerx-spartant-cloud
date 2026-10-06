import fcntl
import json
import os
import pty
import re
import select
import signal
import subprocess
import sys
import termios
import time


def state(admin):
    result = subprocess.run(['php', '/usr/local/bin/cloud-admin-state.php'], input=json.dumps(admin).encode(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
    return result.returncode


def create(admin):
    master, slave = pty.openpty()
    attrs = termios.tcgetattr(slave)
    attrs[3] &= ~termios.ECHO
    termios.tcsetattr(slave, termios.TCSANOW, attrs)
    def attach_terminal():
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    child = subprocess.Popen(['php', 'artisan', 'dx:user:create', '--no-ansi'], stdin=slave, stdout=slave, stderr=slave, preexec_fn=attach_terminal)
    os.close(slave)
    prompts = ['enter display name', 'enter email', 'enter password', 'confirm password', 'select role']
    answers = [admin['displayName'], admin['email'], admin['password'], admin['password'], '2']
    step = 0
    output = ''
    deadline = time.monotonic() + 40
    try:
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    chunk = os.read(master, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                output += chunk.decode('utf-8', errors='replace')
                output = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', output)[-16384:]
                if step < len(prompts) and prompts[step] in output.lower():
                    os.write(master, (answers[step] + '\n').encode())
                    step += 1
                    output = ''
            if child.poll() is not None:
                break
        if child.poll() is None:
            try:
                child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                return False
        return child.returncode == 0 and step == len(prompts)
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        os.close(master)


def main():
    if os.environ.get('CLOUD_ROLE') != 'primary':
        return 1
    admin = json.loads(sys.stdin.buffer.read(4097))
    if not isinstance(admin, dict) or sorted(admin) != ['displayName', 'email', 'password']:
        return 1
    if not all(isinstance(admin[key], str) and not re.search(r'[\x00-\x1f\x7f]', admin[key]) for key in admin):
        return 1
    if not 1 <= len(admin['displayName'].strip()) <= 100 or not 8 <= len(admin['password']) <= 128 or len(admin['email']) > 254 or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', admin['email']):
        return 1
    return bootstrap(admin, '/var/www/html/database/persistent')


def bootstrap(admin, directory):
    with open(os.path.join(directory, '.cloud-admin-bootstrap.lock'), 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        before = state(admin)
        if before == 0:
            if not create(admin) or state(admin) != 10:
                return 1
        elif before != 10:
            return 1
        marker = os.path.join(directory, '.cloud-first-user-created')
        with open(marker + '.tmp', 'w') as output:
            os.chmod(marker + '.tmp', 0o600)
            json.dump({'email': admin['email'], 'role': 'superadmin'}, output)
        os.replace(marker + '.tmp', marker)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        sys.exit(1)
