import {cp, mkdir, rm, access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
export async function buildAssets(root = path.dirname(fileURLToPath(import.meta.url))) {
  const dist = path.join(root, 'dist');
  await rm(dist, {recursive: true, force: true});
  await mkdir(dist, {recursive: true});
  await cp(path.join(root, '../dashboard/public'), dist, {recursive: true, filter: source => !source.includes(path.sep + 'vendor')});
  const editor = path.join(root, 'node_modules/monaco-editor/min/vs');
  await access(editor);
  await cp(editor, path.join(dist, 'vendor/monaco-0.52.2/vs'), {recursive: true});
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildAssets();
