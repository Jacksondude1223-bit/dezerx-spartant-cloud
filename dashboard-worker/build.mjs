import {cp, mkdir, rm, access, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
export async function buildAssets(root = path.dirname(fileURLToPath(import.meta.url))) {
  const dist = path.join(root, 'dist');
  await rm(dist, {recursive: true, force: true});
  await mkdir(dist, {recursive: true});
  await cp(path.join(root, '../dashboard/public'), dist, {recursive: true, filter: source => !source.includes(path.sep + 'vendor')});
  await cp(path.join(root, 'setup-public'), dist, {recursive: true});
  const index = path.join(dist, 'index.html');
  await writeFile(index, (await readFile(index, 'utf8')).replace('<script src="app.js" defer></script>', '<script src="cloud-firewall.js" defer></script>\n  <script src="app.js" defer></script>'));
  const editor = path.join(root, 'node_modules/monaco-editor/min/vs');
  await access(editor);
  await cp(editor, path.join(dist, 'vendor/monaco-0.52.2/vs'), {recursive: true});
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildAssets();
