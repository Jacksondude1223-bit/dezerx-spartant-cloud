(() => {
'use strict';

/* ---------------------------------------------------------------- API */
const demo = window.SPARTAN_DEMO || null;
let csrf = '';
class ApiError extends Error { constructor(code, status) { super(code); this.code = code; this.status = status; } }
const api = {
  async request(method, path, body) {
    if (demo) return demo.request(method, path, body);
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET') headers['x-csrf-token'] = csrf;
    const response = await fetch(path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin'});
    let data = null;
    try { data = await response.json(); } catch {}
    if (response.status === 401 && path !== '/api/login') { state.session = null; render(); throw new ApiError('not_signed_in', 401); }
    if (!response.ok) throw new ApiError((data && data.error) || `http_${response.status}`, response.status);
    return data;
  },
  get(path) { return this.request('GET', path); },
  post(path, body = {}) { return this.request('POST', path, body); },
  download(path) {
    if (demo) return demo.download(path);
    const link = h('a', {href: path, download: ''});
    document.body.append(link); link.click(); link.remove();
  }
};
const MESSAGES = {
  node_unreachable: 'The node could not be reached.', node_timeout: 'The node took too long to answer.',
  still_running_on_node: 'Still running on the node. Refresh in a minute to see the result.',
  blocked_by_cloudflare: 'Cloudflare blocked the request. Exempt the node hostnames from challenges.',
  not_found: 'Not found. Is ADMIN_API_SECRET set on this node?', unauthorized: 'The node rejected the admin signature. Check that ADMIN_API_SECRET matches.',
  permission_denied: 'Permission denied. Try again running as root.', file_exists: 'Something with that name already exists.',
  directory_not_empty: 'The folder is not empty.', protected_path: 'This path is protected and cannot be changed this way.',
  file_changed: 'The file changed on disk after you opened it.', file_too_large: 'The file is larger than 4 MB. Download it instead.',
  container_not_running: 'The container is not running.', service_suspended: 'This tenant is suspended. Resume it from the master website.',
  console_busy: 'Too many commands are running. Try again shortly.', rate_limited: 'Too many requests. Slow down for a minute.',
  csrf_failed: 'Your session expired. Reload the page.', invalid_credentials: 'Incorrect username or password.',
  too_many_attempts: 'Too many sign-in attempts. Wait 15 minutes.', not_provisioned: 'This tenant is not provisioned on this node.',
  node_update_in_progress: 'The node is applying an update. Try again shortly.', service_not_ready: 'The tenant is not ready.',
  invalid_archive: 'That archive could not be read.', unsupported_archive: 'Only .zip and .tar(.gz/.bz2/.xz) archives can be extracted.',
  not_a_file: 'That is not a regular file.', not_a_directory: 'That is not a folder.', file_not_found: 'File not found.',
  primary_node_required: 'Database downloads are only available on the primary node.', unknown_owner: 'Unknown user or group.',
  symlink_mode: 'Symbolic links have no permissions of their own.', no_space_left: 'The disk is full.', python_unavailable: 'python3 is missing from this container image.'
};
const explain = error => MESSAGES[error?.code || error?.message] || String(error?.code || error?.message || 'Something went wrong').replace(/_/g, ' ');

/* ---------------------------------------------------------------- DOM helpers */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'value') el.value = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) el.append(child instanceof Node ? child : String(child));
  return el;
}
const ICONS = {
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  server: '<rect x="3" y="3" width="18" height="8" rx="2"/><rect x="3" y="13" width="18" height="8" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
  cube: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  memory: '<rect x="2" y="7" width="20" height="10" rx="2"/><path d="M6 11v2M10 11v2M14 11v2M18 11v2M6 17v3M18 17v3"/>',
  disk: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderPlus: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  filePlus: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 12v6M9 15h6"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1 1"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1-1"/>',
  terminal: '<path d="m4 17 6-5-6-5M12 19h8"/>',
  logs: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  play: '<path d="m7 4 13 8-13 8z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  upload: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
  arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  archive: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>'
};
function icon(name) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('class', 'icon');
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = ICONS[name] || '';
  return el;
}
const button = (label, {icon: name, kind = '', onClick, title, disabled, small} = {}) => h('button', {type: 'button', class: `btn ${kind} ${small ? 'small' : ''}`.trim(), onclick: onClick, title, disabled}, name ? icon(name) : null, label);

/* ---------------------------------------------------------------- formatting */
function bytes(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0, n = value;
  while (n >= 1024 && index < units.length - 1) { n /= 1024; index++; }
  return `${n >= 100 || index === 0 ? Math.round(n) : n.toFixed(digits)} ${units[index]}`;
}
// Docker prints sizes such as "818.4MiB" or "1.2kB".
function dockerSize(text) {
  const m = String(text || '').trim().match(/^([\d.]+)\s*([kmgt]?i?b)$/i);
  if (!m) return null;
  const unit = m[2].toLowerCase();
  const scale = {b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4}[unit];
  return scale ? Number(m[1]) * scale : null;
}
const pct = value => value === null || value === undefined || !Number.isFinite(value) ? '—' : `${value < 10 && value > 0 ? value.toFixed(1) : Math.round(value)}%`;
function ago(time) {
  const ms = typeof time === 'number' ? Date.now() - time : Date.now() - Date.parse(time);
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s} seconds ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const hr = Math.round(m / 60); if (hr < 48) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const d = Math.round(hr / 24); return `${d} days ago`;
}
function duration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const d = Math.floor(seconds / 86400), hr = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60);
  return d ? `${d}d ${hr}h` : hr ? `${hr}h ${m}m` : `${m}m`;
}
const when = epoch => { const d = new Date(epoch * 1000); return Number.isFinite(d.getTime()) ? d.toLocaleString(undefined, {year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}) : '—'; };
const shortImage = image => { const m = String(image || '').match(/^(.*?)@sha256:([a-f0-9]{12})/); return m ? `${m[1].split('/').pop()}@${m[2]}` : image || '—'; };
const hostOf = tenant => { try { return new URL(tenant.activeUrl || tenant.url).host; } catch { return tenant.id; } };
const regionName = region => ({us: 'United States', de: 'Germany'})[region] || region.toUpperCase();
function hue(text) { let x = 0; for (const c of String(text)) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x % 360; }
function appIcon(text) {
  const hueValue = hue(text);
  return h('span', {class: 'app-icon', style: {color: `hsl(${hueValue} 55% 38%)`, background: `hsl(${hueValue} 70% 97%)`}}, String(text).replace(/^www\./, '').charAt(0) || '?');
}
function tenantStatus(t) {
  if (t.status === 'terminated') return {label: 'Terminated', tone: ''};
  if (t.status === 'suspended') return {label: 'Suspended', tone: ''};
  if (t.status === 'provisioning') return {label: 'Provisioning', tone: 'amber'};
  if (t.status === 'unreadable_state' || t.status === 'missing_state') return {label: 'State unreadable', tone: 'red'};
  if (t.container?.state === 'missing') return {label: 'No container', tone: 'red'};
  const running = t.container ? t.container.running : t.running;
  if (running === undefined) return {label: 'Unknown', tone: ''};
  if (running === false) return {label: 'Stopped', tone: 'red'};
  if (t.applicationHealthy === false) return {label: 'Unhealthy', tone: 'amber'};
  return {label: 'Running', tone: 'green'};
}
const statusCell = t => { const s = tenantStatus(t); return h('span', {class: 'status'}, h('span', {class: `dot ${s.tone}`}), s.label); };
function segbar(value) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  const on = Math.round(v / 5);
  return h('span', {class: `segbar ${v >= 85 ? 'hot' : v >= 50 ? 'warm' : ''}`}, Array.from({length: 20}, (_, i) => h('i', {class: i < on ? 'on' : ''})));
}
const usage = value => h('span', {class: 'usage'}, segbar(value), h('span', {class: 'pct'}, pct(value)));
function meter(fraction) {
  const v = Math.max(0, Math.min(1, Number(fraction) || 0));
  return h('div', {class: `meter ${v >= .9 ? 'hot' : v >= .75 ? 'warm' : ''}`}, h('i', {style: {width: `${(v * 100).toFixed(1)}%`}}));
}
const joinPath = (dir, name) => dir === '/' ? `/${name}` : `${dir}/${name}`;
const parentOf = p => p === '/' ? '/' : p.slice(0, p.lastIndexOf('/')) || '/';
function toBase64(bytesValue) { let s = ''; for (let i = 0; i < bytesValue.length; i += 0x8000) s += String.fromCharCode.apply(null, bytesValue.subarray(i, i + 0x8000)); return btoa(s); }
function fromBase64(text) { const s = atob(text); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }
const randomHex = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');

