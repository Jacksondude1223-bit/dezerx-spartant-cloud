import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {validateDatabaseMode, databaseEnvironment, localTenant, remoteDatabaseReady, primaryConnection} from '../node/central-database.mjs';
import {createMysql, databaseName, userName} from '../node/mysql.mjs';

const id = 't-' + 'a'.repeat(24);
const fingerprint = 'f'.repeat(64);
const password = 'p'.repeat(32);
const cfg = {DATABASE_MODE: 'us-central', US_DATABASE_HOST: '10.77.0.1', DE_DATABASE_HOST: '10.77.0.2', NODE_REGION: 'de', ORIGIN_SECRET: 's'.repeat(64), US_ORIGIN: 'https://node-us.test.invalid'};
const connection = {id, database: databaseName(id), user: userName(id), host: '10.77.0.1', password};

test('central database settings refuse public or unintended database addresses', () => {
  validateDatabaseMode(cfg);
  validateDatabaseMode({NODE_REGION:'de'});
  for (const changes of [{DATABASE_MODE:'remote'}, {US_DATABASE_HOST:'8.8.8.8'}, {DE_DATABASE_HOST:'%'}, {US_DATABASE_HOST:undefined}]) assert.throws(() => validateDatabaseMode({...cfg, ...changes}), /invalid_database/);
  const env = databaseEnvironment(cfg, connection, '/run/mysqld/mysqld.sock');
  assert.equal(env.DB_HOST, '10.77.0.1');
  assert.equal(env.DB_SOCKET, '');
  assert.equal(env.DB_PASSWORD, password);
  assert.equal(databaseEnvironment({...cfg,NODE_REGION:'us'}, connection, '/run/mysqld/mysqld.sock').DB_SOCKET, '/run/mysqld/mysqld.sock');
});

test('Germany serves locally only once the central database container is active', () => {
  const record={role:'secondary',primary:'us',containerDatabaseMode:'us-central'};
  assert.equal(localTenant(cfg,record),true);
  assert.equal(localTenant(cfg,{...record,containerDatabaseMode:'local'}),false);
  assert.equal(localTenant({...cfg,DATABASE_MODE:'local'},record),false);
  assert.equal(localTenant(cfg,{...record,primary:'de'}),false);
});

test('US grants only the matching tenant database to the fixed Germany VPN address', async () => {
  let sql;
  const mysql=createMysql({remoteClientHost:'10.77.0.2',run:async(command,args)=>{sql=args.at(-1);return {stdout:'1'};}});
  await mysql.ensureTenant(id,password);
  assert.match(sql, /@'localhost'/);
  assert.match(sql, /@'10\.77\.0\.2'/);
  assert.doesNotMatch(sql, /@'%'|ON \*\.\*/);
  assert.throws(()=>createMysql({remoteClientHost:'%',run:async()=>{}}),/invalid_remote_database_host/);
});

test('Germany credential retrieval uses signed HTTPS and binds the response to its tenant', async () => {
  const response = value => new Response(JSON.stringify(value), {headers:{'content-type':'application/json'}});
  const result=await primaryConnection(cfg,{id,fingerprint},async(url,options)=>{
    assert.equal(String(url),'https://node-us.test.invalid/control/database/connection');
    assert.equal(options.redirect,'error');
    assert.deepEqual(JSON.parse(options.body),{id,fingerprint});
    const signature=createHmac('sha256',cfg.ORIGIN_SECRET).update(`${options.headers['x-spartan-timestamp']}\nPOST\n/control/database/connection\n${options.body}`).digest('hex');
    assert.equal(options.headers['x-spartan-signature'],signature);
    return response(connection);
  });
  assert.deepEqual(result,connection);
  for(const changes of [{id:'other'},{host:'8.8.8.8'},{database:'mysql'},{user:'root'},{password:'short'}]) await assert.rejects(primaryConnection(cfg,{id,fingerprint},async()=>response({...connection,...changes})),/primary_database_connection_unavailable/);
  await assert.rejects(primaryConnection(cfg,{id,fingerprint},async()=>new Response('x'.repeat(5000))),/primary_database_connection_unavailable/);
  await assert.rejects(primaryConnection(cfg,{id,fingerprint},async()=>new Response('{}',{status:409})),/primary_database_connection_unavailable/);
});

