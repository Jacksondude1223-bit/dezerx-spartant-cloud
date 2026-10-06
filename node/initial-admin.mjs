import {spawn} from 'node:child_process';
import {validInitialAdmin} from './admin-validation.mjs';
export {validInitialAdmin} from './admin-validation.mjs';
export function createInitialAdmin(id, admin, launch = spawn) {
  if (!/^t-[a-f0-9]{24}$/.test(id) || !validInitialAdmin(admin)) throw new Error('invalid_initial_admin');
  return new Promise((resolve, reject) => {
    const child = launch('docker', ['exec', '-i', '--user', 'www-data', '--workdir', '/var/www/html', `spartan-${id}`, 'python3', '/usr/local/bin/cloud-create-admin'], {stdio: ['pipe', 'ignore', 'ignore']});
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('initial_admin_failed')); }, 80000);
    child.once('error', () => { clearTimeout(timeout); reject(new Error('initial_admin_failed')); });
    child.once('close', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('initial_admin_failed')); });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(admin));
  });
}