/* ---------------------------------------------------------------- toasts, menus, dialogs */
function toast(message, {error = false, timeout = 4200, progress = null} = {}) {
  const text = h('div', null, message);
  const bar = progress === null ? null : h('div', {class: 'progress'}, h('i', {style: {width: `${progress}%`}}));
  const el = h('div', {class: `toast ${error ? 'error' : ''}`, role: error ? 'alert' : 'status'}, icon(error ? 'alert' : 'info'), h('div', {style: {flex: '1', minWidth: '0'}}, text, bar));
  document.getElementById('toasts').append(el);
  let timer = timeout ? setTimeout(() => el.remove(), timeout) : null;
  return {update(next, value) { text.textContent = next; if (bar && value !== undefined) bar.firstChild.style.width = `${value}%`; }, close(after = 0) { clearTimeout(timer); timer = setTimeout(() => el.remove(), after); }};
}
const fail = error => { if (error?.code !== 'not_signed_in') toast(explain(error), {error: true, timeout: 7000}); };
let openMenuEl = null;
function closeMenu() { if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; } }
function openMenu(anchor, items) {
  closeMenu();
  const menu = h('div', {class: 'menu', role: 'menu'}, items.map(item => item === '-' ? h('hr') : h('button', {type: 'button', class: item.danger ? 'danger' : '', role: 'menuitem', onclick: () => { closeMenu(); item.onClick(); }}, icon(item.icon), item.label)));
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth, height = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
  menu.style.top = `${rect.bottom + 6 + height > window.innerHeight ? Math.max(8, rect.top - height - 6) : rect.bottom + 6}px`;
  openMenuEl = menu;
  setTimeout(() => menu.querySelector('button')?.focus(), 0);
}
document.addEventListener('mousedown', event => { if (openMenuEl && !openMenuEl.contains(event.target)) closeMenu(); });
window.addEventListener('scroll', closeMenu, true);