test('Germany database readiness fails closed without a fresh WireGuard handshake or reachable US database', async () => {
  let connections=0;
  const connect=()=>{connections++; const socket=new EventEmitter();socket.destroy=()=>{};queueMicrotask(()=>socket.emit('connect'));return socket;};
  assert.equal(await remoteDatabaseReady(async()=>({stdout:'peer\t1000\n'}),connect,()=>1001*1000),true);
  assert.equal(connections,1);
  for(const stamp of [0,500,1100]) assert.equal(await remoteDatabaseReady(async()=>({stdout:`peer\t${stamp}\n`}),connect,()=>1001*1000),false);
  assert.equal(connections,1,'no database socket attempted without a valid VPN');
  assert.equal(await remoteDatabaseReady(async()=>{throw new Error('no interface');},connect),false);
  const refused=()=>{const socket=new EventEmitter();socket.destroy=()=>{};queueMicrotask(()=>socket.emit('error',new Error('refused')));return socket;};
  assert.equal(await remoteDatabaseReady(async()=>({stdout:'peer\t1000\n'}),refused,()=>1001*1000),false);
});

async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return server.address().port;}
for(const region of ['us','de']) test(`central ${region} agent enforces US database ownership and routing`, async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'central-db-'));
  const backend=http.createServer((req,res)=>res.end('Germany application, US database'));
  const backendPort=await listen(backend);
  const reservation=http.createServer();const port=await listen(reservation);await new Promise(resolve=>reservation.close(resolve));
  const bin=path.join(root,'bin');await mkdir(bin);
  await writeFile(path.join(bin,'mysql'),`#!/usr/bin/env node\nrequire('fs').appendFileSync(process.env.SQL_LOG,process.argv.at(-1)+'\\n');console.log('1');\n`,{mode:0o755});
  const directory=path.join(root,'data',id);await mkdir(directory,{recursive:true});
  const record={id,fingerprint,primary:'us',role:region==='us'?'primary':'secondary',status:'ready',dbPassword:password,appKey:'base64:'+Buffer.alloc(32).toString('base64'),url:'https://customer.test.invalid',containerUrl:'https://customer.test.invalid',containerDatabaseMode:'us-central',port:backendPort};
  await writeFile(path.join(directory,'state.json'),JSON.stringify(record));
  const env={...process.env,...cfg,NODE_REGION:region,NODE_CONTROL_SECRET:'',BASE_DOMAIN:'cloud.test.invalid',DE_ORIGIN:'https://node-de.test.invalid',SPARTAN_IMAGE:'registry.test/spartan@sha256:'+'a'.repeat(64),DATA_ROOT:path.join(root,'data'),AGENT_PORT:String(port),PATH:bin+':'+process.env.PATH,SQL_LOG:path.join(root,'sql.log'),NODE_MAINTENANCE_FILE:path.join(root,'maintenance')};
  const child=spawn(process.execPath,['node/agent.mjs'],{env});let logs='';child.stderr.on('data',x=>logs+=x);
  const origin='http://127.0.0.1:'+port;
  try{
    let ready=false;for(let i=0;i<100;i++){try{await fetch(origin);ready=true;break;}catch{await new Promise(r=>setTimeout(r,20));}}assert.equal(ready,true,logs);
    const call=async(value,signature=true)=>{const body=JSON.stringify(value),stamp=String(Date.now());return fetch(origin+'/control/database/connection',{method:'POST',body,headers:{'x-spartan-timestamp':stamp,'x-spartan-signature':signature?createHmac('sha256',cfg.ORIGIN_SECRET).update(`${stamp}\nPOST\n/control/database/connection\n${body}`).digest('hex'):'0'.repeat(64)}});};
    assert.equal((await call({id,fingerprint},false)).status,401);
    if(region==='us'){
      const response=await call({id,fingerprint});assert.equal(response.status,200);assert.deepEqual(await response.json(),connection);
      assert.equal(response.headers.get('cache-control'),'no-store');
      assert.equal((await call({id,fingerprint:'0'.repeat(64)})).status,409);
      assert.match(await readFile(path.join(root,'sql.log'),'utf8'),/@'10\.77\.0\.2'/);
    }else{
      assert.equal((await call({id,fingerprint})).status,409);
      const response=await fetch(origin+'/tenant/'+id+'/billing',{headers:{'x-spartan-origin':cfg.ORIGIN_SECRET,'x-spartan-client-ip':'198.51.100.1','x-spartan-host':'customer.test.invalid','x-spartan-custom-domain':'1'}});
      assert.equal(response.status,200);assert.equal(await response.text(),'Germany application, US database');
      await assert.rejects(readFile(path.join(root,'sql.log')), {code:'ENOENT'});
    }
    assert.equal(logs.includes(password),false);
  }finally{child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));await new Promise(resolve=>backend.close(resolve));await rm(root,{recursive:true,force:true});}
});
