import path from 'node:path';
import {readdir, stat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {apiError} from './management.mjs';
import {cpuSummary} from './resources.mjs';

// Operator API used by the dashboard. Every route here is signed with ADMIN_API_SECRET,
// which is never given to the routing Worker or the master website: these routes can
// read and change any file in a tenant container and run commands inside it.

export const validTenantId = id => /^t-[a-f0-9]{24}$/.test(id || '');
export const ADMIN_USERS = {'www-data': '33:33', root: '0:0'};
export const PERSISTENT_ROOT = '/var/www/html/storage';

const UNITS = {b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4};
export function parseSize(text) {
  const match = String(text || '').trim().match(/^([\d.]+)\s*([a-z]*)$/i);
  if (!match) return null;
  const unit = UNITS[(match[2] || 'b').toLowerCase()];
  return unit ? Math.round(Number(match[1]) * unit) : null;
}
export const parsePair = text => String(text || '').split('/').map(part => parseSize(part));
const percent = text => { const value = Number.parseFloat(String(text || '').replace('%', '')); return Number.isFinite(value) ? value : null; };

export function parseStats(line) {
  const stats = JSON.parse(line);
  const [memoryUsedBytes, memoryLimitBytes] = parsePair(stats.MemUsage);
  const [networkRxBytes, networkTxBytes] = parsePair(stats.NetIO);
  const [blockReadBytes, blockWriteBytes] = parsePair(stats.BlockIO);
  return {name: stats.Name, cpuPercent: percent(stats.CPUPerc), memoryUsedBytes, memoryLimitBytes, memoryPercent: percent(stats.MemPerc), networkRxBytes, networkTxBytes, blockReadBytes, blockWriteBytes, processes: Number(stats.PIDs) || 0};
}

export function planOf(licenseKey) {
  const match = String(licenseKey || '').match(/^SPARTAN([A-Z]+)_/);
  return match ? match[1].toLowerCase() : null;
}

// Never returns appKey, licenseKey or dbPassword.
export function tenantSummary(record) {
  return {id: record.id, primary: record.primary, role: record.role, status: record.status, url: record.url, activeUrl: record.containerUrl || record.url, image: record.image, port: record.port || null, lifecycleVersion: record.lifecycleVersion || 0, fingerprint: record.fingerprint, plan: planOf(record.licenseKey), adminInitialized: record.adminInitialized === true, environmentPending: Boolean(record.envHash) && record.envHash !== record.containerEnvHash};
}

export function validContainerPath(value) {
  if (value === '/') return true;
  return typeof value === 'string' && value.length <= 4096 && value.startsWith('/') && !/[\x00-\x1f\x7f]/.test(value)
    && !value.slice(1).split('/').some(part => part === '' || part === '.' || part === '..');
}

const FS_ACTIONS = ['list', 'stat', 'read', 'write', 'create', 'upload', 'mkdir', 'rename', 'copy', 'delete', 'chmod', 'chown', 'extract'];
const MAX_WRITE = 4 * 1024 * 1024;
const MAX_CHUNK = 6 * 1024 * 1024;
const base64 = (value, max) => typeof value === 'string' && value.length <= Math.ceil(max / 3) * 4 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
export function validFsRequest(input) {
  if (!FS_ACTIONS.includes(input.action) || !validContainerPath(input.path)) throw apiError('invalid_file_request');
  if (input.user !== undefined && !Object.hasOwn(ADMIN_USERS, input.user)) throw apiError('invalid_user');
  if (['rename', 'copy'].includes(input.action) && (!validContainerPath(input.destination) || input.destination === '/')) throw apiError('invalid_destination');
  if (input.action === 'extract' && input.destination !== undefined && !validContainerPath(input.destination)) throw apiError('invalid_destination');
  if (input.action === 'write' && !base64(input.contentBase64, MAX_WRITE)) throw apiError('invalid_file_content');
  if (input.action === 'write' && input.expectModifiedAt !== undefined && !Number.isFinite(input.expectModifiedAt)) throw apiError('invalid_file_request');
  if (input.action === 'upload') {
    if (!base64(input.contentBase64, MAX_CHUNK) || !/^[a-f0-9]{16,64}$/.test(input.uploadId || '') || !Number.isSafeInteger(input.offset) || input.offset < 0 || typeof input.final !== 'boolean') throw apiError('invalid_upload');
  }
  if (['chmod'].includes(input.action) && (!/^[0-7]{3,4}$/.test(input.mode || ''))) throw apiError('invalid_mode');
  if (input.action === 'chown' && !/^[a-z_][a-z0-9_-]{0,31}(?::[a-z_][a-z0-9_-]{0,31})?$|^\d{1,10}(?::\d{1,10})?$/.test(input.owner || '')) throw apiError('invalid_owner');
  for (const flag of ['recursive', 'overwrite', 'parents']) if (input[flag] !== undefined && typeof input[flag] !== 'boolean') throw apiError('invalid_file_request');
  return input;
}

export function validExecRequest(input) {
  if (typeof input.command !== 'string' || !input.command.trim() || input.command.length > 8192 || input.command.includes('\0')) throw apiError('invalid_command');
  if (input.cwd !== undefined && !validContainerPath(input.cwd)) throw apiError('invalid_cwd');
  if (input.user !== undefined && !Object.hasOwn(ADMIN_USERS, input.user)) throw apiError('invalid_user');
  if (input.timeoutSeconds !== undefined && (!Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > 90)) throw apiError('invalid_timeout');
  return input;
}

// Runs inside the tenant container as the chosen user, so the kernel enforces the
// permissions. Reads its request as JSON on stdin and prints one JSON result.
export const fsProgram = String.raw`import os,sys,json,stat,base64,shutil,pwd,grp,zipfile,tarfile,errno,uuid,time
STORAGE='/var/www/html/storage'
PROTECTED={'/','/var/www','/var/www/html',STORAGE}
def out(value): sys.stdout.write(json.dumps(value)); sys.exit(0)
def fail(code,status=400): out({'error':code,'status':status})
def persistent(p):
    r=os.path.realpath(p); return r==STORAGE or r.startswith(STORAGE+'/')
def name_of(fn,i):
    try: return fn(i)[0]
    except KeyError: return str(i)
def describe(p,name=None):
    st=os.lstat(p); m=st.st_mode
    kind='link' if stat.S_ISLNK(m) else 'directory' if stat.S_ISDIR(m) else 'file' if stat.S_ISREG(m) else 'other'
    d={'name':name if name is not None else (os.path.basename(p) or '/'),'type':kind,'size':st.st_size,'mode':'%04o'%stat.S_IMODE(m),'permissions':stat.filemode(m),'uid':st.st_uid,'gid':st.st_gid,'owner':name_of(pwd.getpwuid,st.st_uid),'group':name_of(grp.getgrgid,st.st_gid),'modifiedAt':st.st_mtime}
    if kind=='link':
        try: d['target']=os.readlink(p)
        except OSError: pass
        d['targetType']='directory' if os.path.isdir(p) else 'file' if os.path.isfile(p) else 'broken'
    return d
def guarded(p):
    if p in PROTECTED or p.count('/')<2: fail('protected_path',403)
def real_file(p):
    return os.path.realpath(p) if os.path.islink(p) else p
def write_atomic(target,content,existing):
    tmp=os.path.join(os.path.dirname(target),'.spartan-write-'+uuid.uuid4().hex)
    fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
    try:
        with os.fdopen(fd,'wb',closefd=False) as f: f.write(content); f.flush(); os.fsync(fd)
        adopt(tmp,existing)
        os.replace(tmp,target)
    except BaseException:
        try: os.unlink(tmp)
        except OSError: pass
        raise
    finally: os.close(fd)
def adopt(path,existing):
    if existing is None: return
    os.chmod(path,stat.S_IMODE(existing.st_mode))
    if os.geteuid()==0: os.chown(path,existing.st_uid,existing.st_gid)
def safe_member(dest,name):
    parts=[p for p in name.replace('\\','/').split('/') if p not in ('','.')]
    if not parts or name.startswith('/') or '..' in parts: return None
    cur=dest
    for part in parts[:-1]:
        cur=os.path.join(cur,part)
        if os.path.islink(cur): return None
    full=os.path.join(dest,*parts)
    if os.path.islink(full): return None
    return full
def owner_ids(spec):
    user,_,group=spec.partition(':')
    uid=int(user) if user.isdigit() else pwd.getpwnam(user).pw_uid
    gid=(int(group) if group.isdigit() else grp.getgrnam(group).gr_gid) if group else -1
    return uid,gid
try:
    d=json.load(sys.stdin); a=d['action']; p=d['path']
    if a=='list':
        if not os.path.isdir(p): fail('not_a_directory',409)
        names=sorted(os.listdir(p)); entries=[]
        for n in names[:5000]:
            try: entries.append(describe(os.path.join(p,n),n))
            except FileNotFoundError: pass
        entries.sort(key=lambda e:(0 if e['type']=='directory' or e.get('targetType')=='directory' else 1,e['name'].lower()))
        out({'path':p,'entries':entries,'truncated':len(names)>5000,'persistent':persistent(p),'writable':os.access(p,os.W_OK)})
    elif a=='stat':
        out({**describe(p),'path':p,'persistent':persistent(p)})
    elif a=='read':
        st=os.stat(p)
        if not stat.S_ISREG(st.st_mode): fail('not_a_file',409)
        if st.st_size>4194304: fail('file_too_large',413)
        with open(p,'rb') as f: content=f.read(4194305)
        if len(content)>4194304: fail('file_too_large',413)
        binary=b'\0' in content[:8192]
        if not binary:
            try: content.decode('utf-8')
            except UnicodeDecodeError: binary=True
        out({'path':p,'contentBase64':base64.b64encode(content).decode(),'size':len(content),'binary':binary,'mode':'%04o'%stat.S_IMODE(st.st_mode),'modifiedAt':st.st_mtime,'persistent':persistent(p),'writable':os.access(p,os.W_OK)})
    elif a=='write':
        target=real_file(p); content=base64.b64decode(d['contentBase64'],validate=True)
        if len(content)>4194304: fail('file_too_large',413)
        try: existing=os.stat(target)
        except FileNotFoundError: existing=None
        if existing is not None and not stat.S_ISREG(existing.st_mode): fail('not_a_file',409)
        if 'expectModifiedAt' in d and existing is not None and abs(existing.st_mtime-d['expectModifiedAt'])>0.000001: fail('file_changed',409)
        write_atomic(target,content,existing)
        st=os.stat(target)
        out({'path':p,'writtenBytes':len(content),'modifiedAt':st.st_mtime,'persistent':persistent(p)})
    elif a=='create':
        fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644); os.close(fd)
        out({'path':p,'created':True,'persistent':persistent(p)})
    elif a=='upload':
        target=real_file(p); tmp=os.path.join(os.path.dirname(target),'.spartan-upload-'+d['uploadId'])
        content=base64.b64decode(d['contentBase64'],validate=True)
        if d['offset']==0:
            if os.path.lexists(target) and not d.get('overwrite'): fail('file_exists',409)
            # Uploads abandoned mid-way leave a partial file; clear any older than a day.
            folder=os.path.dirname(target)
            for n in os.listdir(folder):
                if n.startswith('.spartan-upload-'):
                    try:
                        old=os.path.join(folder,n)
                        if time.time()-os.lstat(old).st_mtime>86400: os.unlink(old)
                    except OSError: pass
            fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o644)
        else:
            fd=os.open(tmp,os.O_WRONLY|os.O_APPEND|os.O_NOFOLLOW)
        try:
            if os.fstat(fd).st_size!=d['offset']: fail('upload_offset_mismatch',409)
            with os.fdopen(fd,'ab',closefd=False) as f: f.write(content); f.flush()
            os.fsync(fd); received=os.fstat(fd).st_size
        finally: os.close(fd)
        if d['final']:
            try: existing=os.stat(target)
            except FileNotFoundError: existing=None
            if existing is not None and not d.get('overwrite'):
                os.unlink(tmp); fail('file_exists',409)
            if existing is not None and not stat.S_ISREG(existing.st_mode):
                os.unlink(tmp); fail('not_a_file',409)
            adopt(tmp,existing); os.replace(tmp,target)
        out({'path':p,'receivedBytes':received,'completed':d['final'],'persistent':persistent(p)})
    elif a=='mkdir':
        os.makedirs(p,0o755) if d.get('parents') else os.mkdir(p,0o755)
        out({'path':p,'created':True,'persistent':persistent(p)})
    elif a in ('rename','copy'):
        dest=d['destination']
        if os.path.lexists(dest): fail('file_exists',409)
        if a=='rename':
            guarded(p); os.rename(p,dest)
        elif os.path.isdir(p) and not os.path.islink(p): shutil.copytree(p,dest,symlinks=True)
        else: shutil.copy2(p,dest,follow_symlinks=False)
        out({'path':p,'destination':dest,'done':True,'persistent':persistent(dest)})
    elif a=='delete':
        guarded(p)
        if os.path.isdir(p) and not os.path.islink(p):
            shutil.rmtree(p) if d.get('recursive') else os.rmdir(p)
        else: os.unlink(p)
        out({'path':p,'deleted':True})
    elif a=='chmod':
        mode=int(d['mode'],8); changed=0
        if os.path.islink(p): fail('symlink_mode',409)
        if d.get('recursive'):
            guarded(p)
            for base,dirs,files in os.walk(p):
                for n in [base]+[os.path.join(base,f) for f in files]:
                    if not os.path.islink(n): os.chmod(n,mode); changed+=1
        else: os.chmod(p,mode); changed=1
        out({'path':p,'mode':'%04o'%mode,'changed':changed})
    elif a=='chown':
        try: uid,gid=owner_ids(d['owner'])
        except KeyError: fail('unknown_owner',404)
        changed=0
        if d.get('recursive'):
            guarded(p)
            for base,dirs,files in os.walk(p):
                for n in [base]+[os.path.join(base,f) for f in files]: os.lchown(n,uid,gid); changed+=1
        else: os.lchown(p,uid,gid); changed=1
        out({'path':p,'owner':d['owner'],'changed':changed})
    elif a=='extract':
        dest=d.get('destination') or os.path.dirname(p)
        if not os.path.isdir(dest): fail('not_a_directory',409)
        extracted=0; skipped=0; total=0
        def emit(name,is_dir,mode,source):
            global extracted,skipped,total
            full=safe_member(dest,name)
            if full is None: skipped+=1; return
            if is_dir: os.makedirs(full,0o755,exist_ok=True); return
            os.makedirs(os.path.dirname(full),0o755,exist_ok=True)
            if os.path.islink(os.path.dirname(full)): skipped+=1; return
            fd=os.open(full,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,(mode&0o777) or 0o644)
            with os.fdopen(fd,'wb') as f:
                while True:
                    chunk=source.read(1048576)
                    if not chunk: break
                    total+=len(chunk)
                    if total>4294967296: fail('archive_too_large',413)
                    f.write(chunk)
            extracted+=1
            if extracted>100000: fail('archive_too_large',413)
        lower=p.lower()
        if lower.endswith('.zip'):
            with zipfile.ZipFile(p) as z:
                for info in z.infolist():
                    mode=(info.external_attr>>16)&0o7777
                    if stat.S_ISLNK(info.external_attr>>16): skipped+=1; continue
                    if info.is_dir(): emit(info.filename,True,0,None); continue
                    with z.open(info) as source: emit(info.filename,False,mode,source)
        elif lower.endswith(('.tar','.tar.gz','.tgz','.tar.bz2','.tar.xz')):
            with tarfile.open(p,'r:*') as t:
                for member in t:
                    if member.isdir(): emit(member.name,True,0,None)
                    elif member.isfile():
                        source=t.extractfile(member); emit(member.name,False,member.mode,source)
                    else: skipped+=1
        else: fail('unsupported_archive')
        out({'path':p,'destination':dest,'extracted':extracted,'skipped':skipped,'persistent':persistent(dest)})
    else: fail('invalid_action')
except SystemExit: raise
except FileNotFoundError: fail('file_not_found',404)
except FileExistsError: fail('file_exists',409)
except PermissionError: fail('permission_denied',403)
except IsADirectoryError: fail('is_a_directory',409)
except NotADirectoryError: fail('not_a_directory',409)
except (zipfile.BadZipFile,tarfile.TarError): fail('invalid_archive',400)
except OSError as error:
    if error.errno==errno.ENOTEMPTY: fail('directory_not_empty',409)
    if error.errno==errno.ENOSPC: fail('no_space_left',507)
    if error.errno==errno.EXDEV: fail('cross_device',409)
    if error.errno==errno.EROFS: fail('read_only_filesystem',409)
    fail('file_operation_failed',409)
except Exception: fail('file_operation_failed',400)
`;

// Prints one JSON header line, then the raw bytes: a file as-is, a directory as .tar.gz.
export const downloadProgram = String.raw`import os,sys,json,stat,tarfile,shutil
def header(value): sys.stdout.write(json.dumps(value)+'\n'); sys.stdout.flush()
d=json.load(sys.stdin); p=d['path']
try:
    st=os.stat(p)
    if stat.S_ISDIR(st.st_mode):
        if not os.access(p,os.R_OK|os.X_OK): raise PermissionError()
        base=os.path.basename(p) or 'root'
        header({'name':base+'.tar.gz','type':'archive'})
        with tarfile.open(fileobj=sys.stdout.buffer,mode='w|gz') as t:
            for root,dirs,files in os.walk(p):
                rel=os.path.relpath(root,p); arc=base if rel=='.' else os.path.join(base,rel)
                t.add(root,arcname=arc,recursive=False)
                for name in files:
                    full=os.path.join(root,name)
                    try:
                        info=t.gettarinfo(full,arcname=os.path.join(arc,name))
                        if info.isreg():
                            with open(full,'rb') as f: t.addfile(info,f)
                        elif info.issym(): t.addfile(info)
                    except OSError: pass
    elif stat.S_ISREG(st.st_mode):
        f=open(p,'rb')
        header({'name':os.path.basename(p),'type':'file','size':st.st_size})
        shutil.copyfileobj(f,sys.stdout.buffer,1048576)
    else: header({'error':'not_a_file','status':409})
except FileNotFoundError: header({'error':'file_not_found','status':404})
except PermissionError: header({'error':'permission_denied','status':403})
except BrokenPipeError: pass
`;

// Collects a child's output with byte caps and a hard kill timer. Never rejects on a
// non-zero exit: the caller decides what an exit code means.
export function capture(command, args, {input = '', timeout = 30000, maxBytes = 1024 * 1024, launch = spawn, env} = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = launch(command, args, {stdio: ['pipe', 'pipe', 'pipe'], env});
    const streams = {stdout: [], stderr: []};
    const sizes = {stdout: 0, stderr: 0};
    let truncated = false, killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeout);
    for (const name of ['stdout', 'stderr']) {
      child[name].on('data', chunk => {
        const room = maxBytes - sizes[name];
        if (room <= 0) { truncated = true; return; }
        if (chunk.length > room) { truncated = true; chunk = chunk.subarray(0, room); }
        sizes[name] += chunk.length;
        streams[name].push(chunk);
      });
    }
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({code, killed, truncated, durationMs: Date.now() - started, stdout: Buffer.concat(streams.stdout), stderr: Buffer.concat(streams.stderr)});
    });
    child.stdin.end(input);
  });
}

