import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {blobHash, compareFiles, checkUpdates, stageRelease, switchRelease, readToken, tracked} from '../node/update-system.mjs';

async function fixture() {
 const temp=await mkdtemp(path.join(tmpdir(),'node-updates-'));
 const root=path.join(temp,'installed'); await mkdir(root);
 const contents={
  'node/agent.mjs':Buffer.from('export const version = 1;\n'),
  'scripts/backup.sh':Buffer.from('#!/bin/bash\ntrue\n'),
  'scripts/setup-node.mjs':await readFile(new URL('../scripts/setup-node.mjs',import.meta.url))
 };
 for(const [name,bytes] of Object.entries(contents)) await writeFile(path.join(root,path.basename(name)),bytes);
 const commit='a'.repeat(40), tree='b'.repeat(40);
 const entries=Object.entries(contents).map(([name,bytes])=>({path:name,type:'blob',sha:blobHash(bytes)}));
 const calls=[];
 const request=async resource=>{
  calls.push(resource);
  if(resource==='git/ref/heads/main')return {object:{sha:commit}};
  if(resource.startsWith('git/commits/'))return {tree:{sha:tree}};
  if(resource.startsWith('git/trees/'))return {tree:entries,truncated:false};
  if(resource.startsWith('git/blobs/')){
   const entry=entries.find(entry=>entry.sha===resource.split('/').at(-1));
   return {encoding:'base64',content:contents[entry.path].toString('base64')};
  }
  throw new Error('Unexpected API');
 };
 return {temp,root,contents,entries,calls,request};
}

test('weekly check compares node blobs without downloading or executing code',async()=>{
 const f=await fixture();
 try {
  const a=await checkUpdates({root:f.root,token:'',request:f.request});
  assert.equal(a.status,'current');
  f.entries[0].sha='c'.repeat(40);
  const b=await checkUpdates({root:f.root,token:'',request:f.request});
  assert.equal(b.status,'update_available');assert.deepEqual(b.changedFiles,['node/agent.mjs']);
  assert.ok(f.calls.every(call=>!call.includes('blobs')));
  assert.equal((await readFile(path.join(f.root,'agent.mjs'),'utf8')),'export const version = 1;\n');
  assert.equal(tracked('app/database.sqlite'),false); assert.equal(tracked('runtime/Dockerfile'),false);
  assert.throws(()=>compareFiles({},[]),/incomplete/);
 } finally {await rm(f.temp,{recursive:true,force:true});}
});

test('staging verifies blobs and environment without changing installed files',async()=>{
 const f=await fixture();
 try {
  f.contents['node/agent.mjs']=Buffer.from('export const version = 2;\n');f.entries[0].sha=blobHash(f.contents['node/agent.mjs']);
  const config=path.join(f.temp,'node.env');
  await writeFile(config,[
   'NODE_REGION=us','BASE_DOMAIN=cloud.test','US_ORIGIN=https://us.origin.test','DE_ORIGIN=https://de.origin.test',
   'SPARTAN_IMAGE=ghcr.io/test/image@sha256:'+'a'.repeat(64),'NODE_CONTROL_SECRET='+'b'.repeat(64),'ORIGIN_SECRET='+'c'.repeat(64),
   'TENANT_CPUS=1','TENANT_MEMORY=512m','MAX_TENANTS=100','AI_RECOVERY_ENABLED=false','AI_MAX_CALLS_PER_DAY=10',
   'DATA_ROOT=/srv/spartan-cloud','AGENT_PORT=8788','MYSQL_SOCKET=/run/mysqld/mysqld.sock','LARAVEL_ENV_FILE=/etc/spartan-cloud/laravel-env.json'
  ].join('\n'));
  const check=await checkUpdates({root:f.root,token:'',request:f.request});
  const candidate=await stageRelease(check,{root:f.root,state:path.join(f.temp,'releases'),token:'',request:f.request,environmentFile:config});
  assert.match(await readFile(path.join(candidate,'agent.mjs'),'utf8'),/version = 2/);
  assert.match(await readFile(path.join(f.root,'agent.mjs'),'utf8'),/version = 1/);
  const candidateAgain=await stageRelease(check,{root:f.root,state:path.join(f.temp,'releases'),token:'',request:f.request,environmentFile:config});assert.equal(candidateAgain,candidate);
 } finally {await rm(f.temp,{recursive:true,force:true});}
});

for(const fail of [false,true])test(`release switch ${fail?'rolls back failed readiness':'keeps prior node release'} and leaves tenant data intact`,async()=>{
 const f=await fixture();
 try {
  const candidate=path.join(f.temp,'candidate'),previous=path.join(f.temp,'previous'),data=path.join(f.temp,'tenant.sqlite');
  await mkdir(candidate);await writeFile(path.join(candidate,'agent.mjs'),'new-agent');await writeFile(data,'customer-data');
  let restarts=0;
  const perform=()=>switchRelease({root:f.root,candidate,previous,restart:async()=>{restarts++;},healthy:async()=>!fail || restarts===2});
  if(fail){await assert.rejects(perform(),/previous node files restored/);assert.match(await readFile(path.join(f.root,'agent.mjs'),'utf8'),/version = 1/);assert.equal(restarts,2);}
  else{await perform();assert.equal(await readFile(path.join(f.root,'agent.mjs'),'utf8'),'new-agent');await access(path.join(previous,'agent.mjs'));assert.equal(restarts,1);}
  assert.equal(await readFile(data,'utf8'),'customer-data');
 } finally {await rm(f.temp,{recursive:true,force:true});}
});

test('private update token requires protected file permissions',async()=>{
 const f=await fixture();
 try {
  const filename=path.join(f.temp,'token');await writeFile(filename,'fake-token-'+'x'.repeat(30),{mode:0o644});
  await assert.rejects(readToken(filename),/private/);
  assert.equal(await readToken(path.join(f.temp,'missing')),'');
 } finally {await rm(f.temp,{recursive:true,force:true});}
});

for(const failure of ['checksum','syntax'])test(`invalid ${failure} prevents staging without replacing installed code`,async()=>{
 const f=await fixture();
 try {
  f.contents['node/agent.mjs']=Buffer.from(failure==='syntax'?'this is invalid JavaScript {':'export const version = 2;');
  f.entries[0].sha=failure==='checksum'?'c'.repeat(40):blobHash(f.contents['node/agent.mjs']);
  const check=await checkUpdates({root:f.root,token:'',request:f.request});
  await assert.rejects(stageRelease(check,{root:f.root,state:path.join(f.temp,'releases'),token:'',request:f.request}));
  assert.match(await readFile(path.join(f.root,'agent.mjs'),'utf8'),/version = 1/);
  await assert.rejects(access(path.join(f.temp,'releases',check.latestCommit)));
 } finally {await rm(f.temp,{recursive:true,force:true});}
});
