import test from 'node:test';
import assert from 'node:assert/strict';
import {createMysql, databaseName, userName, newPassword, SOCKET} from '../node/mysql.mjs';

const id = `t-${'ab12cd34ef56'.repeat(2)}`;
function fixture(options = {}) {
  const calls = [];
  const mysql = createMysql({run: async (binary, args) => { calls.push({binary, args, sql: args.at(-1)}); return {stdout: options.stdout ?? '1'}; }, ...options});
  return {mysql, calls};
}

test('tenant identifiers stay inside MySQL limits and need no quoting', () => {
  assert.equal(databaseName(id), `sp_${'ab12cd34ef56'.repeat(2)}`);
  assert.equal(userName(id), databaseName(id));
  assert.ok(userName(id).length <= 32, 'MySQL caps usernames at 32 characters');
  assert.match(databaseName(id), /^sp_[a-f0-9]{24}$/, 'pure hex, so nothing needs escaping');
});

test('generated passwords are long and contain nothing that needs escaping', () => {
  for (let i = 0; i < 50; i++) {
    const password = newPassword();
    assert.ok(password.length >= 24);
    assert.match(password, /^[A-Za-z0-9_-]+$/, 'base64url keeps the password safe in SQL and in the env file');
  }
  assert.notEqual(newPassword(), newPassword());
});

test('provisioning is idempotent, scoped to one database and capped per tenant', async () => {
  const {mysql, calls} = fixture();
  const password = newPassword();
  assert.deepEqual(await mysql.ensureTenant(id, password), {database: databaseName(id), user: userName(id)});
  const {sql, args} = calls.at(-1);
  assert.ok(args.includes(`--socket=${SOCKET}`), 'reaches MariaDB over the unix socket');
  assert.ok(args.includes('-uroot'), 'authenticates as root via the socket plugin, with no stored password');
  assert.match(sql, /CREATE DATABASE IF NOT EXISTS `sp_[a-f0-9]{24}` CHARACTER SET utf8mb4/);
  assert.match(sql, /CREATE USER IF NOT EXISTS 'sp_[a-f0-9]{24}'@'localhost'/);
  assert.match(sql, /ALTER USER .* WITH MAX_USER_CONNECTIONS 20/, 'one tenant cannot exhaust the connection pool');
  assert.match(sql, /GRANT ALL PRIVILEGES ON `sp_[a-f0-9]{24}`\.\* TO/);
  assert.equal(/GRANT ALL PRIVILEGES ON \*\.\*/.test(sql), false, 'never grants across databases');
  assert.ok(sql.includes(password), 'sets the supplied password');
});

test('a regenerated password is resynced rather than orphaning the database', async () => {
  const {mysql, calls} = fixture();
  const replacement = newPassword();
  await mysql.ensureTenant(id, replacement);
  assert.match(calls.at(-1).sql, new RegExp(`ALTER USER 'sp_[a-f0-9]{24}'@'localhost' IDENTIFIED BY '${replacement}'`));
});

test('identifiers and passwords that could alter the statement are refused', async () => {
  const {mysql, calls} = fixture();
  const before = calls.length;
  for (const [badId, badPassword] of [
    ['t-short', newPassword()],
    [`t-${'z'.repeat(24)}`, newPassword()],
    [`${id}; DROP DATABASE mysql`, newPassword()],
    [id, "abc'; GRANT ALL PRIVILEGES ON *.* TO 'x'@'%'; --"],
    [id, 'short'],
    [id, ''],
    [id, undefined]
  ]) {
    await assert.rejects(mysql.ensureTenant(badId, badPassword), /invalid_id|invalid_db_password/);
  }
  assert.equal(calls.length, before, 'nothing reached the server');
});

test('readiness reports false instead of throwing when MariaDB is unreachable', async () => {
  const {mysql} = fixture();
  assert.equal(await mysql.ready(), true);
  const failing = createMysql({run: async () => { throw new Error('ECONNREFUSED'); }});
  assert.equal(await failing.ready(), false);
  const wrong = createMysql({run: async () => ({stdout: 'something else'})});
  assert.equal(await wrong.ready(), false);
});

test('an out-of-range connection cap is rejected at construction', () => {
  for (const maxConnections of [0, -1, 1001, 'many', 1.5]) {
    assert.throws(() => createMysql({run: async () => ({stdout: '1'}), maxConnections}), /invalid_max_user_connections/);
  }
  assert.doesNotThrow(() => createMysql({run: async () => ({stdout: '1'}), maxConnections: '50'}));
});
