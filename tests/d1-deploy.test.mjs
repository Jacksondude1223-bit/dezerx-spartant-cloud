import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, readdirSync} from 'node:fs';
import {deployRouting, verifyDatabase, verificationSql} from '../workers/deploy.mjs';

const migration = '0001_routing.sql';
function database(existing = false) {
  const db = new DatabaseSync(':memory:');
  if (existing) db.exec(readFileSync(new URL('../workers/schema.sql', import.meta.url), 'utf8'));
  db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT)');
  return db;
}
function apply(db) {
  for (const name of readdirSync(new URL('../workers/migrations/', import.meta.url)).sort()) {
    if (!db.prepare('SELECT name FROM d1_migrations WHERE name = ?').get(name)) {
      db.exec(readFileSync(new URL('../workers/migrations/' + name, import.meta.url), 'utf8'));
      db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name);
    }
  }
}
const payload = db => [{success: true, results: db.prepare(verificationSql).all()}];

for (const existing of [false, true]) test(`D1 deployment migrates and verifies ${existing ? 'existing' : 'empty'} database before upload`, () => {
  const db = database(existing);
  try {
    if (existing) db.exec("INSERT INTO routes VALUES ('tenant', 'service', 'customer', 'us', 'active', 1, NULL)");
    const calls = [];
    const run = args => {
      calls.push(args);
      if (args[1] === 'migrations') apply(db);
      if (args[1] === 'execute') return JSON.stringify(payload(db));
    };
    deployRouting({run, log: () => {}});
    assert.deepEqual(calls.map(args => args[0] === 'deploy' ? 'deploy' : args[1]), ['migrations', 'execute', 'deploy']);
    assert.ok(calls[0].includes('--remote'));
    assert.ok(calls[1].includes('--remote'));
    deployRouting({run, log: () => {}});
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM d1_migrations').get().count, 2);
    if (existing) assert.equal(db.prepare('SELECT COUNT(*) AS count FROM routes').get().count, 1);
  } finally { db.close(); }
});

test('D1 blocks deployment on migration errors and schema drift', () => {
  const calls = [];
  assert.throws(() => deployRouting({run: args => {calls.push(args); throw new Error('migration failed');}, log: () => {}}), /migration failed/);
  assert.equal(calls.length, 1);
  const db = database();
  try {
    apply(db);
    db.exec('DROP INDEX domains_due');
    const driftCalls = [];
    assert.throws(() => deployRouting({run: args => {driftCalls.push(args); if (args[1] === 'execute') return JSON.stringify(payload(db));}, log: () => {}}), /index missing/);
    assert.ok(!driftCalls.some(args => args[0] === 'deploy'));
  } finally {db.close();}
});

test('verification requires every migration and valid column properties', () => {
  const db = database();
  try {
    apply(db);
    verifyDatabase(payload(db), [migration]);
    assert.throws(() => verifyDatabase(payload(db), [migration, '0003_future.sql']), /not recorded/);
    const broken = payload(db);
    broken[0].results.find(row => row.name === 'lifecycleVersion').type = 'TEXT';
    assert.throws(() => verifyDatabase(broken, [migration]), /routes.lifecycleVersion/);
    assert.throws(() => verifyDatabase([{success:false,results:[]}], [migration]), /unsuccessful/);
    const calls=[];
    deployRouting({verifyOnly:true, run:args=>{calls.push(args);return JSON.stringify(payload(db));},log:()=>{}});
    assert.equal(calls.length,1);
    assert.equal(calls[0][1],'execute');
  } finally {db.close();}
});

test('deploy preserves allocated Worker custom domains and cleans generated configuration', () => {
  const db = database();
  apply(db);
  db.exec("INSERT INTO instance_hostnames VALUES ('instance-1234.dezerx.cloud', 'tenant', 'active')");
  let generated;
  try {
    deployRouting({log: () => {}, run: args => {
      if (args[1] === 'execute') return JSON.stringify(payload(db));
      if (args[0] === 'deploy') {
        generated = args.at(-1);
        const text = readFileSync(generated, 'utf8');
        assert.match(text, /pattern = "instance-1234.dezerx.cloud"\ncustom_domain = true/);
        assert.match(text, /node-us.dezerx.cloud/);
      }
    }});
    assert.ok(generated);
    assert.throws(() => readFileSync(generated), {code: 'ENOENT'});
  } finally {db.close();}
});