function modal({title, body, actions = [], wide = false, onClose}) {
  const dialog = h('div', {class: `dialog ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title});
  const backdrop = h('div', {class: 'backdrop'}, dialog);
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  // Only the top-most dialog answers Escape, so a confirm over the editor closes alone.
  const onKey = event => { if (event.key === 'Escape' && backdrop === [...document.querySelectorAll('.backdrop')].pop()) { event.preventDefault(); close(); } };
  backdrop.addEventListener('mousedown', event => { if (event.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  if (title) dialog.append(h('header', null, h('h3', null, title)));
  if (body) dialog.append(body);
  if (actions.length) dialog.append(h('footer', null, actions));
  document.body.append(backdrop);
  return {close, dialog};
}
function confirmDialog({title, message, confirm = 'Confirm', danger = false}) {
  return new Promise(resolve => {
    let done = false;
    const finish = value => { if (!done) { done = true; resolve(value); } ref.close(); };
    const ok = button(confirm, {kind: danger ? 'danger solid' : 'primary', onClick: () => finish(true)});
    const ref = modal({title, body: h('div', {class: 'body'}, (Array.isArray(message) ? message : [message]).map(text => h('p', null, text))), actions: [button('Cancel', {onClick: () => finish(false)}), ok], onClose: () => { if (!done) { done = true; resolve(false); } }});
    setTimeout(() => ok.focus(), 0);
  });
}
function promptDialog({title, label, value = '', confirm = 'Save', mono = true, hint}) {
  return new Promise(resolve => {
    let done = false;
    const input = h('input', {class: `input ${mono ? 'mono' : ''}`, value, spellcheck: 'false', autocomplete: 'off'});
    const finish = result => { if (!done) { done = true; resolve(result); } ref.close(); };
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); finish(input.value.trim()); } });
    const ref = modal({title, body: h('div', {class: 'body'}, h('label', {class: 'field'}, h('span', null, label), input), hint ? h('p', {class: 'muted'}, hint) : null), actions: [button('Cancel', {onClick: () => finish(null)}), button(confirm, {kind: 'primary', onClick: () => finish(input.value.trim())})], onClose: () => { if (!done) { done = true; resolve(null); } }});
    setTimeout(() => { input.focus(); const dot = value.lastIndexOf('.'); input.setSelectionRange(0, dot > 0 ? dot : value.length); }, 0);
  });
}

/* ---------------------------------------------------------------- state & routing */
const state = {session: null, overview: null, overviewAt: 0, overviewError: null, details: new Map(), consoles: new Map(), files: new Map(), logs: new Map(), view: 0, timers: []};
function route() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [pathPart, query = ''] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  return {parts, query: new URLSearchParams(query)};
}
const go = hash => { if (location.hash === hash) render(); else location.hash = hash; };
function every(ms, task) { const id = setInterval(() => { if (!document.hidden) task(); }, ms); state.timers.push(id); }
function clearTimers() { state.timers.forEach(clearInterval); state.timers = []; }
async function overview(force = false) {
  if (!force && state.overview && Date.now() - state.overviewAt < 8000) return state.overview;
  try { state.overview = await api.get('/api/overview'); state.overviewAt = Date.now(); state.overviewError = null; }
  catch (error) { state.overviewError = error; if (!state.overview) throw error; }
  return state.overview;
}
const allTenants = data => data.nodes.filter(n => n.ok).flatMap(n => n.tenants.map(t => ({...t, region: n.region})));
const nodeOf = (data, region) => data.nodes.find(n => n.region === region);
function nodeTone(n) { if (!n) return {tone: 'red', label: 'Unknown'}; if (!n.ok) return {tone: 'red', label: 'Unreachable'}; if (n.node.status !== 'ready') return {tone: 'amber', label: 'Degraded'}; return {tone: 'green', label: 'Agent online'}; }

/* ---------------------------------------------------------------- shell */
function sidebar(current) {
  const nodes = state.session?.nodes || [];
  const item = (hash, name, label, active, extra) => h('a', {class: `nav-item ${active ? 'active' : ''}`, href: hash}, icon(name), label, extra);
  return h('aside', {class: 'sidebar'},
    h('div', {class: 'brand'}, h('span', {class: 'brand-mark'}, icon('cube')), state.session?.label || 'Spartan Cloud'),
    item('#/', 'home', 'Home', current === 'home'),
    h('div', {class: 'nav-label'}, 'Infrastructure'),
    nodes.map(n => { const tone = nodeTone(state.overview && nodeOf(state.overview, n.region)); return item(`#/node/${n.region}`, 'server', `node-${n.region}`, current === `node:${n.region}`, h('span', {class: `dot ${state.overview ? tone.tone : ''}`, title: tone.label})); }),
    item('#/tenants', 'layers', 'Tenants', current === 'tenants'),
    h('div', {class: 'nav-label'}, 'Monitoring'),
    item('#/activity', 'activity', 'Activity', current === 'activity'),
    h('div', {class: 'nav-spacer'}),
    h('div', {class: 'user-chip'}, h('span', {class: 'avatar'}, (state.session?.user || '?').charAt(0)), h('span', {class: 'who'}, state.session?.user), h('button', {type: 'button', title: 'Sign out', 'aria-label': 'Sign out', onclick: signOut}, icon('logout'))));
}
async function signOut() { try { await api.post('/api/logout'); } catch {} state.session = null; state.overview = null; render(); }
function crumbs(items) { return h('nav', {class: 'crumbs', 'aria-label': 'Breadcrumb'}, items.map((it, i) => [i ? h('span', {class: 'sep'}, '›') : null, it.href ? h('a', {href: it.href}, it.label) : h('span', {class: 'here'}, it.label)])); }
function pageHead({title, pill, meta = [], actions = []}) {
  return h('div', {class: 'page-head'},
    h('div', {style: {minWidth: '0'}}, h('div', {class: 'title-row'}, h('h1', null, title), pill ? h('span', {class: `pill ${pill.tone || ''}`}, pill.label) : null), meta.length ? h('div', {class: 'meta mono'}, meta.filter(Boolean).map(m => h('span', null, m))) : null),
    h('div', {class: 'actions'}, actions));
}
function statCard(name, label, value, suffix, foot) {
  return h('div', {class: 'card stat'}, h('div', {class: 'stat-head'}, h('span', {class: 'stat-icon'}, icon(name)), label), h('div', {class: 'stat-value'}, h('strong', null, value), suffix ? h('span', null, suffix) : null), foot ? h('div', {class: 'stat-foot'}, foot) : null);
}
function tabs(items, active, onSelect) {
  return h('div', {class: 'tabs', role: 'tablist'}, items.map(([key, label, name]) => h('button', {type: 'button', role: 'tab', 'aria-selected': String(key === active), class: `tab ${key === active ? 'active' : ''}`, onclick: () => onSelect(key)}, name ? icon(name) : null, label)));
}
const loading = () => h('div', {class: 'loading'}, h('span', {class: 'spinner'}), 'Loading…');
// Pages build their content as nested arrays with optional (null) parts.
const flatNodes = nodes => [nodes].flat(Infinity).filter(node => node !== null && node !== undefined && node !== false);
const errorBox = (error, retry) => h('div', {class: 'card'}, h('div', {class: 'empty'}, h('strong', null, 'Could not load this page'), explain(error), retry ? h('div', {style: {marginTop: '14px'}}, button('Try again', {icon: 'refresh', onClick: retry})) : null));

async function render() {
  clearTimers();
  closeMenu();
  const token = ++state.view;
  const root = document.getElementById('root');
  if (!state.session) {
    try { const session = await api.get('/api/session'); if (session.authenticated) { state.session = session; csrf = session.csrf; } else { state.label = session.label; } }
    catch { /* shown as login */ }
    if (token !== state.view) return;
    if (!state.session) { root.replaceChildren(loginPage()); return; }
  }
  const {parts, query} = route();
  const panel = h('div', {class: 'panel'}, loading());
  const key = parts[0] === 'node' ? `node:${parts[1]}` : parts[0] || 'home';
  root.replaceChildren(h('div', {class: 'app'}, sidebar(parts[0] === 'tenant' ? `node:${parts[1]}` : key), h('main', {class: 'main'}, panel)));
  const fill = nodes => { if (token === state.view) panel.replaceChildren(...flatNodes(nodes)); };
  const refreshSidebar = () => { if (token === state.view) root.querySelector('.sidebar')?.replaceWith(sidebar(parts[0] === 'tenant' ? `node:${parts[1]}` : key)); };
  const ctx = {token, fill, query, refreshSidebar, alive: () => token === state.view};
  try {
    if (!parts.length) await homePage(ctx);
    else if (parts[0] === 'tenants') await tenantsPage(ctx);
    else if (parts[0] === 'activity') await activityPage(ctx);
    else if (parts[0] === 'node' && /^(us|de)$/.test(parts[1])) await nodePage(ctx, parts[1]);
    else if (parts[0] === 'tenant' && /^(us|de)$/.test(parts[1]) && /^t-[a-f0-9]{24}$/.test(parts[2] || '')) await tenantPage(ctx, parts[1], parts[2], parts[3] || 'overview');
    else fill(errorBox(new ApiError('not_found')));
  } catch (error) { if (error?.code !== 'not_signed_in') fill(errorBox(error, render)); }
}
window.addEventListener('hashchange', render);

/* ---------------------------------------------------------------- login */
function loginPage() {
  const user = h('input', {class: 'input', name: 'username', autocomplete: 'username', required: true});
  const pass = h('input', {class: 'input', name: 'password', type: 'password', autocomplete: 'current-password', required: true});
  const message = h('div', {class: 'banner error', style: {display: 'none'}});
  const submit = h('button', {type: 'submit', class: 'btn primary'}, 'Sign in');
  const form = h('form', {onsubmit: async event => {
    event.preventDefault();
    submit.disabled = true; message.style.display = 'none';
    try {
      const session = await api.post('/api/login', {username: user.value, password: pass.value});
      csrf = session.csrf; state.session = null; render();
    } catch (error) { message.replaceChildren(icon('alert'), explain(error)); message.style.display = ''; pass.value = ''; pass.focus(); }
    finally { submit.disabled = false; }
  }}, message, h('label', {class: 'field'}, h('span', null, 'Username'), user), h('label', {class: 'field'}, h('span', null, 'Password'), pass), submit);
  setTimeout(() => user.focus(), 0);
  return h('div', {class: 'login'}, h('div', {class: 'card'}, h('div', {class: 'brand'}, h('span', {class: 'brand-mark'}, icon('cube')), state.label || 'Spartan Cloud'), h('h1', null, 'Sign in'), h('p', null, 'Operator access to your nodes and tenants.'), form));
}

/* ---------------------------------------------------------------- tenant table */
function tenantTable(list, {region = true, empty = 'No tenants yet'} = {}) {
  if (!list.length) return h('div', {class: 'card'}, h('div', {class: 'empty'}, h('strong', null, empty), 'Tenants appear here once the master website provisions them.'));
  const rows = list.map(t => {
    const r = t.resources;
    return h('tr', {class: 'clickable', tabindex: '0', onclick: () => go(`#/tenant/${t.region}/${t.id}`), onkeydown: e => { if (e.key === 'Enter') go(`#/tenant/${t.region}/${t.id}`); }},
      h('td', null, h('div', {class: 'name-cell'}, appIcon(hostOf(t)), h('div', {class: 'text'}, h('div', {class: 'primary-text'}, hostOf(t)), h('div', {class: 'sub mono'}, t.id)))),
      h('td', null, statusCell(t)),
      h('td', null, r ? usage(r.cpuPercent) : h('span', {class: 'faint'}, '—')),
      h('td', null, r ? h('span', null, bytes(r.memoryUsedBytes), h('span', {class: 'faint'}, ` / ${bytes(r.memoryLimitBytes, 0)}`)) : h('span', {class: 'faint'}, '—')),
      h('td', null, region ? `${t.region.toUpperCase()} · ${t.role || '—'}` : t.role || '—'),
      h('td', {class: 'right mono'}, t.port ? String(t.port) : '—'));
  });
  return h('div', {class: 'card table-card'}, h('div', {class: 'table-scroll'}, h('table', null,
    h('thead', null, h('tr', null, h('th', null, 'Tenant'), h('th', null, 'Status'), h('th', null, 'CPU'), h('th', null, 'Memory'), h('th', null, region ? 'Region · role' : 'Role'), h('th', {class: 'right'}, 'Port'))),
    h('tbody', null, rows))));
}

/* ---------------------------------------------------------------- home */
async function homePage(ctx) {
  const draw = data => {
    const online = data.nodes.filter(n => n.ok);
    const tenants = allTenants(data);
    const runningCount = tenants.filter(t => t.container?.running).length;
    const memUsed = online.reduce((s, n) => s + n.node.resources.memory.usedBytes, 0);
    const memTotal = online.reduce((s, n) => s + n.node.resources.memory.totalBytes, 0);
    const cpu = online.length ? online.reduce((s, n) => s + (n.node.resources.cpu.usagePercent || 0), 0) / online.length : null;
    const tone = online.length === data.nodes.length ? 'green' : online.length ? 'amber' : 'red';
    ctx.fill([
      crumbs([{label: state.session.label}, {label: 'Overview'}]),
      pageHead({title: 'Overview', pill: {tone, label: `${online.length} of ${data.nodes.length} nodes online`}, meta: [...data.nodes.map(n => n.host), `${tenants.length} tenants`], actions: [button('Refresh', {icon: 'refresh', onClick: () => refresh(true)}), h('a', {class: 'btn primary', href: '#/tenants'}, icon('layers'), 'All tenants')]}),
      h('div', {class: 'cards'},
        statCard('cpu', 'CPU', pct(cpu), 'fleet average'),
        statCard('memory', 'Memory used', bytes(memUsed), `of ${bytes(memTotal, 0)}`),
        statCard('layers', 'Tenants', String(tenants.length), `${runningCount} running`)),
      h('div', {class: 'section'}, h('div', {class: 'section-head'}, h('h2', null, 'Nodes'), h('span', {class: 'note'}, `Last refresh: ${ago(state.overviewAt)}`)), h('div', {class: 'node-grid'}, data.nodes.map(nodeCard))),
      h('div', {class: 'section'}, h('div', {class: 'section-head'}, h('h2', null, 'Busiest tenants'), h('a', {class: 'note', href: '#/tenants'}, 'View all →')), tenantTable([...tenants].sort((a, b) => (b.resources?.cpuPercent || 0) - (a.resources?.cpuPercent || 0)).slice(0, 8)))]);
    ctx.refreshSidebar();
  };
  const refresh = async force => { try { draw(await overview(force)); } catch (error) { if (ctx.alive()) fail(error); } };
  draw(await overview());
  every(15000, () => refresh(true));
}
function nodeCard(n) {
  const tone = nodeTone(n);
  if (!n.ok) return h('a', {class: 'card node-card', href: `#/node/${n.region}`}, h('div', {class: 'top'}, h('h3', null, `node-${n.region}`), h('span', {class: `pill ${tone.tone}`}, tone.label)), h('div', {class: 'host mono'}, n.host), h('div', {class: 'banner error', style: {marginTop: '16px', marginBottom: '0'}}, icon('alert'), explain(new ApiError(n.error))));
  const r = n.node.resources;
  const running = n.tenants.filter(t => t.container?.running).length;
  const row = (label, fraction, value) => h('div', {class: 'metric-row'}, h('span', null, label), meter(fraction), h('span', {class: 'value'}, value));
  return h('a', {class: 'card node-card', href: `#/node/${n.region}`},
    h('div', {class: 'top'}, h('h3', null, `node-${n.region}`), h('span', {class: `pill ${tone.tone}`}, tone.label)),
    h('div', {class: 'host mono'}, `${n.host} · ${regionName(n.region)}`),
    h('div', {class: 'metric-rows'},
      row('CPU', (r.cpu.usagePercent || 0) / 100, `${pct(r.cpu.usagePercent)} · ${r.cpu.cores} cores`),
      row('Memory', r.memory.usedBytes / r.memory.totalBytes, `${bytes(r.memory.usedBytes)} / ${bytes(r.memory.totalBytes, 0)}`),
      row('Disk', r.disk.usedBytes / r.disk.totalBytes, `${bytes(r.disk.usedBytes)} / ${bytes(r.disk.totalBytes, 0)}`)),
    h('div', {class: 'foot'}, h('span', null, `${n.tenants.length} tenants · ${running} running`), h('span', null, `up ${duration(r.uptimeSeconds)}`)));
}

/* ---------------------------------------------------------------- tenants list */
async function tenantsPage(ctx) {
  let filter = ctx.query.get('q') || '';
  let regionFilter = 'all';
  const tableSlot = h('div');
  const draw = data => {
    const q = filter.toLowerCase();
    const list = allTenants(data).filter(t => (regionFilter === 'all' || t.region === regionFilter) && (!q || hostOf(t).toLowerCase().includes(q) || t.id.includes(q) || (t.plan || '').includes(q) || tenantStatus(t).label.toLowerCase().includes(q)));
    tableSlot.replaceChildren(tenantTable(list, {empty: filter ? 'No tenants match' : 'No tenants yet'}));
  };
  const data = await overview();
  const search = h('input', {class: 'input', placeholder: 'Search domain, ID, plan or status', value: filter, oninput: e => { filter = e.target.value; draw(state.overview); }});
  const regionSelect = h('select', {class: 'select', onchange: e => { regionFilter = e.target.value; draw(state.overview); }}, h('option', {value: 'all'}, 'All regions'), data.nodes.map(n => h('option', {value: n.region}, regionName(n.region))));
  const unreachable = data.nodes.filter(n => !n.ok);
  ctx.fill([
    crumbs([{label: state.session.label, href: '#/'}, {label: 'Tenants'}]),
    pageHead({title: 'Tenants', pill: {tone: 'green', label: `${allTenants(data).length} provisioned`}, meta: ['Every tenant on every node'], actions: [button('Refresh', {icon: 'refresh', onClick: async () => { try { draw(await overview(true)); } catch (e) { fail(e); } }})]}),
    unreachable.map(n => h('div', {class: 'banner error'}, icon('alert'), `node-${n.region} is unreachable, so its tenants are missing from this list. ${explain(new ApiError(n.error))}`)),
    h('div', {class: 'section-head'}, h('div', {class: 'group', style: {display: 'flex', gap: '8px', flexWrap: 'wrap'}}, h('div', {class: 'search'}, icon('search'), search), regionSelect), h('span', {class: 'note'}, `Last refresh: ${ago(state.overviewAt)}`)),
    tableSlot]);
  draw(data);
  every(15000, async () => { try { draw(await overview(true)); } catch {} });
}

/* ---------------------------------------------------------------- node */
async function nodePage(ctx, region) {
  let tab = ctx.query.get('tab') || 'tenants';
  const draw = data => {
    const n = nodeOf(data, region);
    if (!n) return ctx.fill(errorBox(new ApiError('unknown_node')));
    const tone = nodeTone(n);
    const head = [crumbs([{label: state.session.label, href: '#/'}, {label: 'Nodes'}, {label: `node-${region}`}]),
      pageHead({title: `node-${region}`, pill: tone, meta: n.ok ? [n.host, regionName(region), `docker ${n.node.dockerReady ? 'ready' : 'down'}`, `mariadb ${n.node.databaseReady ? 'ready' : 'down'}`, `up ${duration(n.node.resources.uptimeSeconds)}`] : [n.host, regionName(region)], actions: [button('Refresh', {icon: 'refresh', onClick: async () => { try { draw(await overview(true)); } catch (e) { fail(e); } }})]})];
    if (!n.ok) return ctx.fill([...head, h('div', {class: 'banner error'}, icon('alert'), explain(new ApiError(n.error))), h('div', {class: 'card'}, h('div', {class: 'empty'}, h('strong', null, 'This node did not answer'), 'Check that spartan-agent and spartan-tunnel are running, that ADMIN_API_SECRET is set on the node, and that the node hostname is not behind a Cloudflare challenge.'))]);
    const r = n.node.resources;
    const running = n.tenants.filter(t => t.container?.running).length;
    const tenants = n.tenants.map(t => ({...t, region}));
    const select = key => { tab = key; history.replaceState(null, '', `#/node/${region}${key === 'tenants' ? '' : `?tab=${key}`}`); draw(state.overview); };
    const body = tab === 'resources' ? resourcesTab(n, tenants) : [
      h('div', {class: 'cards'},
        statCard('cpu', 'CPU', pct(r.cpu.usagePercent), 'right now'),
        statCard('memory', 'Memory used', bytes(r.memory.usedBytes), `of ${bytes(r.memory.totalBytes, 0)}`),
        statCard('layers', 'Tenants', String(n.tenants.length), `${running} running`)),
      h('div', {class: 'section-head'}, h('h2', null, 'Running and provisioned tenants'), h('span', {class: 'note'}, `Last refresh: ${ago(state.overviewAt)}`)),
      tenantTable(tenants, {region: false})];
    ctx.fill([...head, tabs([['tenants', 'Tenants'], ['resources', 'Resources']], tab, select), body]);
    ctx.refreshSidebar();
  };
  draw(await overview());
  every(10000, async () => { try { draw(await overview(true)); } catch {} });
}
function resourcesTab(n, tenants) {
  const r = n.node.resources;
  const top = [...tenants].filter(t => t.resources).sort((a, b) => (b.resources.memoryUsedBytes || 0) - (a.resources.memoryUsedBytes || 0)).slice(0, 10);
  return [
    h('div', {class: 'cards'},
      statCard('disk', 'Disk used', bytes(r.disk.usedBytes), `of ${bytes(r.disk.totalBytes, 0)}`, meter(r.disk.usedBytes / r.disk.totalBytes)),
      statCard('activity', 'Load average', (r.cpu.loadAverage[0] || 0).toFixed(2), `${(r.cpu.loadAverage[1] || 0).toFixed(2)} · ${(r.cpu.loadAverage[2] || 0).toFixed(2)} · ${r.cpu.cores} cores`),
      statCard('clock', 'Uptime', duration(r.uptimeSeconds), `sampled ${ago(n.node.sampledAt)}`)),
    h('div', {class: 'section'}, h('div', {class: 'section-head'}, h('h2', null, 'Host')), h('div', {class: 'card'}, h('dl', {class: 'details'},
      detail('Docker', n.node.dockerReady ? 'Ready' : 'Unavailable'), detail('MariaDB', n.node.databaseReady ? 'Ready' : 'Unavailable'),
      detail('Memory free', bytes(r.memory.freeBytes)), detail('Disk available', bytes(r.disk.availableBytes)),
      detail('Agent latency', n.latencyMs !== undefined ? `${n.latencyMs} ms` : '—'), detail('Region', regionName(n.region))))),
    h('div', {class: 'section'}, h('div', {class: 'section-head'}, h('h2', null, 'Top memory consumers')), tenantTable(top, {region: false, empty: 'No running containers'}))];
}
const detail = (label, value) => h('div', null, h('dt', null, label), h('dd', {title: typeof value === 'string' ? value : null}, value));

/* ---------------------------------------------------------------- tenant */
async function loadDetail(region, id, force = false) {
  const key = `${region}/${id}`;
  const cached = state.details.get(key);
  if (!force && cached && Date.now() - cached.at < 10000) return cached.data;
  const data = await api.get(`/api/nodes/${region}/tenants/${id}/detail`);
  state.details.set(key, {at: Date.now(), data});
  return data;
}
async function tenantPage(ctx, region, id, tab) {
  const base = `/api/nodes/${region}/tenants/${id}`;
  let data = await loadDetail(region, id);
  const content = h('div');
  const t = {...data, region};
  const host = hostOf(t);
  const running = data.container?.running === true;
  const status = tenantStatus({...t, container: data.container});
  const act = async (label, path, body, {confirmText, danger} = {}) => {
    if (confirmText && !await confirmDialog({title: label, message: confirmText, confirm: label, danger})) return;
    const note = toast(`${label}…`, {timeout: 0});
    try { await api.post(`${base}/${path}`, body); note.update(`${label}: done`); note.close(2500); state.overview = null; await loadDetail(region, id, true); if (ctx.alive()) render(); }
    catch (error) { note.close(); fail(error); }
  };
  const actions = [
    button('Reload', {icon: 'zap', title: 'Clear Laravel caches and reload Octane workers', disabled: !running, onClick: () => act('Reload', 'reload', {})}),
    running ? button('Restart', {icon: 'refresh', onClick: () => act('Restart', 'container', {action: 'restart'}, {confirmText: `Restart the container for ${host}? Visitors see errors for a few seconds.`})})
      : button('Start', {icon: 'play', disabled: ['suspended', 'terminated'].includes(data.status), onClick: () => act('Start', 'container', {action: 'start'})}),
    h('button', {type: 'button', class: 'btn', 'aria-label': 'More actions', title: 'More actions', onclick: event => openMenu(event.currentTarget, [
      {label: 'Upgrade to node image', icon: 'arrowUp', onClick: () => act('Upgrade', 'upgrade', {}, {confirmText: ['Recreate the container on the image configured on this node.', 'The new image is pulled first; if it fails to start, the previous image is restored. Storage and the database are untouched.']})},
      ...(data.role === 'primary' ? [{label: 'Download database (SQL)', icon: 'database', onClick: () => { api.download(`${base}/database`); toast('Preparing the SQL export… the download starts when it is ready.'); }}] : []),
      '-',
      {label: 'Stop container', icon: 'stop', danger: true, onClick: () => act('Stop', 'container', {action: 'stop'}, {confirmText: [`Stop the container for ${host}?`, 'The site goes offline until you start it again. This does not change billing state on the master website.'], danger: true})}
    ])}, icon('more')),
    /^https?:\/\//i.test(data.activeUrl || data.url || '') ? h('a', {class: 'btn primary', href: data.activeUrl || data.url, target: '_blank', rel: 'noopener noreferrer'}, icon('external'), 'Open site') : null];
  const select = key => go(`#/tenant/${region}/${id}${key === 'overview' ? '' : `/${key}`}`);
  ctx.fill([
    crumbs([{label: state.session.label, href: '#/'}, {label: `node-${region}`, href: `#/node/${region}`}, {label: host}]),
    pageHead({title: host, pill: status, meta: [id, `home ${String(data.primary || '—').toUpperCase()}`, data.role === 'primary' ? 'primary copy' : 'standby copy', data.plan ? `${data.plan} plan` : null, shortImage(data.image)], actions}),
    tabs([['overview', 'Overview', 'layers'], ['files', 'Files', 'folder'], ['console', 'Console', 'terminal'], ['logs', 'Logs', 'logs']], tab, select),
    content]);
  const tctx = {...ctx, region, id, base, data, host, fill: nodes => { if (ctx.alive()) content.replaceChildren(...flatNodes(nodes)); }};
  if (tab === 'files') return filesTab(tctx);
  if (tab === 'console') return consoleTab(tctx);
  if (tab === 'logs') return logsTab(tctx);
  overviewTab(tctx, data);
  every(10000, async () => { try { data = await loadDetail(region, id, true); overviewTab(tctx, data); } catch {} });
}
function overviewTab(ctx, data) {
  const r = data.resources;
  const c = data.container || {};
  ctx.fill([
    data.status === 'suspended' ? h('div', {class: 'banner info'}, icon('info'), 'Suspended by the master website. Resume it there; the dashboard does not change billing state.') : null,
    data.environmentPending ? h('div', {class: 'banner warn'}, icon('alert'), 'The environment file changed but the container still runs the old one. Use More actions → Upgrade to apply it.') : null,
    h('div', {class: 'cards'},
      statCard('cpu', 'CPU', r ? pct(r.cpuPercent) : '—', r ? 'right now' : 'not running', r ? segbar(r.cpuPercent) : null),
      statCard('memory', 'Memory used', r ? bytes(dockerSize(String(r.memoryUsage || '').split('/')[0])) : '—', r ? `of ${bytes(dockerSize(String(r.memoryUsage || '').split('/')[1]), 0)}` : '', r ? meter((r.memoryPercent || 0) / 100) : null),
      statCard('activity', 'Processes', r ? String(r.processes) : '—', r ? `${pct(r.memoryPercent)} memory` : '')),
    h('div', {class: 'section'}, h('div', {class: 'section-head'}, h('h2', null, 'Container'), h('span', {class: 'note'}, `Sampled ${ago(data.sampledAt || Date.now())}`)), h('div', {class: 'card'}, h('dl', {class: 'details'},
      detail('State', c.state || '—'), detail('Started', c.startedAt && !c.startedAt.startsWith('0001') ? ago(c.startedAt) : '—'),
      detail('Restarts', String(c.restartCount ?? '—')), detail('Application health', data.applicationHealthy === undefined ? '—' : data.applicationHealthy ? 'Healthy' : 'Not answering'),
      detail('Network in / out', r ? r.networkIO : '—'), detail('Block I/O', r ? r.blockIO : '—'),
      detail('Storage used', bytes(data.storageBytes)), detail('Loopback port', data.port ? String(data.port) : '—'),
      detail('Lifecycle version', String(data.lifecycleVersion ?? 0)), detail('Out-of-memory kills', c.oomKilled ? 'Yes, last exit' : 'None'),
      detail('URL', data.activeUrl || data.url), detail('Image', shortImage(data.image))))),
    data.versions ? h('div', {class: 'section'}, h('div', {class: 'section-head'}, h('h2', null, 'Versions')), h('div', {class: 'card'}, h('pre', {class: 'code'}, JSON.stringify(data.versions, null, 2)))) : null]);
}

/* ---------------------------------------------------------------- files */
async function filesTab(ctx) {
  const key = `${ctx.region}/${ctx.id}`;
  const fstate = state.files.get(key) || {path: '/var/www/html', user: 'www-data'};
  state.files.set(key, fstate);
  if (ctx.query.get('path')) fstate.path = ctx.query.get('path');
  if (ctx.data.container?.running !== true) return ctx.fill(h('div', {class: 'card'}, h('div', {class: 'empty'}, h('strong', null, 'The container is not running'), 'Start it to browse its files.')));
  const call = body => api.post(`${ctx.base}/fs`, {user: fstate.user, ...body});
  const open = target => go(`#/tenant/${ctx.region}/${ctx.id}/files?path=${encodeURIComponent(target)}`);
  const reload = () => filesTab({...ctx, query: new URLSearchParams()});
  ctx.fill(h('div', {class: 'card'}, loading()));
  let listing;
  try { listing = await call({action: 'list', path: fstate.path}); }
  catch (error) {
    if (!ctx.alive()) return;
    return ctx.fill([h('div', {class: 'banner error'}, icon('alert'), `${fstate.path}: ${explain(error)}`), h('div', {class: 'actions'}, button('Go to /var/www/html', {onClick: () => open('/var/www/html')}), button('Up one level', {onClick: () => open(parentOf(fstate.path))}), fstate.user === 'www-data' ? button('Retry as root', {onClick: () => { fstate.user = 'root'; reload(); }}) : null)]);
  }
  if (!ctx.alive()) return;
  const segments = fstate.path === '/' ? [] : fstate.path.slice(1).split('/');
  const pathBar = h('div', {class: 'path'}, h('button', {type: 'button', onclick: () => open('/')}, '/'), segments.map((s, i) => [i ? h('span', {class: 'sep'}, '/') : null, h('button', {type: 'button', onclick: () => open('/' + segments.slice(0, i + 1).join('/'))}, s)]),
    h('button', {type: 'button', class: 'icon-btn', title: 'Go to path', 'aria-label': 'Go to path', onclick: async () => { const next = await promptDialog({title: 'Go to path', label: 'Absolute path inside the container', value: fstate.path, confirm: 'Open'}); if (next) open(next.replace(/\/+$/, '') || '/'); }}, icon('edit')));
  const userSelect = h('select', {class: 'select small', title: 'Run file operations as', onchange: e => { fstate.user = e.target.value; reload(); }}, h('option', {value: 'www-data', selected: fstate.user === 'www-data'}, 'as www-data'), h('option', {value: 'root', selected: fstate.user === 'root'}, 'as root'));
  const picker = h('input', {type: 'file', multiple: true, style: {display: 'none'}, onchange: async e => { await uploadFiles(ctx, fstate, [...e.target.files]); e.target.value = ''; reload(); }});
  const toolbar = h('div', {class: 'toolbar'}, pathBar, h('div', {class: 'group'}, userSelect,
    button('New folder', {icon: 'folderPlus', small: true, onClick: async () => { const name = await promptDialog({title: 'New folder', label: 'Folder name', confirm: 'Create'}); if (name) { try { await call({action: 'mkdir', path: joinPath(fstate.path, name)}); reload(); } catch (e) { fail(e); } } }}),
    button('New file', {icon: 'filePlus', small: true, onClick: async () => { const name = await promptDialog({title: 'New file', label: 'File name', confirm: 'Create'}); if (name) { try { await call({action: 'create', path: joinPath(fstate.path, name)}); await editFile(ctx, fstate, joinPath(fstate.path, name)); reload(); } catch (e) { fail(e); } } }}),
    button('Upload', {icon: 'upload', kind: 'primary', small: true, onClick: () => picker.click()}), picker));
  const rows = listing.entries.map(entry => fileRow(ctx, fstate, entry, call, reload, open));
  if (fstate.path !== '/') rows.unshift(h('tr', {class: 'clickable', onclick: () => open(parentOf(fstate.path))}, h('td', {colspan: '6'}, h('div', {class: 'file-name'}, h('span', {class: 'glyph dir'}, icon('folder')), h('span', {class: 'muted'}, '..')))));
  const table = h('div', {class: 'table-scroll'}, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', {class: 'right'}, 'Size'), h('th', null, 'Permissions'), h('th', null, 'Owner'), h('th', null, 'Modified'), h('th', {class: 'right'}, ''))), h('tbody', null, rows)));
  const card = h('div', {class: 'card table-card drop-target'}, toolbar, listing.entries.length ? table : [table, h('div', {class: 'empty'}, h('strong', null, 'This folder is empty'), 'Drop files here or use Upload.')]);
  card.addEventListener('dragover', e => { e.preventDefault(); card.classList.add('dragging'); });
  card.addEventListener('dragleave', e => { if (!card.contains(e.relatedTarget)) card.classList.remove('dragging'); });
  card.addEventListener('drop', async e => { e.preventDefault(); card.classList.remove('dragging'); const files = [...(e.dataTransfer?.files || [])]; if (files.length) { await uploadFiles(ctx, fstate, files); reload(); } });
  ctx.fill([
    listing.persistent ? h('div', {class: 'banner info'}, icon('info'), 'Persistent storage. Changes here survive upgrades and container recreation.')
      : h('div', {class: 'banner warn'}, icon('alert'), 'Not persistent. Changes outside /var/www/html/storage are lost when the container is upgraded or recreated.'),
    listing.truncated ? h('div', {class: 'banner warn'}, icon('alert'), 'Showing the first 5,000 entries.') : null,
    card]);
}
function fileRow(ctx, fstate, entry, call, reload, open) {
  const full = joinPath(fstate.path, entry.name);
  const isDir = entry.type === 'directory' || entry.targetType === 'directory';
  const archive = /\.(zip|tar|tgz|tar\.gz|tar\.bz2|tar\.xz)$/i.test(entry.name);
  const openEntry = () => isDir ? open(full) : editFile(ctx, fstate, full).then(saved => { if (saved) reload(); });
  const items = [
    ...(isDir ? [{label: 'Open', icon: 'folder', onClick: openEntry}] : [{label: 'Edit', icon: 'edit', onClick: openEntry}]),
    {label: isDir ? 'Download as .tar.gz' : 'Download', icon: 'download', onClick: () => api.download(`${ctx.base}/fs/download?path=${encodeURIComponent(full)}&user=${fstate.user}`)},
    ...(archive ? [{label: 'Extract here', icon: 'archive', onClick: async () => { const note = toast(`Extracting ${entry.name}…`, {timeout: 0}); try { const r = await call({action: 'extract', path: full, destination: fstate.path}); note.update(`Extracted ${r.extracted} files${r.skipped ? `, skipped ${r.skipped} unsafe entries` : ''}`); note.close(4000); reload(); } catch (e) { note.close(); fail(e); } }}] : []),
    '-',
    {label: 'Rename or move', icon: 'edit', onClick: async () => { const next = await promptDialog({title: 'Rename or move', label: 'New name, or an absolute path to move it', value: entry.name, confirm: 'Rename'}); if (next && next !== entry.name) { try { await call({action: 'rename', path: full, destination: next.startsWith('/') ? next : joinPath(fstate.path, next)}); reload(); } catch (e) { fail(e); } } }},
    {label: 'Duplicate', icon: 'copy', onClick: async () => { const next = await promptDialog({title: 'Duplicate', label: 'Name of the copy', value: entry.name.replace(/(\.[^.]+)?$/, ' copy$1'), confirm: 'Duplicate'}); if (next) { try { await call({action: 'copy', path: full, destination: next.startsWith('/') ? next : joinPath(fstate.path, next)}); reload(); } catch (e) { fail(e); } } }},
    ...(entry.type !== 'link' ? [{label: 'Permissions', icon: 'lock', onClick: () => chmodDialog(entry, full, isDir, call, reload)}] : []),
    {label: 'Change owner', icon: 'user', onClick: () => chownDialog(entry, full, isDir, ctx, reload)},
    '-',
    {label: 'Delete', icon: 'trash', danger: true, onClick: async () => {
      if (!await confirmDialog({title: `Delete ${entry.name}?`, message: isDir && entry.type !== 'link' ? [`${full} and everything inside it will be permanently deleted.`] : [`${full} will be permanently deleted.`], confirm: 'Delete', danger: true})) return;
      try { await call({action: 'delete', path: full, recursive: isDir && entry.type !== 'link'}); toast(`Deleted ${entry.name}`); reload(); } catch (e) { fail(e); }
    }}];
  const glyph = entry.type === 'link' ? 'link' : isDir ? 'folder' : 'file';
  return h('tr', {ondblclick: openEntry},
    h('td', null, h('div', {class: 'file-name'}, h('span', {class: `glyph ${entry.type === 'link' ? 'link' : isDir ? 'dir' : ''}`}, icon(glyph)), h('button', {type: 'button', class: 'link', onclick: openEntry}, entry.name), entry.type === 'link' && entry.target ? h('span', {class: 'faint mono'}, `→ ${entry.target}`) : null)),
    h('td', {class: 'right muted'}, isDir ? '—' : bytes(entry.size)),
    h('td', null, h('span', {class: 'perm mono'}, entry.permissions, h('em', null, entry.mode))),
    h('td', {class: 'muted'}, `${entry.owner}:${entry.group}`),
    h('td', {class: 'muted', title: when(entry.modifiedAt)}, ago(entry.modifiedAt * 1000)),
    h('td', {class: 'right'}, h('button', {type: 'button', class: 'icon-btn', 'aria-label': `Actions for ${entry.name}`, onclick: e => { e.stopPropagation(); openMenu(e.currentTarget, items); }}, icon('more'))));
}
function chmodDialog(entry, full, isDir, call, reload) {
  let mode = parseInt(entry.mode, 8) & 0o7777;
  const octal = h('input', {class: 'input mono', value: (mode & 0o777).toString(8).padStart(3, '0'), maxlength: '4', style: {width: '90px'}});
  const boxes = [];
  const grid = h('div', {class: 'perm-grid'}, h('span'), ['Read', 'Write', 'Execute'].map(x => h('span', {class: 'head'}, x)),
    ['Owner', 'Group', 'Others'].map((who, row) => [h('span', null, who), [4, 2, 1].map(bit => { const box = h('input', {type: 'checkbox'}); box.dataset.mask = String(bit << (3 * (2 - row))); boxes.push(box); return h('label', {class: 'check'}, box); })]));
  const sync = () => { boxes.forEach(b => { b.checked = Boolean(mode & Number(b.dataset.mask)); }); octal.value = (mode & 0o777).toString(8).padStart(3, '0'); };
  boxes.forEach(b => b.addEventListener('change', () => { mode = b.checked ? mode | Number(b.dataset.mask) : mode & ~Number(b.dataset.mask); sync(); }));
  octal.addEventListener('input', () => { if (/^[0-7]{3,4}$/.test(octal.value)) { mode = parseInt(octal.value, 8); boxes.forEach(b => { b.checked = Boolean(mode & Number(b.dataset.mask)); }); } });
  const recursive = h('input', {type: 'checkbox'});
  sync();
  const ref = modal({title: `Permissions · ${entry.name}`, body: h('div', {class: 'body'}, grid, h('label', {class: 'field'}, h('span', null, 'Octal'), octal), isDir ? h('label', {class: 'check'}, recursive, 'Apply to everything inside (symbolic links are skipped)') : null),
    actions: [button('Cancel', {onClick: () => ref.close()}), button('Apply', {kind: 'primary', onClick: async () => {
      if (!/^[0-7]{3,4}$/.test(octal.value)) return toast('Enter a 3 or 4 digit octal mode', {error: true});
      try { const r = await call({action: 'chmod', path: full, mode: octal.value, recursive: isDir && recursive.checked}); ref.close(); toast(`Permissions set to ${r.mode}${r.changed > 1 ? ` on ${r.changed} items` : ''}`); reload(); } catch (e) { fail(e); }
    }})]});
}
function chownDialog(entry, full, isDir, ctx, reload) {
  const owner = h('input', {class: 'input mono', value: `${entry.owner}:${entry.group}`});
  const recursive = h('input', {type: 'checkbox'});
  const ref = modal({title: `Owner · ${entry.name}`, body: h('div', {class: 'body'}, h('label', {class: 'field'}, h('span', null, 'user:group'), owner), isDir ? h('label', {class: 'check'}, recursive, 'Apply to everything inside') : null, h('p', {class: 'muted', style: {marginTop: '12px'}}, 'Changing ownership runs as root. The application runs as www-data:www-data.')),
    actions: [button('Cancel', {onClick: () => ref.close()}), button('Apply', {kind: 'primary', onClick: async () => {
      try { const r = await api.post(`${ctx.base}/fs`, {user: 'root', action: 'chown', path: full, owner: owner.value.trim(), recursive: isDir && recursive.checked}); ref.close(); toast(`Owner set on ${r.changed} item${r.changed === 1 ? '' : 's'}`); reload(); } catch (e) { fail(e); }
    }})]});
}
async function editFile(ctx, fstate, full) {
  let file;
  try { file = await api.post(`${ctx.base}/fs`, {user: fstate.user, action: 'read', path: full}); }
  catch (error) { fail(error); return false; }
  if (file.binary) {
    const download = await confirmDialog({title: 'Binary file', message: `${full} is not a text file, so it cannot be edited here.`, confirm: 'Download'});
    if (download) api.download(`${ctx.base}/fs/download?path=${encodeURIComponent(full)}&user=${fstate.user}`);
    return false;
  }
  return new Promise(resolve => {
    let saved = false, dirty = false, modifiedAt = file.modifiedAt;
    const area = h('textarea', {class: 'editor', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off'});
    area.value = new TextDecoder().decode(fromBase64(file.contentBase64));
    const status = h('span', {class: 'muted', style: {fontSize: '13px'}}, `${bytes(file.size)} · ${file.mode}${file.persistent ? '' : ' · not persistent'}`);
    const save = async (force = false) => {
      saveButton.disabled = true;
      try {
        const result = await api.post(`${ctx.base}/fs`, {user: fstate.user, action: 'write', path: full, contentBase64: toBase64(new TextEncoder().encode(area.value)), ...(force ? {} : {expectModifiedAt: modifiedAt})});
        modifiedAt = result.modifiedAt; saved = true; dirty = false; status.textContent = `Saved ${new Date().toLocaleTimeString()}`;
      } catch (error) {
        if (error.code === 'file_changed' && await confirmDialog({title: 'File changed on disk', message: 'Someone or something changed this file after you opened it. Overwrite it with your version?', confirm: 'Overwrite', danger: true})) return save(true);
        fail(error);
      } finally { saveButton.disabled = false; }
    };
    const saveButton = button('Save', {kind: 'primary', small: true, onClick: () => save()});
    const closeButton = button('Close', {small: true, onClick: async () => { if (dirty && !await confirmDialog({title: 'Discard changes?', message: 'You have unsaved changes.', confirm: 'Discard', danger: true})) return; ref.close(); }});
    area.addEventListener('input', () => { dirty = true; status.textContent = 'Unsaved changes'; });
    area.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
      if (event.key === 'Tab' && !event.shiftKey) { event.preventDefault(); const {selectionStart: s, selectionEnd: e} = area; area.setRangeText('    ', s, e, 'end'); dirty = true; }
    });
    const ref = modal({wide: true, body: h('div', null, h('div', {class: 'editor-head'}, h('div', {style: {minWidth: '0'}}, h('div', {class: 'mono', style: {fontWeight: '600'}}, full), status), h('div', {class: 'actions'}, closeButton, saveButton)), area), onClose: () => resolve(saved)});
    setTimeout(() => area.focus(), 0);
  });
}
async function uploadFiles(ctx, fstate, files) {
  const CHUNK = 4 * 1024 * 1024;
  for (const file of files) {
    const target = joinPath(fstate.path, file.name);
    const note = toast(`Uploading ${file.name}`, {timeout: 0, progress: 0});
    let overwrite = false, offset = 0;
    const uploadId = randomHex(16);
    try {
      while (true) {
        const chunk = new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer());
        const final = offset + chunk.length >= file.size;
        try { await api.post(`${ctx.base}/fs`, {user: fstate.user, action: 'upload', path: target, uploadId, offset, final, overwrite, contentBase64: toBase64(chunk)}); }
        catch (error) {
          if (error.code === 'file_exists' && offset === 0 && !overwrite) {
            if (await confirmDialog({title: 'Replace file?', message: `${file.name} already exists in ${fstate.path}.`, confirm: 'Replace', danger: true})) { overwrite = true; continue; }
            note.close(); break;
          }
          throw error;
        }
        offset += chunk.length;
        note.update(`Uploading ${file.name} · ${bytes(offset)} of ${bytes(file.size)}`, file.size ? Math.round(offset / file.size * 100) : 100);
        if (final) { note.update(`Uploaded ${file.name}`, 100); note.close(2500); break; }
      }
    } catch (error) { note.close(); fail(error); }
  }
}

/* ---------------------------------------------------------------- console */
const QUICK = ['php artisan about', 'php artisan migrate:status', 'php artisan optimize:clear', 'php artisan queue:failed', 'ls -la', 'df -h', 'ps aux --sort=-%mem | head -15', 'tail -n 50 storage/logs/laravel.log'];
function consoleTab(ctx) {
  const key = `${ctx.region}/${ctx.id}`;
  const c = state.consoles.get(key) || {lines: [], cwd: '/var/www/html', user: 'www-data', history: [], index: -1, timeout: 30, busy: false};
  state.consoles.set(key, c);
  if (ctx.data.container?.running !== true) return ctx.fill(h('div', {class: 'card'}, h('div', {class: 'empty'}, h('strong', null, 'The container is not running'), 'Start it to run commands.')));
  const output = h('div', {class: 'term', role: 'log', 'aria-live': 'polite'});
  const promptText = () => `${c.user}@${ctx.id.slice(0, 10)}:${c.cwd}${c.user === 'root' ? '#' : '$'}`;
  const promptLabel = h('span', {class: 'prompt'}, promptText());
  const input = h('input', {'aria-label': 'Command', placeholder: 'Type a command and press Enter', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off'});
  const paint = () => {
    output.replaceChildren(c.lines.length ? '' : h('span', {class: 'sys'}, `Commands run with sh inside ${ctx.host}'s container. Each command is separate: use cd to change directory, it is remembered.\nNot an interactive terminal, so editors and prompts will not work. Ctrl+L clears.\n`));
    for (const line of c.lines) output.append(h('span', {class: line.kind}, line.text));
    if (c.busy) output.append(h('span', {class: 'sys'}, 'running…\n'));
    output.scrollTop = output.scrollHeight;
    promptLabel.textContent = promptText();
    input.disabled = c.busy;
  };
  const run = async command => {
    if (!command.trim() || c.busy) return;
    if (command.trim() === 'clear') { c.lines = []; return paint(); }
    c.history.push(command); if (c.history.length > 200) c.history.shift(); c.index = -1;
    c.lines.push({kind: 'prompt', text: `${promptText()} `}, {kind: 'cmd', text: `${command}\n`});
    c.busy = true; paint();
    try {
      const r = await api.post(`${ctx.base}/exec`, {command, cwd: c.cwd, user: c.user, timeoutSeconds: c.timeout});
      if (r.stdout) c.lines.push({kind: '', text: r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`});
      if (r.stderr) c.lines.push({kind: 'err', text: r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`});
      if (r.timedOut) c.lines.push({kind: 'exit', text: `timed out after ${c.timeout}s\n`});
      else if (r.exitCode !== 0) c.lines.push({kind: 'exit', text: `exit ${r.exitCode}\n`});
      if (r.truncated) c.lines.push({kind: 'sys', text: 'output truncated at 1 MB\n'});
      c.cwd = r.cwd || c.cwd;
    } catch (error) { c.lines.push({kind: 'err', text: `${explain(error)}\n`}); }
    finally { c.busy = false; if (c.lines.length > 4000) c.lines.splice(0, c.lines.length - 4000); if (ctx.alive()) { paint(); input.focus(); } }
  };
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { const value = input.value; input.value = ''; run(value); }
    else if (event.key === 'ArrowUp' && c.history.length) { event.preventDefault(); c.index = c.index < 0 ? c.history.length - 1 : Math.max(0, c.index - 1); input.value = c.history[c.index]; }
    else if (event.key === 'ArrowDown' && c.index >= 0) { event.preventDefault(); c.index = c.index + 1 >= c.history.length ? -1 : c.index + 1; input.value = c.index < 0 ? '' : c.history[c.index]; }
    else if (event.key.toLowerCase() === 'l' && event.ctrlKey) { event.preventDefault(); c.lines = []; paint(); }
  });
  const userSelect = h('select', {class: 'select small', onchange: e => { c.user = e.target.value; paint(); }}, h('option', {value: 'www-data', selected: c.user === 'www-data'}, 'www-data'), h('option', {value: 'root', selected: c.user === 'root'}, 'root'));
  const timeoutSelect = h('select', {class: 'select small', title: 'Command timeout', onchange: e => { c.timeout = Number(e.target.value); }}, [15, 30, 60, 90].map(s => h('option', {value: String(s), selected: c.timeout === s}, `${s}s limit`)));
  ctx.fill([
    h('div', {class: 'card table-card'},
      h('div', {class: 'toolbar'}, h('div', {class: 'chips'}, QUICK.map(q => h('button', {type: 'button', class: 'chip', onclick: () => run(q)}, q))), h('div', {class: 'group'}, h('span', {class: 'muted', style: {fontSize: '13px'}}, 'Run as'), userSelect, timeoutSelect, button('Clear', {small: true, kind: 'ghost', onClick: () => { c.lines = []; paint(); }}))),
      output, h('label', {class: 'term-input'}, promptLabel, input)),
    c.user === 'root' ? h('div', {class: 'banner warn', style: {marginTop: '14px'}}, icon('alert'), 'Running as root inside the container. It can reach the MariaDB socket as root, which covers every tenant database on this node. Prefer www-data.') : null]);
  paint();
  setTimeout(() => input.focus(), 0);
  userSelect.addEventListener('change', () => consoleTab(ctx));
}

/* ---------------------------------------------------------------- logs */
async function logsTab(ctx) {
  const key = `${ctx.region}/${ctx.id}`;
  const l = state.logs.get(key) || {tail: 300, follow: true, filter: '', stream: 'all'};
  state.logs.set(key, l);
  const view = h('div', {class: 'term', role: 'log'});
  const stamp = h('span', {class: 'note'});
  let lines = [];
  const paint = () => {
    const q = l.filter.toLowerCase();
    const shown = lines.filter(line => (l.stream === 'all' || line.stream === l.stream) && (!q || line.text.toLowerCase().includes(q)));
    const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
    view.replaceChildren(...(shown.length ? shown.map(line => h('div', {class: `log-line ${line.stream}`}, h('time', null, line.time ? line.time.replace('T', ' ').slice(0, 19) : ''), h('span', null, line.text))) : [h('span', {class: 'sys'}, lines.length ? 'No lines match the filter.' : 'No log output yet.')]));
    if (atBottom || l.follow) view.scrollTop = view.scrollHeight;
  };
  const load = async () => {
    try { const r = await api.post(`${ctx.base}/logs`, {tail: l.tail}); if (!ctx.alive()) return; lines = r.lines; stamp.textContent = `Updated ${new Date().toLocaleTimeString()}`; paint(); }
    catch (error) { if (ctx.alive()) { stamp.textContent = explain(error); } }
  };
  const follow = h('input', {type: 'checkbox', checked: l.follow, onchange: e => { l.follow = e.target.checked; }});
  ctx.fill(h('div', {class: 'card table-card'},
    h('div', {class: 'toolbar'},
      h('div', {class: 'group'}, h('div', {class: 'search'}, icon('search'), h('input', {class: 'input small', placeholder: 'Filter lines', value: l.filter, oninput: e => { l.filter = e.target.value; paint(); }})),
        h('select', {class: 'select small', onchange: e => { l.stream = e.target.value; paint(); }}, [['all', 'All streams'], ['stdout', 'stdout'], ['stderr', 'stderr']].map(([v, t]) => h('option', {value: v, selected: l.stream === v}, t))),
        h('select', {class: 'select small', onchange: e => { l.tail = Number(e.target.value); load(); }}, [100, 300, 1000, 5000].map(n => h('option', {value: String(n), selected: l.tail === n}, `Last ${n}`)))),
      h('div', {class: 'group'}, stamp, h('label', {class: 'check'}, follow, 'Follow'), button('Refresh', {icon: 'refresh', small: true, onClick: load}))),
    view));
  await load();
  every(3000, () => { if (l.follow) load(); });
}

/* ---------------------------------------------------------------- activity */
async function activityPage(ctx) {
  const data = await api.get('/api/activity');
  const label = e => e.event === 'action' ? String(e.action).replace(/_/g, ' ') : e.event.replace(/_/g, ' ');
  const rows = data.events.map(e => h('tr', null,
    h('td', {class: 'muted', title: e.time}, ago(e.time)),
    h('td', null, e.user || h('span', {class: 'faint'}, '—')),
    h('td', null, h('span', {class: 'status'}, h('span', {class: `dot ${/failed|limited/.test(e.event) ? 'red' : e.event === 'action' ? 'green' : ''}`}), label(e))),
    h('td', {class: 'mono'}, e.id ? h('a', {href: `#/tenant/${e.region}/${e.id}`}, `${e.region}/${e.id}`) : h('span', {class: 'faint'}, e.ip || '—')),
    h('td', {class: 'mono muted', style: {maxWidth: '420px', overflow: 'hidden', textOverflow: 'ellipsis'}, title: e.command || e.path || ''}, e.command || e.path || (e.runAs ? `as ${e.runAs}` : ''))));
  ctx.fill([
    crumbs([{label: state.session.label, href: '#/'}, {label: 'Activity'}]),
    pageHead({title: 'Activity', meta: ['Sign-ins and actions taken through this dashboard since it last started', 'also written to the journal'], actions: [button('Refresh', {icon: 'refresh', onClick: () => render()})]}),
    rows.length ? h('div', {class: 'card table-card'}, h('div', {class: 'table-scroll'}, h('table', null, h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'User'), h('th', null, 'Event'), h('th', null, 'Target'), h('th', null, 'Detail'))), h('tbody', null, rows))))
      : h('div', {class: 'card'}, h('div', {class: 'empty'}, h('strong', null, 'Nothing yet'), 'Actions you take appear here.'))]);
}

render();
})();
