import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open, readFile, writeFile, mkdir, rename, rm, cp, readdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const exec = promisify(execFile);
export const repository = 'Jacksondude1223-bit/dezerx-spartant-cloud';
export const tracked = name => /^node\/[a-z0-9-]+\.mjs$/.test(name) || ['scripts/backup.sh', 'scripts/setup-node.mjs'].includes(name);
export const blobHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const destination = name => path.basename(name);
const stateRoot = '/var/lib/spartan-cloud';
const installed = '/opt/spartan-cloud';
const releaseRoot = '/opt/spartan-cloud-releases';
const tokenPath = '/etc/spartan-cloud/github-update-token';
const marker = '/run/spartan-cloud/node-maintenance';

export async function readToken(filename = tokenPath) {
  let file;
  try { file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw new Error('Invalid update token file'); }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 4096) throw new Error('Update token must be root-owned and private');
    const token = (await file.readFile('utf8')).trim();
    if (!/^[a-zA-Z0-9_.-]{20,4096}$/.test(token)) throw new Error('Invalid update token');
    return token;
  } finally {await file.close();}
}

export function compareFiles(local, entries) {
  const remote = Object.fromEntries(entries.filter(entry => entry.type === 'blob' && tracked(entry.path)).map(entry => [entry.path, entry.sha]));
  if (!remote['node/agent.mjs'] || !remote['scripts/setup-node.mjs'] || !remote['scripts/backup.sh']) throw new Error('Repository has an incomplete node release');
  return [...new Set([...Object.keys(local), ...Object.keys(remote)])].sort().filter(name => local[name] !== remote[name]);
}