export function createAdmin({cfg, root, load, management, launch = spawn, env = process.env}) {
  const container = id => `spartan-${id}`;
  const docker = (args, options = {}) => capture('docker', args, {launch, env, ...options});
  const dockerText = async (args, options) => {
    const result = await docker(args, options);
    if (result.code !== 0) throw Object.assign(new Error('docker_failed'), {stderr: result.stderr.toString()});
    return result.stdout.toString();
  };
  const storageSizes = new Map();
  let running = 0;
  const limited = async (max, code, task) => {
    if (running >= max) throw apiError(code, 429);
    running++;
    try { return await task(); } finally { running--; }
  };

  async function record(input) {
    if (!validTenantId(input.id)) throw apiError('invalid_id');
    const value = await load(input.id);
    if (!value) throw apiError('not_provisioned', 404);
    if (value.status === 'terminated') throw apiError('service_terminated', 410);
    return value;
  }
  // management.tenant checks the container labels against the stored fingerprint.
  const checked = async (input, options) => management.tenant({id: input.id, fingerprint: (await record(input)).fingerprint}, options);

  async function containers() {
    const output = await dockerText(['ps', '-a', '--no-trunc', '--filter', 'label=spartan.managed=true', '--format', '{{json .}}'], {timeout: 20000});
    const result = new Map();
    for (const line of output.split('\n').filter(Boolean)) {
      const item = JSON.parse(line);
      const name = String(item.Names || '').split(',')[0];
      if (!/^spartan-t-[a-f0-9]{24}$/.test(name)) continue;
      result.set(name.slice('spartan-'.length), {state: item.State, statusText: item.Status, image: item.Image, createdAt: item.CreatedAt, running: item.State === 'running'});
    }
    return result;
  }
  async function stats(names) {
    if (names === undefined) names = [...(await containers()).entries()].filter(([, value]) => value.running).map(([id]) => container(id));
    if (!names.length) return [];
    const output = await dockerText(['stats', '--no-stream', '--no-trunc', '--format', '{{json .}}', ...names], {timeout: 30000, maxBytes: 4 * 1024 * 1024});
    return output.split('\n').filter(Boolean).map(parseStats).map(item => ({id: item.name.replace(/^spartan-/, ''), ...item}));
  }
  async function tenants({withStats = false} = {}) {
    const ids = (await readdir(root).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).filter(validTenantId).sort();
    const [state, usage] = await Promise.all([containers().catch(() => null), withStats ? stats().catch(() => null) : null]);
    const byId = new Map((usage || []).map(item => [item.id, item]));
    return Promise.all(ids.map(async id => {
      let summary;
      try {
        const value = await load(id);
        summary = value ? {...tenantSummary(value), ...cpuSummary(cfg, value)} : {id, status: 'missing_state'};
      } catch { summary = {id, status: 'unreadable_state'}; }
      try { summary.createdAt = (await stat(path.join(root, id))).birthtime.toISOString(); } catch {}
      summary.container = state ? state.get(id) || {state: 'missing', running: false} : null;
      if (withStats) {
        const item = byId.get(id);
        summary.resources = item ? {cpuPercent: item.cpuPercent, memoryUsedBytes: item.memoryUsedBytes, memoryLimitBytes: item.memoryLimitBytes, memoryPercent: item.memoryPercent, networkRxBytes: item.networkRxBytes, networkTxBytes: item.networkTxBytes, blockReadBytes: item.blockReadBytes, blockWriteBytes: item.blockWriteBytes, processes: item.processes} : null;
      }
      return summary;
    }));
  }
  async function overview() {
    const [node, list] = await Promise.all([management.nodeHealth(), tenants({withStats: true})]);
    // The node's own public hostname, so a dashboard reaching it over loopback can still name it.
    let host = null;
    try { host = new URL(cfg.NODE_REGION === 'us' ? cfg.US_ORIGIN : cfg.DE_ORIGIN).host; } catch {}
    return {region: cfg.NODE_REGION, host, node, tenants: list, sampledAt: new Date().toISOString()};
  }
  async function detail(input) {
    const value = await record(input);
    const input2 = {id: value.id, fingerprint: value.fingerprint};
    const {inspect} = await management.tenant(input2);
    const information = await management.information(input2, true);
    let versions = null;
    if (inspect?.State?.Running) versions = await management.version(input2).then(result => result.versions).catch(() => null);
    // du walks the whole storage tree, so a dashboard polling every few seconds reuses
    // the last figure for five minutes instead of re-reading the disk each time.
    let storageBytes = null;
    const cached = storageSizes.get(value.id);
    if (cached && Date.now() - cached.at < 300000) storageBytes = cached.bytes;
    else {
      const du = await capture('du', ['-sb', path.join(root, value.id, 'storage')], {launch, timeout: 15000}).catch(() => null);
      if (du?.code === 0) storageBytes = Number(du.stdout.toString().split('\t')[0]) || null;
      storageSizes.set(value.id, {at: Date.now(), bytes: storageBytes});
      if (storageSizes.size > 1000) storageSizes.clear();
    }
    return {...tenantSummary(value), ...information, versions, storageBytes,
      container: inspect ? {state: inspect.State?.Status, running: inspect.State?.Running === true, startedAt: inspect.State?.StartedAt, restartCount: inspect.RestartCount || 0, createdAt: inspect.Created, exitCode: inspect.State?.ExitCode, oomKilled: inspect.State?.OOMKilled === true} : null};
  }
  async function logs(input) {
    const tail = input.tail === undefined ? 300 : input.tail;
    if (!Number.isInteger(tail) || tail < 1 || tail > 5000) throw apiError('invalid_tail');
    await checked(input);
    const result = await docker(['logs', '--tail', String(tail), '--timestamps', container(input.id)], {timeout: 20000, maxBytes: 4 * 1024 * 1024});
    if (result.code !== 0) throw apiError('container_not_found', 404);
    const lines = [];
    for (const stream of ['stdout', 'stderr']) {
      for (const line of result[stream].toString().split('\n')) {
        if (!line) continue;
        const space = line.indexOf(' ');
        const time = space > 0 && /^\d{4}-\d\d-\d\dT/.test(line) ? line.slice(0, space) : '';
        lines.push({time, stream, text: time ? line.slice(space + 1) : line});
      }
    }
    lines.sort((left, right) => left.time < right.time ? -1 : left.time > right.time ? 1 : 0);
    return {id: input.id, lines: lines.slice(-tail), truncated: result.truncated};
  }
  const MARK = '\n\x1eSPARTAN_CWD:';
  async function exec(input) {
    validExecRequest(input);
    await checked(input, {running: true});
    const user = input.user || 'www-data';
    const seconds = input.timeoutSeconds || 30;
    // A remembered directory that has since been deleted must not wedge the console.
    const script = `cd -- "$1" 2>/dev/null || { printf 'spartan: %s is not available, using /\\n' "$1" >&2; cd /; }\neval "$2"\n__spartan_status=$?\nprintf '${MARK.replace('\n', '\\n').replace('\x1e', '\\036')}%s\\n' "$PWD" >&2\nexit $__spartan_status`;
    return limited(4, 'console_busy', async () => {
      const result = await docker(['exec', '--user', ADMIN_USERS[user], '-e', 'TERM=dumb', '-e', 'COLUMNS=160', container(input.id), 'timeout', '-k', '5', String(seconds), 'sh', '-c', script, 'spartan-console', input.cwd || '/var/www/html', input.command], {timeout: (seconds + 15) * 1000});
      let stderr = result.stderr.toString('utf8');
      let cwd = input.cwd || '/var/www/html';
      const at = stderr.lastIndexOf(MARK);
      if (at !== -1) { cwd = stderr.slice(at + MARK.length).replace(/\n$/, '') || cwd; stderr = stderr.slice(0, at); }
      const timedOut = result.killed || result.code === 124 || result.code === 137 && result.durationMs >= seconds * 1000;
      return {id: input.id, user, exitCode: result.code, stdout: result.stdout.toString('utf8'), stderr, cwd: validContainerPath(cwd) ? cwd : input.cwd || '/var/www/html', durationMs: result.durationMs, timedOut, truncated: result.truncated};
    });
  }
  async function fs(input) {
    validFsRequest(input);
    await checked(input, {running: true});
    const user = input.user || 'www-data';
    const {id, user: ignored, ...request} = input;
    const result = await docker(['exec', '-i', '--user', ADMIN_USERS[user], container(id), 'python3', '-c', fsProgram], {input: JSON.stringify(request), timeout: input.action === 'extract' ? 300000 : 120000, maxBytes: 8 * 1024 * 1024});
    if (result.truncated) throw apiError('response_too_large', 413);
    let parsed;
    try { parsed = JSON.parse(result.stdout.toString('utf8')); }
    catch { throw apiError(result.code === 126 || result.code === 127 ? 'python_unavailable' : 'file_operation_failed', 409); }
    if (parsed.error) throw apiError(parsed.error, parsed.status || 400);
    return {id, user, ...parsed};
  }
  let downloads = 0;
  async function download(input, res) {
    if (!validContainerPath(input.path)) throw apiError('invalid_file_request');
    if (input.user !== undefined && !Object.hasOwn(ADMIN_USERS, input.user)) throw apiError('invalid_user');
    await checked(input, {running: true});
    if (downloads >= 4) throw apiError('download_busy', 429);
    downloads++;
    try {
      await new Promise((resolve, reject) => {
        const child = launch('docker', ['exec', '-i', '--user', ADMIN_USERS[input.user || 'www-data'], container(input.id), 'python3', '-c', downloadProgram], {stdio: ['pipe', 'pipe', 'ignore'], env});
        let buffered = Buffer.alloc(0), started = false, settled = false;
        const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
        const timer = setTimeout(() => { child.kill('SIGKILL'); finish(started ? null : apiError('download_timeout', 504)); }, 30 * 60 * 1000);
        res.once('close', () => { if (!res.writableFinished) child.kill('SIGKILL'); });
        child.on('error', finish);
        child.stdin.on('error', () => {});
        child.stdout.on('data', chunk => {
          if (started) return;
          buffered = Buffer.concat([buffered, chunk]);
          const newline = buffered.indexOf(10);
          if (newline === -1) { if (buffered.length > 4096) { child.kill('SIGKILL'); finish(apiError('download_failed', 502)); } return; }
          child.stdout.pause();
          let header;
          try { header = JSON.parse(buffered.subarray(0, newline).toString('utf8')); } catch { child.kill('SIGKILL'); return finish(apiError('download_failed', 502)); }
          if (header.error) { child.kill('SIGKILL'); return finish(apiError(header.error, header.status || 400)); }
          started = true;
          const filename = String(header.name || 'download').replace(/[^\w.@+-]/g, '_').slice(0, 200) || 'download';
          res.writeHead(200, {'content-type': header.type === 'archive' ? 'application/gzip' : 'application/octet-stream', 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', ...(Number.isSafeInteger(header.size) ? {'content-length': header.size} : {})});
          const rest = buffered.subarray(newline + 1);
          if (rest.length) res.write(rest);
          child.stdout.pipe(res);
          child.stdout.resume();
        });
        child.on('close', () => finish(started ? null : apiError('download_failed', 502)));
        child.stdin.end(JSON.stringify({path: input.path}));
      });
    } finally { downloads--; }
  }
  return {record, tenants, stats, overview, detail, logs, exec, fs, download, containers};
}
