import {apiError} from './management.mjs';

export function validFilePath(value) {
  return typeof value === 'string' && value.length <= 512 && !/[\\\x00-\x1f\x7f]/.test(value)
    && (value === '/.env' || /^\/(Modules|Themes)(?:\/[^/]+)*$/.test(value))
    && !value.split('/').some(part => part === '.' || part === '..');
}
export function validFileRequest(input) {
  if (!['list', 'download', 'upload', 'mkdir', 'delete', 'rename'].includes(input.action) || !validFilePath(input.path)) throw apiError('invalid_file_request');
  if (['delete', 'rename', 'upload'].includes(input.action) && ['/Modules', '/Themes'].includes(input.path)) throw apiError('protected_directory');
  if (input.action === 'rename' && (!validFilePath(input.destination) || input.destination === '/.env' || input.destination.split('/')[1] !== input.path.split('/')[1] || ['/Modules', '/Themes'].includes(input.destination))) throw apiError('invalid_destination');
  if (input.action === 'upload' && (typeof input.contentBase64 !== 'string' || input.contentBase64.length > 6 * 1024 * 1024 || input.contentBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.contentBase64) || Buffer.from(input.contentBase64, 'base64').toString('base64') !== input.contentBase64)) throw apiError('invalid_file_content');
}

export const fileProgram = String.raw`import os,sys,json,stat,base64,shutil,uuid,ctypes
def fail(message,status=400):
    print(json.dumps({'error':message,'status':status})); sys.exit(0)
def folder(path):
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for part in path.strip('/').split('/'):
            nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd); fd=nxt
        return fd
    except:
        os.close(fd); raise
try:
    data=json.load(sys.stdin); action=data['action']; path=data['path']
    parts=path.split('/')[1:]; section=parts.pop(0)
    if section not in ['Modules','Themes'] or any(not p or p in ['.','..'] for p in parts): fail('invalid_path')
    app=folder('/var/www/html'); os.close(app)
    storage=folder('/var/www/html/storage')
    try: os.mkdir('container',0o700,dir_fd=storage)
    except FileExistsError: pass
    os.close(storage)
    state=folder('/var/www/html/storage/container'); os.close(state)
    live='/var/www/html/'+section; kept='/var/www/html/storage/container/'+section
    if os.path.exists(live) and os.path.exists(kept) and os.path.samefile(live,kept):
        pass
    elif os.path.islink(live):
        if os.path.realpath(live)!=kept: fail('unsafe_symlink')
    else:
        if not os.path.exists(live): os.mkdir(live,0o755)
        if os.path.lexists(kept): fail('file_storage_conflict',409)
        staging=kept+'.init-'+uuid.uuid4().hex
        shutil.copytree(live,staging,symlinks=True)
        os.rename(staging,kept)
        temporary=live+'.link-'+uuid.uuid4().hex
        os.symlink(kept,temporary)
        libc=ctypes.CDLL(None,use_errno=True)
        if libc.renameat2(-100,live.encode(),-100,temporary.encode(),2)!=0:
            os.unlink(temporary); fail('persistent_files_setup_failed',409)
        shutil.rmtree(temporary)
    root=folder(kept); parent=root
    try:
        for part in parts[:-1]:
            nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
            if parent!=root: os.close(parent)
            parent=nxt
        name=parts[-1] if parts else '.'
        def checked(name,fd):
            info=os.stat(name,dir_fd=fd,follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode) or (stat.S_ISREG(info.st_mode) and info.st_nlink!=1): fail('unsafe_link')
            if not stat.S_ISREG(info.st_mode) and not stat.S_ISDIR(info.st_mode): fail('unsupported_file')
            return info
        if action=='list':
            fd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
            try:
                entries=[]
                for entry in sorted(os.listdir(fd)):
                    info=os.stat(entry,dir_fd=fd,follow_symlinks=False)
                    entries.append({'name':entry,'type':'link' if stat.S_ISLNK(info.st_mode) else 'directory' if stat.S_ISDIR(info.st_mode) else 'file','sizeBytes':info.st_size,'modifiedAt':info.st_mtime})
                    if len(entries)>2000: fail('directory_too_large',413)
                print(json.dumps({'path':path,'entries':entries,'persistent':True}))
            finally: os.close(fd)
        elif action=='download':
            info=checked(name,parent)
            fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parent)
            try:
                info=os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1: fail('unsafe_file')
                if info.st_size>4194304: fail('file_too_large',413)
                with os.fdopen(fd,'rb',closefd=False) as source: content=source.read(4194305)
                if len(content)>4194304: fail('file_too_large',413)
                print(json.dumps({'path':path,'contentBase64':base64.b64encode(content).decode(),'persistent':True}))
            finally: os.close(fd)
        elif action=='upload':
            try:
                info=checked(name,parent)
                if not stat.S_ISREG(info.st_mode): fail('not_a_file')
            except FileNotFoundError: pass
            content=base64.b64decode(data['contentBase64'],validate=True)
            if len(content)>4194304: fail('file_too_large',413)
            temporary='.upload-'+uuid.uuid4().hex
            fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644,dir_fd=parent)
            try:
                with os.fdopen(fd,'wb',closefd=False) as target: target.write(content); target.flush(); os.fsync(fd)
                os.rename(temporary,name,src_dir_fd=parent,dst_dir_fd=parent)
            finally:
                os.close(fd)
                try: os.unlink(temporary,dir_fd=parent)
                except FileNotFoundError: pass
            print(json.dumps({'path':path,'writtenBytes':len(content),'persistent':True}))
        elif action=='mkdir':
            os.mkdir(name,0o755,dir_fd=parent); print(json.dumps({'path':path,'created':True,'persistent':True}))
        elif action=='delete':
            info=checked(name,parent)
            if stat.S_ISDIR(info.st_mode): os.rmdir(name,dir_fd=parent)
            else: os.unlink(name,dir_fd=parent)
            print(json.dumps({'path':path,'deleted':True,'persistent':True}))
        elif action=='rename':
            destination=data['destination'].split('/')[2:]
            if not destination or any(not p or p in ['.','..'] for p in destination): fail('invalid_destination')
            dest=os.dup(root)
            try:
                for part in destination[:-1]:
                    nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=dest); os.close(dest); dest=nxt
                checked(name,parent)
                libc=ctypes.CDLL(None,use_errno=True)
                if libc.renameat2(parent,name.encode(),dest,destination[-1].encode(),1)!=0: fail('rename_failed',409)
                print(json.dumps({'path':path,'destination':data['destination'],'renamed':True,'persistent':True}))
            finally: os.close(dest)
        else: fail('invalid_action')
    finally:
        if parent!=root: os.close(parent)
        os.close(root)
except FileNotFoundError: fail('file_not_found',404)
except FileExistsError: fail('file_exists',409)
except OSError: fail('unsafe_or_unavailable_path',409)
except Exception: fail('file_operation_failed',400)
`;