export async function github(resource, token, fetchImpl = fetch) {
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/${resource}`, {
    headers: {accept:'application/vnd.github+json', 'user-agent':'spartan-node-updates', ...(token ? {authorization:`Bearer ${token}`} : {})},
    redirect:'error', signal:AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 404 ? 'Repository access failed; configure a read-only GitHub update token for private repositories' : `GitHub update request failed (${response.status})`);
  return response.json();
}

export async function snapshot(root = installed) {
  const files = {};
  for (const name of await readdir(root)) {
    const source = name === 'backup.sh' ? 'scripts/backup.sh' : name === 'setup-node.mjs' ? 'scripts/setup-node.mjs' : `node/${name}`;
    if (tracked(source)) files[source] = blobHash(await readFile(path.join(root, name)));
  }
  return files;
}

export async function checkUpdates({root = installed, token, request = github} = {}) {
  token ??= await readToken();
  const ref = await request('git/ref/heads/main', token);
  const sha = ref.object?.sha;
  if (!/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('Invalid remote node version');
  const commit = await request(`git/commits/${sha}`, token);
  if (!/^[a-f0-9]{40}$/.test(commit.tree?.sha || '')) throw new Error('Invalid remote node tree');
  const tree = await request(`git/trees/${commit.tree.sha}?recursive=1`, token);
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('Incomplete remote node tree');
  const changedFiles = compareFiles(await snapshot(root), tree.tree);
  return {checkedAt:new Date().toISOString(), status:changedFiles.length ? 'update_available':'current', latestCommit:sha, changedFiles, entries:tree.tree.filter(entry => entry.type === 'blob' && tracked(entry.path))};
}

async function validateEnvironment(release, environmentFile) {
  const {parseEnvironment, validateNodeEnvironment} = await import(pathToFileURL(path.join(release,'setup-node.mjs')).href);
  const env = parseEnvironment(await readFile(environmentFile,'utf8'));
  validateNodeEnvironment(env,env.NODE_REGION);
}

export async function stageRelease(check, {root = installed, state = releaseRoot, token, request = github, run = exec, environmentFile = '/etc/spartan-cloud/node.env'} = {}) {
  token ??= await readToken();
  await mkdir(state, {recursive:true, mode:0o700});
  const release = path.join(state, check.latestCommit);
  try { await mkdir(release, {mode:0o700}); } catch (error) { if (error.code === 'EEXIST') {
    const recorded = JSON.parse(await readFile(path.join(release, 'release.json'), 'utf8'));
    if (recorded.commit === check.latestCommit && compareFiles(await snapshot(release), check.entries).length === 0) { await validateEnvironment(release,environmentFile); return release; }
    throw new Error('Staged release does not match repository; remove it before restaging');
  } throw error; }
  try {
    await cp(root, release, {recursive:true});
    for (const name of Object.keys(await snapshot(release))) await rm(path.join(release, destination(name)));
    for (const entry of check.entries) {
      const blob = await request(`git/blobs/${entry.sha}`, token);
      if (blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error('Invalid release blob');
      const bytes = Buffer.from(blob.content.replace(/\s/g,''), 'base64');
      if (blobHash(bytes) !== entry.sha) throw new Error('Release checksum failed');
      await writeFile(path.join(release, destination(entry.path)), bytes, {mode:entry.path.endsWith('.sh') ? 0o755:0o644});
    }
    for (const name of await readdir(release)) if (name.endsWith('.mjs')) await run(process.execPath, ['--check', path.join(release, name)], {timeout:15000});
    await validateEnvironment(release,environmentFile);
    await writeFile(path.join(release, 'release.json'), JSON.stringify({commit:check.latestCommit, files:await snapshot(release)}), {mode:0o600});
    return release;
  } catch (error) { await rm(release,{recursive:true,force:true}); throw error; }
}

export async function switchRelease({root, candidate, previous, restart, healthy}) {
  await rename(root, previous);
  try {
    await rename(candidate, root);
    await restart();
    if (!await healthy()) throw new Error('Updated node failed readiness');
  } catch (error) {
    const failed = `${candidate}.failed`;
    try { await rename(root, failed); } catch (renameError) { if (renameError.code !== 'ENOENT') throw renameError; }
    await rename(previous, root);
    await restart();
    if (!await healthy()) throw new Error('Rollback restored node files, but the agent is unhealthy; inspect spartan-agent logs');
    throw new Error('Node update failed; previous node files restored and agent verified');
  }
}

async function health() {
  const {parseEnvironment} = await import(path.join(installed,'setup-node.mjs'));
  const env = parseEnvironment(await readFile('/etc/spartan-cloud/node.env','utf8'));
  const response = await fetch('http://127.0.0.1:8788/__cloud_node_health',{headers:{'x-spartan-origin':env.ORIGIN_SECRET},signal:AbortSignal.timeout(3000)});
  if (!response.ok) throw new Error('Node readiness request failed');
  const result = await response.json();
  if (result.status !== 'ready' || result.region !== env.NODE_REGION) throw new Error('Node is not ready');
  return result;
}
async function ready() {
  for (let attempt=0;attempt<30;attempt++) {
    try {const result=await health(); if(result.updateSafety===1 && result.maintenance===true && result.pendingControls===0)return true;} catch {}
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  return false;
}
async function applyRelease(candidate) {
  const before = await health();
  if (before.updateSafety !== 1) throw new Error('Installed agent lacks safe update support; install the new agent during a maintenance window first');
  await mkdir(path.dirname(marker),{recursive:true,mode:0o700});
  const guard = await open(marker,'wx',0o600);
  await guard.close();
  let restoreTimer = false;
  try {
    for(let attempt=0;;attempt++) {
      const current = await health();
      if (current.maintenance !== true) throw new Error('Node maintenance guard is not active; update postponed');
      if (current.pendingControls === 0) break;
      if (attempt >= 120) throw new Error('Node is busy; update postponed without restarting');
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    const timer = await exec('systemctl',['is-active','spartan-backup.timer']).catch(()=>({stdout:''}));
    restoreTimer = timer.stdout.trim() === 'active';
    if (restoreTimer) await exec('systemctl',['stop','spartan-backup.timer']);
    const backup = await exec('systemctl',['show','spartan-backup.service','--property=ActiveState','--value']);
    if (['active','activating','deactivating','reloading'].includes(backup.stdout.trim())) throw new Error('A backup is running; retry after it finishes');
    const previous = path.join(releaseRoot,`previous-${Date.now()}`);
    await switchRelease({root:installed,candidate,previous,restart:()=>exec('systemctl',['restart','spartan-agent'],{timeout:180000}),healthy:ready});
  } finally {
    await rm(marker,{force:true});
    if (restoreTimer) await exec('systemctl',['start','spartan-backup.timer']);
  }
}

async function main() {
  if (process.getuid() !== 0) throw new Error('Run with sudo');
  const command = process.argv[2] || 'check';
  if (process.argv.length > 3 || !['check','stage','apply','status','auth'].includes(command)) throw new Error('Use spartan-node-update check|stage|apply|status|auth');
  await mkdir(stateRoot,{recursive:true,mode:0o700});
  if (command === 'auth') {
    let input=''; for await (const chunk of process.stdin) {input+=chunk; if(input.length>4096)throw new Error('Invalid update token');}
    if (!/^[a-zA-Z0-9_.-]{20,4096}$/.test(input.trim())) throw new Error('Invalid update token');
    const file = await open(tokenPath,constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o600);
    try {await file.chmod(0o600);await file.writeFile(input.trim()+'\n');} finally {await file.close();}
    console.log('Private repository update authentication saved.'); return;
  }
  if (command==='status') {
    const read = filename => readFile(path.join(stateRoot,filename),'utf8').then(JSON.parse).catch(error => {if(error.code==='ENOENT')return null;throw error;});
    console.log(JSON.stringify({lastSuccessfulCheck:await read('update-status.json'),lastError:await read('last-check-error.json')},null,2));return;
  }
  try {
    const check=await checkUpdates();
    const {entries,...report}=check;
    const temp=path.join(stateRoot,'update-status.json.tmp');
    await writeFile(temp,JSON.stringify(report,null,2)+'\n',{mode:0o600});await rename(temp,path.join(stateRoot,'update-status.json'));
    await rm(path.join(stateRoot,'last-check-error.json'),{force:true});
    console.log(`${check.status}: ${check.changedFiles.length} changed node file(s); repository commit ${check.latestCommit}.`);
    if(command==='check' || check.status==='current')return;
    const release=await stageRelease(check);
    console.log('Node release staged and validated. Containers, databases, image and node settings were not changed.');
    if(command==='apply'){await applyRelease(release);console.log('Node code updated and agent readiness verified.');}
  } catch (error) {
    await writeFile(path.join(stateRoot,'last-check-error.json'),JSON.stringify({checkedAt:new Date().toISOString(),status:'check_or_update_failed'}),{mode:0o600});
    throw error;
  }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(error=>{console.error(error.message);process.exitCode=1;});
