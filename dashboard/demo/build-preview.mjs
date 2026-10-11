// Builds a single self-contained HTML file that runs the dashboard UI against fake data,
// for looking at the design without a node: node dashboard/demo/build-preview.mjs out.html
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = file => readFile(path.join(here, file), 'utf8');
const [styles, app, demo, favicon] = await Promise.all([read('../public/styles.css'), read('../public/app.js'), read('demo.js'), read('../public/favicon.svg')]);
const guard = text => text.replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spartan Cloud Admin</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(favicon.trim())}">
<style>${styles}</style>
</head>
<body>
<div id="root"></div>
<div class="toasts" id="toasts" aria-live="polite"></div>
<script>${guard(demo)}</script>
<script>${guard(app)}</script>
</body>
</html>
`;
const output = process.argv[2] || path.join(here, 'preview.html');
await writeFile(output, html);
console.log(output);
