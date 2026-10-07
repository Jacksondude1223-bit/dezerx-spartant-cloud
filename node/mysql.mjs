// Tenant databases live in one MariaDB on the node, reached over its unix socket.
//
// The socket DIRECTORY is bind-mounted into each tenant container read-only, never the
// socket file: MariaDB unlinks and recreates the socket on restart, so a file mount
// pins a stale inode and every tenant breaks until its container is recreated. A
// read-only directory mount follows the new socket and still blocks unlink.
//
// Identifiers derive from the tenant id's hex body. MySQL caps usernames at 32
// characters and a dash would need quoting everywhere, so `t-<24 hex>` becomes
// `sp_<24 hex>` (27 characters, pure hex, nothing to escape).
import {randomBytes} from 'node:crypto';

export const SOCKET = '/run/mysqld/mysqld.sock';
const ID = /^t-[a-f0-9]{24}$/;
const PASSWORD = /^[A-Za-z0-9_-]{16,64}$/;

export const databaseName = id => `sp_${id.slice(2)}`;
export const userName = id => `sp_${id.slice(2)}`;
export const newPassword = () => randomBytes(24).toString('base64url');

export function createMysql({run, socket = SOCKET, maxConnections = 20}) {
  const connections = Number(maxConnections);
  if (!Number.isInteger(connections) || connections < 1 || connections > 1000) throw new Error('invalid_max_user_connections');
  const sql = async statements => (await run('mysql', ['--protocol=socket', `--socket=${socket}`, '-uroot', '--batch', '--skip-column-names', '-e', statements], {timeout: 30000})).stdout.trim();
  return {
    // The agent runs as root, so MariaDB's unix_socket plugin authenticates it and no
    // root password is stored anywhere on the node.
    async ready() {
      try { return await sql('SELECT 1') === '1'; } catch { return false; }
    },
    // Idempotent and self-healing: ALTER USER resyncs the password, so a node that lost
    // state.json and regenerated one does not leave an unreachable database behind.
    async ensureTenant(id, password) {
      if (!ID.test(id || '')) throw new Error('invalid_id');
      if (!PASSWORD.test(password || '')) throw new Error('invalid_db_password');
      const database = databaseName(id);
      const user = userName(id);
      await sql([
        `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE USER IF NOT EXISTS '${user}'@'localhost' IDENTIFIED BY '${password}'`,
        `ALTER USER '${user}'@'localhost' IDENTIFIED BY '${password}' WITH MAX_USER_CONNECTIONS ${connections}`,
        `GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${user}'@'localhost'`,
        'FLUSH PRIVILEGES'
      ].join('; '));
      return {database, user};
    }
  };
}
