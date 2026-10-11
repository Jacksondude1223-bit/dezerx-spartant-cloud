import {createHmac} from 'node:crypto';
import {createConnection} from 'node:net';
import {databaseName, userName} from './mysql.mjs';

export const US_DATABASE_IP = '10.77.0.1';
export const DE_DATABASE_IP = '10.77.0.2';
export const DATABASE_INTERFACE = 'spartan-db';
export const centralDatabase = cfg => cfg.DATABASE_MODE === 'us-central';

export function validateDatabaseMode(cfg) {
  if (cfg.DATABASE_MODE !== undefined && !['local', 'us-central'].includes(cfg.DATABASE_MODE)) throw new Error('invalid_database_mode');
  if (centralDatabase(cfg) && (cfg.US_DATABASE_HOST !== US_DATABASE_IP || cfg.DE_DATABASE_HOST !== DE_DATABASE_IP)) throw new Error('invalid_database_network');
}

export function databaseEnvironment(cfg, connection, socket) {
  const remote = centralDatabase(cfg) && cfg.NODE_REGION === 'de';
  return {DB_CONNECTION: 'mysql', DB_SOCKET: remote ? '' : socket, DB_HOST: remote ? US_DATABASE_IP : '127.0.0.1', DB_PORT: '3306', DB_DATABASE: connection.database, DB_USERNAME: connection.user, DB_PASSWORD: connection.password, CLOUD_DATABASE_MODE: centralDatabase(cfg) ? 'us-central' : 'local'};
}

export const localTenant = (cfg, record) => record.role === 'primary' || centralDatabase(cfg) && record.primary === 'us' && record.containerDatabaseMode === 'us-central';

export async function remoteDatabaseReady(run, connect = createConnection, now = Date.now) {
  try {
    const {stdout} = await run('wg', ['show', DATABASE_INTERFACE, 'latest-handshakes'], {timeout: 3000});
    const stamps = stdout.trim().split(/\n/).map(line => Number(line.split(/\s+/)[1]));
    if (stamps.length !== 1 || !stamps[0] || now() / 1000 - stamps[0] > 180 || stamps[0] > now() / 1000 + 5) return false;
    return await new Promise(resolve => {
      const socket = connect({host: US_DATABASE_IP, port: 3306});
      const done = value => {clearTimeout(timer); socket.destroy(); resolve(value);};
      const timer = setTimeout(() => done(false), 3000);
      socket.once('error', () => done(false));
      socket.once('connect', () => done(true));
    });
  } catch {return false;}
}

export async function primaryConnection(cfg, input, fetchImpl = fetch) {
  const pathname = '/control/database/connection';
  const payload = JSON.stringify({id: input.id, fingerprint: input.fingerprint});
  const stamp = String(Date.now());
  const secret = cfg.NODE_CONTROL_SECRET || cfg.ORIGIN_SECRET;
  const signature = createHmac('sha256', secret).update(`${stamp}\nPOST\n${pathname}\n${payload}`).digest('hex');
  let response;
  try {
    response = await fetchImpl(new URL(pathname, cfg.US_ORIGIN), {method: 'POST', body: payload, headers: {'content-type': 'application/json', 'user-agent': 'Spartan-Node/1.0', 'x-spartan-timestamp': stamp, 'x-spartan-signature': signature}, redirect: 'error', signal: AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error();
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 4096) throw new Error();
      chunks.push(Buffer.from(chunk));
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value.id !== input.id || value.host !== US_DATABASE_IP || value.database !== databaseName(input.id) || value.user !== userName(input.id) || !/^[A-Za-z0-9_-]{16,64}$/.test(value.password || '')) throw new Error();
    return value;
  } catch {throw new Error('primary_database_connection_unavailable');}
}
