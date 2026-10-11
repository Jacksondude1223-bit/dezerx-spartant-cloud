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
    // Relative to the page, so the dashboard works at / and under a prefix such as /panel/.
    const response = await fetch(path.replace(/^\//, ''), {method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin'});
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
    const link = h('a', {href: path.replace(/^\//, ''), download: ''});
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
  invalid_credentials_or_code: 'Incorrect username, password or authenticator code. Each code works once.',
  too_many_attempts: 'Too many sign-in attempts. Wait 15 minutes.', not_provisioned: 'This tenant is not provisioned on this node.',
  node_update_in_progress: 'The node is applying an update. Try again shortly.', service_not_ready: 'The tenant is not ready.',
  invalid_archive: 'That archive could not be read.', unsupported_archive: 'Only .zip and .tar(.gz/.bz2/.xz) archives can be extracted.',
  not_a_file: 'That is not a regular file.', not_a_directory: 'That is not a folder.', file_not_found: 'File not found.',
  primary_node_required: 'Database downloads are only available on the primary node.', unknown_owner: 'Unknown user or group.',
  invalid_license_key: 'That licence key is not valid. It must start with SPARTANSTARTER_, SPARTANCLOUD_, SPARTANCLOUDPLUS_, SPARTANPROFESSIONAL_, SPARTANULTIMATE_ or SPARTANDEV_.',
  invalid_domain: 'Enter a bare domain such as panel.customer.com.', reserved_hostname: 'That domain belongs to the platform itself. Leave it blank to use the default subdomain.',
  hostname_in_use: 'Another instance already uses that domain.', hostname_conflict: 'That domain is already attached to another tenant.',
  license_key_required: 'Enter the Spartan licence issued for this hostname.', license_locked: 'The licence cannot change after a node holds this tenant.',
  instance_domain_configuration_required: 'The routing Worker cannot assign hostnames yet. Set CF_INSTANCE_API_TOKEN on it (npm run configure does this).', instance_hostname_setup_failed: 'Cloudflare did not attach the hostname. Try again in a minute.',
  initial_admin_failed: 'Automatic administrator creation failed. Retry with Create administrator automatically turned off, then complete Spartan’s signup. If an account already exists, sign in or use Spartan’s password reset.',
  invalid_laravel_env: 'The node rejected its extra Laravel environment file (LARAVEL_ENV_FILE).', node_capacity: 'The node already holds its maximum number of tenants (MAX_TENANTS).',
  stale_operation: 'The node has a newer lifecycle version for this tenant.', service_terminated: 'This tenant was terminated on the node and cannot be provisioned again.',
  container_conflict: 'A container with this name belongs to a different tenant on the node.',
  not_queued: 'This instance is not in the queue.',
  already_suspended: 'It is already suspended.', not_suspended: 'It is not suspended.', tenant_not_found: 'Neither node has this tenant.', invalid_action: 'Unknown action.',
  node_us_unreachable: 'node-us could not be reached, so nothing was changed.', node_de_unreachable: 'node-de could not be reached, so nothing was changed.',
  invalid_initial_admin: 'Check the administrator: name, a valid email and a password of 8 to 128 characters.', invalid_customer_id: 'Customer reference: letters, digits, _ and - only.',
  ownership_not_verified: 'The DNS records are not visible yet. Add them, wait a few minutes and verify again.', domain_not_verified: 'Verify the domain first.',
  domain_verification_required: 'The node refused the domain permit. Verify the domain again.', instance_busy: 'This instance is being deployed right now.',
  instance_deployed: 'This instance is deployed, so it cannot be discarded here.', both_nodes_required: 'Both nodes must be configured in the dashboard.',
  routing_unauthorized: 'The routing Worker rejected the signature. Check ORIGIN_SECRET in dashboard.env.', provisioning_disabled: 'Instance creation is off. Add ORIGIN_SECRET and BASE_DOMAIN to dashboard.env.',
  dashboard_restarted: 'The dashboard restarted during deployment. Deploy again; it continues where it stopped.', not_ready_in_time: 'The node did not report ready in time. Deploy again to keep waiting.',
  operation_failed: 'The node could not finish. Check journalctl -u spartan-agent on that node.', tenant_conflict: 'A different tenant already uses this ID on the node.',
  saas_configuration_required: 'Custom domains are not configured on the routing Worker (Cloudflare for SaaS).',
  invalid_cpu_limit: 'Enter a CPU limit between 0.1 and 64, with at most two decimals (for example 2.5).', cpu_limit_exceeds_host: 'The node does not have that many CPUs. Pick a lower limit.',
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
// Tabler Icons (MIT, https://tabler.io/icons), outline set.
const ICONS = {
  home: "<path d=\"M5 12l-2 0l9 -9l9 9l-2 0\"/><path d=\"M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-7\"/><path d=\"M9 21v-6a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v6\"/>",
  server: "<path d=\"M3 7a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-2\"/><path d=\"M3 15a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3l0 -2\"/><path d=\"M7 8l0 .01\"/><path d=\"M7 16l0 .01\"/><path d=\"M11 8h6\"/><path d=\"M11 16h6\"/>",
  layers: "<path d=\"M12 4l-8 4l8 4l8 -4l-8 -4\"/><path d=\"M4 12l8 4l8 -4\"/><path d=\"M4 16l8 4l8 -4\"/>",
  docker: "<path d=\"M22 12.54c-1.804 -.345 -2.701 -1.08 -3.523 -2.94c-.487 .696 -1.102 1.568 -.92 2.4c.028 .238 -.32 1 -.557 1h-14c0 5.208 3.164 7 6.196 7c4.124 .022 7.828 -1.376 9.854 -5c1.146 -.101 2.296 -1.505 2.95 -2.46\"/><path d=\"M5 10h3v3h-3l0 -3\"/><path d=\"M8 10h3v3h-3l0 -3\"/><path d=\"M11 10h3v3h-3l0 -3\"/><path d=\"M8 7h3v3h-3l0 -3\"/><path d=\"M11 7h3v3h-3l0 -3\"/><path d=\"M11 4h3v3h-3l0 -3\"/><path d=\"M4.571 18c1.5 0 2.047 -.074 2.958 -.78\"/><path d=\"M10 16l0 .01\"/>",
  activity: "<path d=\"M3 12h4l3 8l4 -16l3 8h4\"/>",
  refresh: "<path d=\"M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4\"/><path d=\"M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4\"/>",
  cpu: "<path d=\"M5 6a1 1 0 0 1 1 -1h12a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-12a1 1 0 0 1 -1 -1l0 -12\"/><path d=\"M9 9h6v6h-6l0 -6\"/><path d=\"M3 10h2\"/><path d=\"M3 14h2\"/><path d=\"M10 3v2\"/><path d=\"M14 3v2\"/><path d=\"M21 10h-2\"/><path d=\"M21 14h-2\"/><path d=\"M14 21v-2\"/><path d=\"M10 21v-2\"/>",
  memory: "<path d=\"M12 11v2\"/><path d=\"M16 11v2\"/><path d=\"M3 7h18a1 1 0 0 1 1 1v1a1 1 0 0 1 -1 1a1 1 0 0 0 -1 1v1a1 1 0 0 0 1 1a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-18a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1a1 1 0 0 0 1 -1v-1a1 1 0 0 0 -1 -1a1 1 0 0 1 -1 -1v-1a1 1 0 0 1 1 -1\"/><path d=\"M8 11v2\"/><path d=\"M4 17v2\"/><path d=\"M7 17v2\"/><path d=\"M10 17v2\"/><path d=\"M20 17v2\"/><path d=\"M17 17v2\"/><path d=\"M13 17v2\"/>",
  disk: "<path d=\"M4 6a8 3 0 1 0 16 0a8 3 0 1 0 -16 0\"/><path d=\"M4 6v6a8 3 0 0 0 16 0v-6\"/><path d=\"M4 12v6a8 3 0 0 0 16 0v-6\"/>",
  network: "<path d=\"M17 3l0 18\"/><path d=\"M10 18l-3 3l-3 -3\"/><path d=\"M7 21l0 -18\"/><path d=\"M20 6l-3 -3l-3 3\"/>",
  world: "<path d=\"M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0\"/><path d=\"M3.6 9h16.8\"/><path d=\"M3.6 15h16.8\"/><path d=\"M11.5 3a17 17 0 0 0 0 18\"/><path d=\"M12.5 3a17 17 0 0 1 0 18\"/>",
  folder: "<path d=\"M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2\"/>",
  folderPlus: "<path d=\"M12 19h-7a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2h4l3 3h7a2 2 0 0 1 2 2v3.5\"/><path d=\"M16 19h6\"/><path d=\"M19 16v6\"/>",
  file: "<path d=\"M14 3v4a1 1 0 0 0 1 1h4\"/><path d=\"M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2\"/>",
  filePlus: "<path d=\"M14 3v4a1 1 0 0 0 1 1h4\"/><path d=\"M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2\"/><path d=\"M12 11l0 6\"/><path d=\"M9 14l6 0\"/>",
  fileZip: "<path d=\"M6 20.735a2 2 0 0 1 -1 -1.735v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2h-1\"/><path d=\"M11 17a2 2 0 0 1 2 2v2a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1v-2a2 2 0 0 1 2 -2\"/><path d=\"M11 5l-1 0\"/><path d=\"M13 7l-1 0\"/><path d=\"M11 9l-1 0\"/><path d=\"M13 11l-1 0\"/><path d=\"M11 13l-1 0\"/><path d=\"M13 15l-1 0\"/>",
  fileCode: "<path d=\"M14 3v4a1 1 0 0 0 1 1h4\"/><path d=\"M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2\"/><path d=\"M10 13l-1 2l1 2\"/><path d=\"M14 13l1 2l-1 2\"/>",
  fileText: "<path d=\"M14 3v4a1 1 0 0 0 1 1h4\"/><path d=\"M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2\"/><path d=\"M9 9l1 0\"/><path d=\"M9 13l6 0\"/><path d=\"M9 17l6 0\"/>",
  photo: "<path d=\"M15 8h.01\"/><path d=\"M3 6a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v12a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-12\"/><path d=\"M3 16l5 -5c.928 -.893 2.072 -.893 3 0l5 5\"/><path d=\"M14 14l1 -1c.928 -.893 2.072 -.893 3 0l3 3\"/>",
  link: "<path d=\"M9 15l6 -6\"/><path d=\"M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464\"/><path d=\"M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463\"/>",
  terminal: "<path d=\"M8 9l3 3l-3 3\"/><path d=\"M13 15l3 0\"/><path d=\"M3 6a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2l0 -12\"/>",
  logs: "<path d=\"M4 12h.01\"/><path d=\"M4 6h.01\"/><path d=\"M4 18h.01\"/><path d=\"M8 18h2\"/><path d=\"M8 12h2\"/><path d=\"M8 6h2\"/><path d=\"M14 6h6\"/><path d=\"M14 12h6\"/><path d=\"M14 18h6\"/>",
  play: "<path d=\"M7 4v16l13 -8l-13 -8\"/>",
  stop: "<path d=\"M5 7a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2l0 -10\"/>",
  upload: "<path d=\"M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2\"/><path d=\"M7 9l5 -5l5 5\"/><path d=\"M12 4l0 12\"/>",
  download: "<path d=\"M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2\"/><path d=\"M7 11l5 5l5 -5\"/><path d=\"M12 4l0 12\"/>",
  plus: "<path d=\"M12 5l0 14\"/><path d=\"M5 12l14 0\"/>",
  trash: "<path d=\"M4 7l16 0\"/><path d=\"M10 11l0 6\"/><path d=\"M14 11l0 6\"/><path d=\"M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12\"/><path d=\"M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3\"/>",
  edit: "<path d=\"M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4\"/><path d=\"M13.5 6.5l4 4\"/>",
  lock: "<path d=\"M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6\"/><path d=\"M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0\"/><path d=\"M8 11v-4a4 4 0 1 1 8 0v4\"/>",
  more: "<path d=\"M4 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0\"/><path d=\"M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0\"/><path d=\"M18 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0\"/>",
  external: "<path d=\"M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6\"/><path d=\"M11 13l9 -9\"/><path d=\"M15 4h5v5\"/>",
  upgrade: "<path d=\"M12 10l0 10\"/><path d=\"M12 10l4 4\"/><path d=\"M12 10l-4 4\"/><path d=\"M4 4l16 0\"/>",
  search: "<path d=\"M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0\"/><path d=\"M21 21l-6 -6\"/>",
  alert: "<path d=\"M12 9v4\"/><path d=\"M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0\"/><path d=\"M12 16h.01\"/>",
  info: "<path d=\"M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0\"/><path d=\"M12 9h.01\"/><path d=\"M11 12h1v4h1\"/>",
  logout: "<path d=\"M14 8v-2a2 2 0 0 0 -2 -2h-7a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2 -2v-2\"/><path d=\"M9 12h12l-3 -3\"/><path d=\"M18 15l3 -3\"/>",
  copy: "<path d=\"M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667l0 -8.666\"/><path d=\"M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1\"/>",
  archive: "<path d=\"M3 6a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2\"/><path d=\"M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-10\"/><path d=\"M10 12l4 0\"/>",
  user: "<path d=\"M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0\"/><path d=\"M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2\"/>",
  zap: "<path d=\"M13 3l0 7l6 0l-8 11l0 -7l-6 0l8 -11\"/>",
  database: "<path d=\"M4 6a8 3 0 1 0 16 0a8 3 0 1 0 -16 0\"/><path d=\"M4 6v6a8 3 0 0 0 16 0v-6\"/><path d=\"M4 12v6a8 3 0 0 0 16 0v-6\"/>",
  clock: "<path d=\"M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0\"/><path d=\"M12 7v5l3 3\"/>",
  arrowDown: "<path d=\"M12 5l0 14\"/><path d=\"M18 13l-6 6\"/><path d=\"M6 13l6 6\"/>",
  chevron: "<path d=\"M9 6l6 6l-6 6\"/>",
  arrowLeft: "<path d=\"M5 12l14 0\"/><path d=\"M5 12l6 6\"/><path d=\"M5 12l6 -6\"/>",
  arrowUp: "<path d=\"M12 5l0 14\"/><path d=\"M18 11l-6 -6\"/><path d=\"M6 11l6 -6\"/>",
  rocket: "<path d=\"M4 13a8 8 0 0 1 7 7a6 6 0 0 0 3 -5a9 9 0 0 0 6 -8a3 3 0 0 0 -3 -3a9 9 0 0 0 -8 6a6 6 0 0 0 -5 3\"/><path d=\"M7 14a6 6 0 0 0 -3 6a6 6 0 0 0 6 -3\"/><path d=\"M14 9a1 1 0 1 0 2 0a1 1 0 1 0 -2 0\"/>",
  check: "<path d=\"M5 12l5 5l10 -10\"/>",
  key: "<path d=\"M16.555 3.843l3.602 3.602a2.877 2.877 0 0 1 0 4.069l-2.643 2.643a2.877 2.877 0 0 1 -4.069 0l-.301 -.301l-6.558 6.558a2 2 0 0 1 -1.239 .578l-.175 .008h-1.172a1 1 0 0 1 -.993 -.883l-.007 -.117v-1.172a2 2 0 0 1 .467 -1.284l.119 -.13l.414 -.414h2v-2h2v-2l2.144 -2.144l-.301 -.301a2.877 2.877 0 0 1 0 -4.069l2.643 -2.643a2.877 2.877 0 0 1 4.069 0\"/><path d=\"M15 9h.01\"/>"
};
function icon(name) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('class', 'icon');
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = ICONS[name] || '';
  return el;
}
const LOGO = window.SPARTAN_LOGO || 'logo.png';
const brandMark = () => h('span', {class: 'brand-mark'}, h('img', {src: LOGO, alt: '', width: '18', height: '18'}));
// Small inline flags (national flags are public domain); emoji flags do not render on Windows.
function flag(region) {
  const ns = 'http://www.w3.org/2000/svg';
  const el = document.createElementNS(ns, 'svg');
  el.setAttribute('aria-hidden', 'true');
  if (region === 'de') {
    el.setAttribute('viewBox', '0 0 5 3');
    el.innerHTML = '<rect width="5" height="1" fill="#000"/><rect y="1" width="5" height="1" fill="#DD0000"/><rect y="2" width="5" height="1" fill="#FFCE00"/>';
  } else if (region === 'us') {
    el.setAttribute('viewBox', '0 0 19 10');
    let stripes = '';
    for (let i = 0; i < 13; i += 2) stripes += `<rect y="${(i * 10 / 13).toFixed(3)}" width="19" height="${(10 / 13).toFixed(3)}" fill="#B22234"/>`;
    let stars = '';
    for (let row = 0; row < 9; row++) for (let col = 0; col < (row % 2 ? 5 : 6); col++) stars += `<circle cx="${(0.63 + col * 1.27 + (row % 2 ? 0.635 : 0)).toFixed(2)}" cy="${(0.3 + row * 0.6).toFixed(2)}" r="0.2" fill="#fff"/>`;
    el.innerHTML = `<rect width="19" height="10" fill="#fff"/>${stripes}<rect width="7.6" height="5.385" fill="#3C3B6E"/>${stars}`;
  } else return null;
  return h('span', {class: 'flag', title: regionName(region)}, el);
}
const badge = ({tone = '', label}) => h('span', {class: 'badge'}, h('span', {class: `dot ${tone}`}), label);
const rate = value => value === null || value === undefined || !Number.isFinite(value) ? '—' : `${bytes(value)}/s`;
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
const uniqueCount = list => new Set(list.map(t => t.id)).size;
const allTenants = data => data.nodes.filter(n => n.ok).flatMap(n => n.tenants.map(t => ({...t, region: n.region})));
const nodeOf = (data, region) => data.nodes.find(n => n.region === region);
function nodeTone(n) { if (!n) return {tone: '', label: 'Unknown'}; if (!n.ok) return {tone: 'red', label: 'Unreachable'}; if (n.node.status !== 'ready') return {tone: 'amber', label: 'Degraded'}; return {tone: 'green', label: 'Online'}; }

/* ---------------------------------------------------------------- shell */
function sidebar(current) {
  const nodes = state.session?.nodes || [];
  const item = (hash, name, label, active, extra) => h('a', {class: `nav-item ${active ? 'active' : ''}`, href: hash}, icon(name), label, extra);
  return h('aside', {class: 'sidebar'},
    h('div', {class: 'brand'}, brandMark(), state.session?.label || 'Spartan Cloud'),
    item('#/', 'home', 'Home', current === 'home'),
    h('div', {class: 'nav-label'}, 'Infrastructure'),
    nodes.map(n => { const tone = nodeTone(state.overview && nodeOf(state.overview, n.region)); return h('a', {class: `nav-item ${current === `node:${n.region}` ? 'active' : ''}`, href: `#/node/${n.region}`}, flag(n.region) || icon('server'), `node-${n.region}`, h('span', {class: `dot ${state.overview ? tone.tone : ''}`, title: tone.label})); }),
    item('#/tenants', 'layers', 'Tenants', current === 'tenants'),
    state.session?.provisioning ? item('#/instances', 'rocket', 'Instances', current === 'instances') : null,
    h('div', {class: 'nav-label'}, 'Monitoring'),
    item('#/activity', 'activity', 'Activity', current === 'activity'),
    h('div', {class: 'nav-spacer'}),
    h('div', {class: 'user-chip'}, h('span', {class: 'avatar'}, (state.session?.user || '?').charAt(0)), h('span', {class: 'who'}, state.session?.user), h('button', {type: 'button', title: 'Sign out', 'aria-label': 'Sign out', onclick: signOut}, icon('logout'))));
}
async function signOut() { try { await api.post('/api/logout'); } catch {} state.session = null; state.overview = null; render(); }
function crumbs(items) { return h('nav', {class: 'crumbs', 'aria-label': 'Breadcrumb'}, items.map((it, i) => [i ? h('span', {class: 'sep'}, '›') : null, it.href ? h('a', {href: it.href}, it.label) : h('span', {class: 'here'}, it.label)])); }
function pageHead({title, pill, lead, subtitle, actions = []}) {
  return h('div', {class: 'page-head'},
    h('div', {style: {minWidth: '0'}}, h('div', {class: 'title-row'}, lead || null, h('h1', null, title), pill ? badge(pill) : null), subtitle ? h('div', {class: 'subtitle'}, subtitle) : null),
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
    try { const session = await api.get('/api/session'); if (session.authenticated) { state.session = session; csrf = session.csrf; } else { state.label = session.label; state.twoFactor = session.twoFactor === true; } }
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
    else if (parts[0] === 'instances' && !parts[1]) await instancesPage(ctx);
    else if (parts[0] === 'instances' && parts[1] === 'new') await newInstancePage(ctx);
    else if (parts[0] === 'instances' && /^t-[a-f0-9]{24}$/.test(parts[1])) await instancePage(ctx, parts[1]);
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
  const code = state.twoFactor ? h('input', {class: 'input mono', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxlength: '6', placeholder: '123456', required: true}) : null;
  const message = h('div', {class: 'banner error', style: {display: 'none'}});
  const submit = h('button', {type: 'submit', class: 'btn primary'}, 'Sign in');
  const form = h('form', {onsubmit: async event => {
    event.preventDefault();
    submit.disabled = true; message.style.display = 'none';
    try {
      const session = await api.post('/api/login', {username: user.value, password: pass.value, ...(code ? {code: code.value.trim()} : {})});
      csrf = session.csrf; state.session = null; render();
    } catch (error) { message.replaceChildren(icon('alert'), explain(error)); message.style.display = ''; pass.value = ''; if (code) code.value = ''; pass.focus(); }
    finally { submit.disabled = false; }
  }}, message, h('label', {class: 'field'}, h('span', null, 'Username'), user), h('label', {class: 'field'}, h('span', null, 'Password'), pass), code ? h('label', {class: 'field'}, h('span', null, 'Authenticator code'), code) : null, submit);
  setTimeout(() => user.focus(), 0);
  return h('div', {class: 'login'}, h('div', {class: 'card'}, h('div', {class: 'brand'}, brandMark(), state.label || 'Spartan Cloud'), h('h1', null, 'Sign in'), form));
}

/* ---------------------------------------------------------------- tenant table */
// Each tenant lives on both nodes: the primary serves it, the other copy is its standby.
// Show one row per tenant (the primary) and fold the standby underneath it.
const expandedTenants = new Set();
const roleLabel = role => ({primary: 'Home', secondary: 'Standby'})[role] || role || '—';
function tenantTable(list, {region = true, empty = 'No tenants yet', group = region} = {}) {
  if (!list.length) return h('div', {class: 'card'}, h('div', {class: 'empty'}, h('strong', null, empty), 'Tenants appear here once the master website provisions them.'));
  const open = t => go(`#/tenant/${t.region}/${t.id}`);
  const cells = t => {
    const r = t.resources;
    return [h('td', null, statusCell(t)),
      h('td', null, r ? usage(r.cpuPercent) : h('span', {class: 'faint'}, '—')),
      h('td', null, r ? h('span', null, bytes(r.memoryUsedBytes), h('span', {class: 'faint'}, ` / ${bytes(r.memoryLimitBytes, 0)}`)) : h('span', {class: 'faint'}, '—')),
      h('td', null, h('span', {class: `role-pill ${t.role === 'secondary' ? 'standby' : 'home'}`, title: t.role === 'secondary' ? 'Standby copy: forwards visitors to the home node, holds no data' : 'Home: runs the app and owns the database'}, region ? flag(t.region) : null, roleLabel(t.role))),
      h('td', {class: 'right mono'}, t.port ? String(t.port) : '—')];
  };
  // Keep the order of the incoming list (it may be sorted by CPU), keyed by the first copy seen.
  const groups = new Map();
  for (const t of list) {
    const key = group ? t.id : `${t.region}/${t.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const tbody = h('tbody');
  const paint = () => {
    tbody.replaceChildren(...[...groups.values()].flatMap(copies => {
      const main = copies.find(t => t.role === 'primary') || copies[0];
      const others = copies.filter(t => t !== main);
      const expanded = expandedTenants.has(main.id);
      const toggle = others.length ? h('button', {type: 'button', class: `icon-btn expander ${expanded ? 'open' : ''}`, 'aria-expanded': String(expanded), 'aria-label': expanded ? 'Hide standby' : 'Show standby', title: expanded ? 'Hide standby' : `Show standby on node-${others[0].region}`, onclick: event => { event.stopPropagation(); expanded ? expandedTenants.delete(main.id) : expandedTenants.add(main.id); paint(); }}, icon('chevron')) : h('span', {class: 'expander-gap'});
      const row = h('tr', {class: 'clickable', tabindex: '0', onclick: () => open(main), onkeydown: e => { if (e.key === 'Enter') open(main); }},
        h('td', null, h('div', {class: 'name-cell'}, toggle, h('span', {class: 'app-icon'}, icon('docker')), h('div', {class: 'text'}, h('div', {class: 'primary-text'}, hostOf(main)), h('div', {class: 'sub mono'}, main.id, others.length && !expanded ? h('span', {class: 'standby-hint'}, ` · standby on node-${others[0].region}`) : null)))),
        ...cells(main));
      return [row, ...(expanded ? others.map(t => h('tr', {class: 'clickable standby-row', tabindex: '0', onclick: () => open(t), onkeydown: e => { if (e.key === 'Enter') open(t); }},
        h('td', null, h('div', {class: 'name-cell'}, h('span', {class: 'expander-gap'}), h('span', {class: 'tree'}, '└'), h('div', {class: 'text'}, h('div', {class: 'primary-text'}, `Standby on node-${t.region}`), h('div', {class: 'sub'}, t.role === 'secondary' ? 'Standby copy. Holds no data and serves no visitors; the router sends everyone to the home node.' : roleLabel(t.role))))),
        ...cells(t))) : [])];
    }));
  };
  paint();
  return h('div', {class: 'card table-card'}, h('div', {class: 'table-scroll'}, h('table', null,
    h('thead', null, h('tr', null, h('th', null, 'Tenant'), h('th', null, 'Status'), h('th', null, 'CPU'), h('th', null, 'Memory'), h('th', null, region ? 'Node' : 'Role'), h('th', {class: 'right'}, 'Port'))),
    tbody)));
}

/* ---------------------------------------------------------------- home */
// One usage cell: a thin bar with the figure underneath.
function usageCell(fraction, text) {
  return h('div', {class: 'usage-cell'}, meter(fraction), h('span', null, text));
}
const linkBytes = r => (r.network?.linkMbps > 0 ? r.network.linkMbps : 1000) * 125000;
function networkText(r) {
  const n = r.network || {};
  return h('span', {class: 'net', title: 'Received / sent per second'}, icon('arrowDown'), h('span', null, rate(n.rxBytesPerSecond)), icon('arrowUp'), h('span', null, rate(n.txBytesPerSecond)));
}
function nodeTable(nodes) {
  const rows = nodes.map(n => {
    const tone = nodeTone(n);
    const go2 = () => go(`#/node/${n.region}`);
    const name = h('td', null, h('div', {class: 'name-cell'}, flag(n.region), h('div', {class: 'text'}, h('div', {class: 'primary-text'}, `node-${n.region}`), h('div', {class: 'sub'}, n.host))));
    const status = h('td', null, h('div', {class: 'stack'}, h('span', {class: 'status'}, h('span', {class: `dot ${tone.tone}`}), tone.label), h('span', {class: 'sub'}, n.ok ? [n.latencyMs !== null && n.latencyMs !== undefined ? `${n.latencyMs} ms` : 'latency —', ` · up ${duration(n.node.resources.uptimeSeconds)}`] : explain(new ApiError(n.error)))));
    if (!n.ok) return h('tr', {class: 'clickable', onclick: go2}, name, status, h('td', {colspan: '5', class: 'faint'}, 'No data'));
    const r = n.node.resources;
    const running = n.tenants.filter(t => t.container?.running).length;
    const busiest = Math.max(r.network?.rxBytesPerSecond || 0, r.network?.txBytesPerSecond || 0);
    return h('tr', {class: 'clickable', tabindex: '0', onclick: go2, onkeydown: e => { if (e.key === 'Enter') go2(); }}, name, status,
      h('td', null, usageCell((r.cpu.usagePercent || 0) / 100, `${pct(r.cpu.usagePercent)} of ${r.cpu.cores} cores`)),
      h('td', null, usageCell(r.memory.usedBytes / r.memory.totalBytes, `${bytes(r.memory.usedBytes)} / ${bytes(r.memory.totalBytes, 0)}`)),
      h('td', null, usageCell(r.disk.usedBytes / r.disk.totalBytes, `${bytes(r.disk.usedBytes)} / ${bytes(r.disk.totalBytes, 0)}`)),
      h('td', null, h('div', {class: 'usage-cell'}, meter(busiest / linkBytes(r)), networkText(r))),
      h('td', {class: 'right'}, h('div', {class: 'stack right'}, h('span', null, String(n.tenants.length)), h('span', {class: 'sub'}, `${running} running`))));
  });
  return h('div', {class: 'card table-card'}, h('div', {class: 'table-scroll'}, h('table', {class: 'nodes'},
    h('thead', null, h('tr', null, h('th', null, 'Node'), h('th', null, 'Status'), h('th', null, 'CPU'), h('th', null, 'Memory'), h('th', null, 'Disk'), h('th', null, 'Network'), h('th', {class: 'right'}, 'Tenants'))),
    h('tbody', null, rows))));
}
async function homePage(ctx) {
  const draw = data => {
    const online = data.nodes.filter(n => n.ok);
    const tenants = allTenants(data);
    const memUsed = online.reduce((s, n) => s + n.node.resources.memory.usedBytes, 0);
    const memTotal = online.reduce((s, n) => s + n.node.resources.memory.totalBytes, 0);
    const cpu = online.length ? online.reduce((s, n) => s + (n.node.resources.cpu.usagePercent || 0), 0) / online.length : null;
    const tone = online.length === data.nodes.length ? 'green' : online.length ? 'amber' : 'red';
    ctx.fill([
      crumbs([{label: state.session.label}, {label: 'Overview'}]),
      pageHead({title: 'Overview', pill: {tone, label: `${online.length} of ${data.nodes.length} nodes online`}, actions: [button('Refresh', {icon: 'refresh', onClick: () => refresh(true)}), state.session.provisioning ? h('a', {class: 'btn', href: '#/instances/new'}, icon('plus'), 'Create instance') : null, h('a', {class: 'btn primary', href: '#/tenants'}, icon('layers'), 'All tenants')]}),
      h('div', {class: 'cards'},
        statCard('cpu', 'CPU', pct(cpu), 'average across nodes'),
        statCard('memory', 'Memory used', bytes(memUsed), `of ${bytes(memTotal, 0)}`),
        statCard('docker', 'Tenants', String(uniqueCount(tenants)), `${uniqueCount(tenants.filter(t => t.container?.running && t.role !== 'secondary'))} serving`)),
      h('div', {class: 'section'}, h('div', {class: 'section-head'}, h('h2', null, 'Nodes'), h('span', {class: 'note'}, `Updated ${ago(state.overviewAt)}`)), nodeTable(data.nodes)),
      h('div', {class: 'section'}, h('div', {class: 'section-head'}, h('h2', null, 'Busiest tenants'), h('a', {class: 'note', href: '#/tenants'}, 'View all')), tenantTable([...tenants].sort((a, b) => (b.resources?.cpuPercent || 0) - (a.resources?.cpuPercent || 0)).slice(0, 8)))]);
    ctx.refreshSidebar();
  };
  const refresh = async force => { try { draw(await overview(force)); } catch (error) { if (ctx.alive()) fail(error); } };
  draw(await overview());
  every(15000, () => refresh(true));
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
    pageHead({title: 'Tenants', subtitle: `${uniqueCount(allTenants(data))} tenant${uniqueCount(allTenants(data)) === 1 ? '' : 's'} across ${data.nodes.length} nodes, each with a standby on the other node`, actions: [button('Refresh', {icon: 'refresh', onClick: async () => { try { draw(await overview(true)); } catch (e) { fail(e); } }}), state.session.provisioning ? h('a', {class: 'btn primary', href: '#/instances/new'}, icon('plus'), 'Create instance') : null]}),
    h('div', {class: 'banner info explainer'}, icon('info'), h('div', null, h('strong', null, 'Why two copies? '), 'Each tenant runs on its ', h('strong', null, 'home'), ' node, which owns its database and serves every visitor. The other node keeps a ', h('strong', null, 'standby'), ' copy for future failover; it holds no data. Expand a row with the arrow to see it.')),
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
      pageHead({title: `node-${region}`, lead: flag(region), pill: tone, subtitle: n.host, actions: [button('Refresh', {icon: 'refresh', onClick: async () => { try { draw(await overview(true)); } catch (e) { fail(e); } }})]})];
    if (!n.ok) return ctx.fill([...head, h('div', {class: 'banner error'}, icon('alert'), explain(new ApiError(n.error))), h('div', {class: 'card'}, h('div', {class: 'empty'}, h('strong', null, 'This node did not answer'), 'Check that spartan-agent and spartan-tunnel are running, that ADMIN_API_SECRET is set on the node, and that the node hostname is not behind a Cloudflare challenge.'))]);
    const r = n.node.resources;
    const running = n.tenants.filter(t => t.container?.running).length;
    const tenants = n.tenants.map(t => ({...t, region}));
    const select = key => { tab = key; history.replaceState(null, '', `#/node/${region}${key === 'tenants' ? '' : `?tab=${key}`}`); draw(state.overview); };
    const busiest = Math.max(r.network?.rxBytesPerSecond || 0, r.network?.txBytesPerSecond || 0);
    const body = tab === 'resources' ? resourcesTab(n, tenants) : [
      h('div', {class: 'cards four'},
        statCard('cpu', 'CPU', pct(r.cpu.usagePercent), `of ${r.cpu.cores} cores`, meter((r.cpu.usagePercent || 0) / 100)),
        statCard('memory', 'Memory used', bytes(r.memory.usedBytes), `of ${bytes(r.memory.totalBytes, 0)}`, meter(r.memory.usedBytes / r.memory.totalBytes)),
        statCard('network', 'Network in', rate(r.network?.rxBytesPerSecond), `${rate(r.network?.txBytesPerSecond)} out`, meter(busiest / linkBytes(r))),
        statCard('docker', 'Tenants', String(n.tenants.length), `${running} running`)),
      h('div', {class: 'section-head'}, h('h2', null, 'Tenants on this node'), h('span', {class: 'note'}, `Updated ${ago(state.overviewAt)}`)),
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
  const ready = (ok, extra) => h('span', {class: 'status'}, h('span', {class: `dot ${ok ? 'green' : 'red'}`}), ok ? `Ready${extra ? ` · ${extra}` : ''}` : 'Unavailable');
  return [
    h('div', {class: 'cards'},
      statCard('disk', 'Disk used', bytes(r.disk.usedBytes), `of ${bytes(r.disk.totalBytes, 0)}`, meter(r.disk.usedBytes / r.disk.totalBytes)),
      statCard('activity', 'Load average', (r.cpu.loadAverage[0] || 0).toFixed(2), `${(r.cpu.loadAverage[1] || 0).toFixed(2)} · ${(r.cpu.loadAverage[2] || 0).toFixed(2)} over 5 and 15 min`),
      statCard('clock', 'Uptime', duration(r.uptimeSeconds), `since ${new Date(Date.now() - r.uptimeSeconds * 1000).toLocaleDateString()}`)),
    h('div', {class: 'section'}, h('div', {class: 'section-head'}, h('h2', null, 'Host')), h('div', {class: 'card'}, h('dl', {class: 'details'},
      detail(h('span', {class: 'label-icon'}, icon('docker'), 'Docker'), ready(n.node.dockerReady, n.node.dockerVersion)),
      detail(h('span', {class: 'label-icon'}, icon('database'), 'MariaDB'), ready(n.node.databaseReady)),
      detail('Memory free', bytes(r.memory.freeBytes)), detail('Disk available', bytes(r.disk.availableBytes)),
      detail('Latency', n.latencyMs !== null && n.latencyMs !== undefined ? `${n.latencyMs} ms` : '—'),
      detail('Region', h('span', {class: 'label-icon'}, flag(n.region), regionName(n.region))),
      detail('Network in / out', `${rate(r.network?.rxBytesPerSecond)} / ${rate(r.network?.txBytesPerSecond)}`),
      detail('Link speed', r.network?.linkMbps > 0 ? `${r.network.linkMbps >= 1000 ? `${r.network.linkMbps / 1000} Gbit/s` : `${r.network.linkMbps} Mbit/s`}` : 'Not reported')))),
    h('div', {class: 'section'}, h('div', {class: 'section-head'}, h('h2', null, 'Top memory use')), tenantTable(top, {region: false, empty: 'No running containers'}))];
}
const detail = (label, value) => h('div', null, h('dt', null, label), h('dd', {title: typeof value === 'string' ? value : null}, value));

/* ---------------------------------------------------------------- suspend, resume, terminate */
// One flow for the tenant page and the instance page. Terminate asks for the hostname.
async function changeLifecycle(id, host, action, after) {
  const texts = {
    suspend: {title: `Suspend ${host}?`, message: ['Visitors get the suspended page and the containers stop on both nodes. The database, files and backups are kept, and you can resume at any time.'], confirm: 'Suspend', danger: true},
    resume: {title: `Resume ${host}?`, message: ['Starts the containers again (home node first) and tells the router the site is live. It can take a minute.'], confirm: 'Resume'},
    terminate: {title: `Terminate ${host}?`, message: ['The router stops serving it, a customer domain is detached, and the containers are removed from both nodes. This tenant ID can never be used again.', 'The database, storage folder and backups stay on the nodes; remove them by hand if you need the space.'], confirm: 'Terminate', danger: true}
  }[action];
  if (action === 'terminate') {
    const typed = await promptDialog({title: texts.title, label: `Type ${host} to confirm`, confirm: 'Terminate', hint: texts.message.join(' ')});
    if (typed === null) return;
    if (typed !== host) return toast('The name did not match; nothing was changed.', {error: true});
  } else if (!await confirmDialog(texts)) return;
  const note = toast(`${texts.confirm.replace(/e$/, '')}ing ${host}…`, {timeout: 0});
  try {
    const result = await api.post(`/api/tenants/${id}/lifecycle`, {action});
    note.update(result.status === 'queued' ? `${texts.confirm} queued for ${host}. The dashboard runner will complete it automatically.` : `${host} is ${result.status} (lifecycle version ${result.lifecycleVersion}).`); note.close(4000);
    state.overview = null; state.details.clear();
    after?.();
  } catch (error) { note.close(); fail(error); }
}
const lifecycleItems = (id, host, status, after) => state.session.provisioning ? [
  '-',
  status === 'suspended' ? {label: 'Resume tenant', icon: 'play', onClick: () => changeLifecycle(id, host, 'resume', after)} : {label: 'Suspend tenant', icon: 'lock', onClick: () => changeLifecycle(id, host, 'suspend', after)},
  {label: 'Terminate tenant', icon: 'trash', danger: true, onClick: () => changeLifecycle(id, host, 'terminate', after)}] : [];

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
  // Docker applies a new limit to the running container immediately; no restart.
  const changeCpuLimit = async () => {
    const value = await promptDialog({title: 'CPU limit', label: 'CPUs for this tenant (for example 2.5)', value: data.cpuLimitSource === 'tenant' ? String(data.cpuLimit) : '', confirm: 'Apply',
      hint: `Leave empty to use the node default (${data.nodeCpuDefault || '2.5'} CPUs). Currently ${data.cpuLimit || '—'} CPUs${data.cpuLimitSource === 'tenant' ? ', set for this tenant' : ', from the node default'}. Applies at once, without a restart.`});
    if (value === null) return;
    const cpuLimit = value === '' || value.toLowerCase() === 'default' ? null : value;
    await act('CPU limit', 'resources', {cpuLimit});
  };
  const actions = [
    button('Reload', {icon: 'zap', title: 'Clear Laravel caches and reload Octane workers', disabled: !running, onClick: () => act('Reload', 'reload', {})}),
    running ? button('Restart', {icon: 'refresh', onClick: () => act('Restart', 'container', {action: 'restart'}, {confirmText: `Restart the container for ${host}? Visitors see errors for a few seconds.`})})
      : button('Start', {icon: 'play', disabled: ['suspended', 'terminated'].includes(data.status), onClick: () => act('Start', 'container', {action: 'start'})}),
    h('button', {type: 'button', class: 'btn', 'aria-label': 'More actions', title: 'More actions', onclick: event => openMenu(event.currentTarget, [
      {label: 'Change CPU limit', icon: 'cpu', onClick: () => changeCpuLimit()},
      {label: 'Upgrade to node image', icon: 'upgrade', onClick: () => act('Upgrade', 'upgrade', {}, {confirmText: ['Recreate the container on the image configured on this node.', 'The new image is pulled first; if it fails to start, the previous image is restored. Storage and the database are untouched.']})},
      ...(data.role === 'primary' ? [{label: 'Download database (SQL)', icon: 'database', onClick: () => { api.download(`${base}/database`); toast('Preparing the SQL export… the download starts when it is ready.'); }}] : []),
      '-',
      {label: 'Stop container', icon: 'stop', danger: true, onClick: () => act('Stop', 'container', {action: 'stop'}, {confirmText: [`Stop the container for ${host}?`, 'Maintenance only: the site goes offline until you start it again. To take a customer offline, use Suspend tenant.'], danger: true})},
      ...lifecycleItems(id, host, data.status, () => { if (ctx.alive()) render(); })
    ])}, icon('more')),
    /^https?:\/\//i.test(data.activeUrl || data.url || '') ? h('a', {class: 'btn primary', href: data.activeUrl || data.url, target: '_blank', rel: 'noopener noreferrer'}, icon('external'), 'Open site') : null];
  const select = key => go(`#/tenant/${region}/${id}${key === 'overview' ? '' : `/${key}`}`);
  ctx.fill([
    crumbs([{label: state.session.label, href: '#/'}, {label: `node-${region}`, href: `#/node/${region}`}, {label: host}]),
    pageHead({title: host, lead: h('span', {class: 'app-icon large'}, icon('docker')), pill: status, subtitle: h('span', {class: 'mono'}, id), actions}),
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
    data.role === 'secondary' ? h('div', {class: 'banner info'}, icon('info'), h('div', {style: {flex: '1'}}, `This is the standby copy on node-${ctx.region}. It holds no data and serves no visitors; the app runs on the home node, node-${data.primary}.`), h('a', {class: 'btn small', href: `#/tenant/${data.primary}/${data.id}`}, 'Open home copy')) : null,
    data.status === 'suspended' ? h('div', {class: 'banner info'}, icon('info'), state.session.provisioning ? 'Suspended. Visitors see the suspended page; data is kept. Resume it from More actions.' : 'Suspended. Resume it from the master website.') : null,
    data.status === 'provisioning' ? h('div', {class: 'banner warn'}, icon('alert'), h('div', {style: {flex: '1'}}, data.applicationHealthy
        ? 'The app is healthy but the node still records this tenant as provisioning, so the first administrator may not exist yet and the router may not know it. Open its deployment to see progress or press Retry deployment.'
        : 'This tenant is still being provisioned. Open its deployment to see each step and the container log.'),
      state.session.provisioning ? h('a', {class: 'btn small', href: `#/instances/${data.id}`}, icon('rocket'), 'Open deployment') : null) : null,
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
      detail('CPU limit', data.cpuLimit ? `${data.cpuLimit} CPUs${data.cpuLimitSource === 'tenant' ? ' (this tenant)' : ' (node default)'}` : '—'), detail('Memory limit', r ? bytes(dockerSize(String(r.memoryUsage || '').split('/')[1]), 0) : '—'),
      detail('Lifecycle version', String(data.lifecycleVersion ?? 0)), detail('Out-of-memory kills', c.oomKilled ? 'Yes, last exit' : 'None'),
      detail('Home region', h('span', {class: 'label-icon'}, flag(data.primary), regionName(data.primary || '—'))), detail('This copy', data.role === 'primary' ? 'Home (serves visitors, owns the database)' : 'Standby (no data, no visitors)'),
      detail('Plan', data.plan || '—'), detail('Image', shortImage(data.image)),
      detail('URL', data.activeUrl || data.url), detail('Container', h('span', {class: 'label-icon'}, icon('docker'), `spartan-${data.id}`))))),
    data.versions ? h('div', {class: 'section'}, h('div', {class: 'section-head'}, h('h2', null, 'Versions')), h('div', {class: 'card'}, h('pre', {class: 'code'}, JSON.stringify(data.versions, null, 2)))) : null]);
}

/* ---------------------------------------------------------------- files */
async function filesTab(ctx) {
  const key = `${ctx.region}/${ctx.id}`;
  const fstate = state.files.get(key) || {path: '/var/www/html', user: 'www-data'};
  state.files.set(key, fstate);
  if (ctx.query.get('path')) fstate.path = ctx.query.get('path');
  if (ctx.query.get('edit')) return editorView(ctx, fstate, ctx.query.get('edit'));
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
    button('New file', {icon: 'filePlus', small: true, onClick: async () => { const name = await promptDialog({title: 'New file', label: 'File name', confirm: 'Create'}); if (name) { try { await call({action: 'create', path: joinPath(fstate.path, name)}); go(editHash(ctx, fstate.path, joinPath(fstate.path, name))); } catch (e) { fail(e); } } }}),
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
  const openEntry = () => isDir ? open(full) : go(editHash(ctx, fstate.path, full));
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
  const glyph = entry.type === 'link' ? 'link' : isDir ? 'folder' : archive ? 'fileZip'
    : /\.(php|js|mjs|ts|json|css|scss|html|vue|py|sh|ya?ml|xml|sql|ini|conf|env)$|^\.env/i.test(entry.name) ? 'fileCode'
    : /\.(png|jpe?g|gif|svg|webp|ico|avif)$/i.test(entry.name) ? 'photo'
    : /\.(txt|md|log|csv)$/i.test(entry.name) ? 'fileText' : 'file';
  return h('tr', {ondblclick: openEntry},
    h('td', null, h('div', {class: 'file-name'}, h('span', {class: `glyph ${isDir ? 'dir' : ''}`}, icon(glyph)), h('button', {type: 'button', class: 'link', onclick: openEntry}, entry.name), entry.type === 'link' && entry.target ? h('span', {class: 'faint mono'}, `→ ${entry.target}`) : null)),
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
const editHash = (ctx, dir, file) => `#/tenant/${ctx.region}/${ctx.id}/files?path=${encodeURIComponent(dir)}&edit=${encodeURIComponent(file)}`;

/* Monaco is served by the dashboard itself (installed by install-dashboard.sh), never from
   a CDN. If it is missing or fails to load, the editor falls back to a plain text area. */
const MONACO_BASE = 'vendor/monaco-0.52.2/vs';
let monacoLoading = null;
function loadMonaco() {
  if (window.monaco) return Promise.resolve(window.monaco);
  if (monacoLoading) return monacoLoading;
  monacoLoading = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('monaco_timeout')), 15000);
    const script = document.createElement('script');
    script.src = `${MONACO_BASE}/loader.js`;
    script.onerror = () => { clearTimeout(timer); reject(new Error('monaco_unavailable')); };
    script.onload = () => {
      // Absolute, so Monaco's blob: workers (which have no base path) find it under /panel/ too.
      window.require.config({paths: {vs: new URL(MONACO_BASE, document.baseURI).href}});
      window.require(['vs/editor/editor.main'], () => { clearTimeout(timer); resolve(window.monaco); }, error => { clearTimeout(timer); reject(error); });
    };
    document.head.append(script);
  }).catch(error => { monacoLoading = null; throw error; });
  return monacoLoading;
}
const LANGUAGES = {php: 'php', js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', jsx: 'javascript', json: 'json', css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html', vue: 'html', xml: 'xml', svg: 'xml', md: 'markdown', yml: 'yaml', yaml: 'yaml', sql: 'sql', sh: 'shell', bash: 'shell', py: 'python', ini: 'ini', conf: 'ini', env: 'ini', dockerfile: 'dockerfile', twig: 'twig', txt: 'plaintext', log: 'plaintext'};
function languageOf(file) {
  const name = file.split('/').pop().toLowerCase();
  if (name.endsWith('.blade.php')) return 'php';
  if (name === 'dockerfile') return 'dockerfile';
  if (name.startsWith('.env')) return 'ini';
  return LANGUAGES[name.includes('.') ? name.split('.').pop() : ''] || 'plaintext';
}
// Asked before leaving the page (hash change or closing the tab) while there are unsaved edits.
let leaveGuard = null;
window.addEventListener('beforeunload', event => { if (leaveGuard && leaveGuard()) { event.preventDefault(); event.returnValue = ''; } });
let lastHash = location.hash;
window.addEventListener('hashchange', event => {
  if (leaveGuard && leaveGuard() && !window.confirm('Discard unsaved changes?')) { event.stopImmediatePropagation(); history.replaceState(null, '', lastHash); return; }
  leaveGuard = null;
  lastHash = location.hash;
}, true);

async function editorView(ctx, fstate, full) {
  const back = () => go(`#/tenant/${ctx.region}/${ctx.id}/files?path=${encodeURIComponent(parentOf(full))}`);
  ctx.fill(h('div', {class: 'card'}, loading()));
  let file;
  try { file = await api.post(`${ctx.base}/fs`, {user: fstate.user, action: 'read', path: full}); }
  catch (error) {
    if (!ctx.alive()) return;
    return ctx.fill([h('div', {class: 'banner error'}, icon('alert'), `${full}: ${explain(error)}`), h('div', {class: 'actions'}, button('Back to folder', {onClick: back}), fstate.user === 'www-data' && error.code === 'permission_denied' ? button('Open as root', {onClick: () => { fstate.user = 'root'; editorView(ctx, fstate, full); }}) : null)]);
  }
  if (!ctx.alive()) return;
  const download = () => api.download(`${ctx.base}/fs/download?path=${encodeURIComponent(full)}&user=${fstate.user}`);
  if (file.binary) return ctx.fill(h('div', {class: 'card'}, h('div', {class: 'empty'}, h('strong', null, 'This is not a text file'), `${full} cannot be edited here.`, h('div', {class: 'actions', style: {justifyContent: 'center', marginTop: '14px'}}, button('Back to folder', {onClick: back}), button('Download', {icon: 'download', kind: 'primary', onClick: download})))));
  const original = new TextDecoder().decode(fromBase64(file.contentBase64));
  let modifiedAt = file.modifiedAt, saved = original, editor = null, area = null;
  const value = () => editor ? editor.getValue() : area.value;
  const dirty = () => value() !== saved;
  const status = h('span', {class: 'editor-status'}, `${bytes(file.size)} · ${file.mode} · as ${fstate.user}${file.persistent ? '' : ' · not persistent'}`);
  const markDirty = () => { status.textContent = dirty() ? 'Unsaved changes' : 'Saved'; status.classList.toggle('dirty', dirty()); };
  const save = async (force = false) => {
    saveButton.disabled = true;
    try {
      const text = value();
      const result = await api.post(`${ctx.base}/fs`, {user: fstate.user, action: 'write', path: full, contentBase64: toBase64(new TextEncoder().encode(text)), ...(force ? {} : {expectModifiedAt: modifiedAt})});
      modifiedAt = result.modifiedAt; saved = text; markDirty(); status.textContent = `Saved ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      if (error.code === 'file_changed' && await confirmDialog({title: 'File changed on disk', message: 'Someone or something changed this file after you opened it. Overwrite it with your version?', confirm: 'Overwrite', danger: true})) return save(true);
      fail(error);
    } finally { saveButton.disabled = false; }
  };
  const saveButton = button('Save', {icon: 'check', kind: 'primary', small: true, onClick: () => save()});
  const host = h('div', {class: 'code-host'});
  const segments = full.slice(1).split('/');
  ctx.fill([
    full.startsWith('/var/www/html/storage') || file.persistent ? null : h('div', {class: 'banner warn'}, icon('alert'), 'Not persistent. Changes outside /var/www/html/storage are lost when the container is upgraded or recreated.'),
    h('div', {class: 'card table-card editor-card'},
      h('div', {class: 'toolbar'},
        h('div', {class: 'path'}, button('', {icon: 'arrowLeft', small: true, kind: 'ghost', title: 'Back to folder', onClick: back}), segments.map((part, i) => [i ? h('span', {class: 'sep'}, '/') : h('span', {class: 'sep'}, '/'), i < segments.length - 1 ? h('button', {type: 'button', onclick: () => go(`#/tenant/${ctx.region}/${ctx.id}/files?path=${encodeURIComponent('/' + segments.slice(0, i + 1).join('/'))}`)}, part) : h('strong', null, part)])),
        h('div', {class: 'group'}, h('span', {class: 'chip static'}, languageOf(full)), status, button('Download', {icon: 'download', small: true, onClick: download}), saveButton)),
      host)]);
  leaveGuard = dirty;
  try {
    const monaco = await loadMonaco();
    if (!ctx.alive()) return;
    editor = monaco.editor.create(host, {value: original, language: languageOf(full), theme: 'vs', automaticLayout: true, minimap: {enabled: original.length < 400000}, fontSize: 13, tabSize: 4, insertSpaces: true, scrollBeyondLastLine: false, renderWhitespace: 'selection', wordWrap: 'off', fixedOverflowWidgets: true});
    editor.onDidChangeModelContent(markDirty);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save());
    editor.focus();
    // Monaco keeps models alive until disposed; free it when this page goes away.
    const watch = setInterval(() => { if (!ctx.alive()) { clearInterval(watch); editor.getModel()?.dispose(); editor.dispose(); } }, 1000);
  } catch {
    if (!ctx.alive()) return;
    area = h('textarea', {class: 'editor', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off'});
    area.value = original;
    area.addEventListener('input', markDirty);
    area.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
      if (event.key === 'Tab' && !event.shiftKey) { event.preventDefault(); const {selectionStart: a, selectionEnd: b} = area; area.setRangeText('    ', a, b, 'end'); markDirty(); }
    });
    host.replaceWith(area);
    area.focus();
  }
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
    pageHead({title: 'Activity', subtitle: 'Sign-ins and actions since the dashboard last started. Also written to the journal.', actions: [button('Refresh', {icon: 'refresh', onClick: () => render()})]}),
    rows.length ? h('div', {class: 'card table-card'}, h('div', {class: 'table-scroll'}, h('table', null, h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'User'), h('th', null, 'Event'), h('th', null, 'Target'), h('th', null, 'Detail'))), h('tbody', null, rows))))
      : h('div', {class: 'card'}, h('div', {class: 'empty'}, h('strong', null, 'Nothing yet'), 'Actions you take appear here.'))]);
}

/* ---------------------------------------------------------------- create instance */
const PRODUCT_PREFIXES = [['SPARTANSTARTER_', 'Starter'], ['SPARTANCLOUD_', 'Cloud'], ['SPARTANCLOUDPLUS_', 'Cloud Plus'], ['SPARTANPROFESSIONAL_', 'Professional'], ['SPARTANULTIMATE_', 'Ultimate'], ['SPARTANDEV_', 'Developer']];
const productOf = key => (PRODUCT_PREFIXES.find(([prefix]) => key.startsWith(prefix)) || [])[1] || null;
const INSTANCE_STATUS = {suspended: ['Suspended', ''], terminated: ['Terminated', ''], awaiting_dns: ['Waiting for DNS', 'amber'], ready_to_deploy: ['Ready to deploy', ''], queued: ['Queued', 'amber'], deploying: ['Deploying', 'amber'], ready: ['Live', 'green'], failed: ['Failed', 'red']};
const instanceStatus = item => { const [label, tone] = INSTANCE_STATUS[item.status] || [item.status, '']; return {label, tone}; };
function copyButton(text) {
  return h('button', {type: 'button', class: 'icon-btn', title: 'Copy', 'aria-label': 'Copy', onclick: async () => { try { await navigator.clipboard.writeText(typeof text === 'function' ? text() : text); toast('Copied'); } catch { toast('Copy failed; select the text instead', {error: true}); } }}, icon('copy'));
}
function disabledNotice(ctx) {
  ctx.fill([crumbs([{label: state.session.label, href: '#/'}, {label: 'Create instance'}]), pageHead({title: 'Create instance'}),
    h('div', {class: 'card'}, h('div', {class: 'empty'}, h('strong', null, 'Instance creation is not configured'), 'Re-run sudo bash scripts/install-dashboard.sh on this node. It adds ORIGIN_SECRET and BASE_DOMAIN from node.env to dashboard.env.'))]);
}

async function instancesPage(ctx) {
  if (!state.session.provisioning) return disabledNotice(ctx);
  const data = await api.get('/api/instances');
  const rows = data.instances.map(item => h('tr', {class: 'clickable', tabindex: '0', onclick: () => go(`#/instances/${item.id}`), onkeydown: e => { if (e.key === 'Enter') go(`#/instances/${item.id}`); }},
    h('td', null, h('div', {class: 'name-cell'}, h('span', {class: 'app-icon'}, icon('rocket')), h('div', {class: 'text'}, h('div', {class: 'primary-text'}, item.hostname), h('div', {class: 'sub mono'}, item.id)))),
    h('td', null, (s => h('span', {class: 'status'}, h('span', {class: `dot ${s.tone}`}), s.label))(instanceStatus(item))),
    h('td', null, item.product || '—'),
    h('td', null, h('span', {class: 'label-icon'}, flag(item.primary), regionName(item.primary))),
    h('td', {class: 'muted', title: item.createdAt}, ago(item.createdAt))));
  ctx.fill([
    crumbs([{label: state.session.label, href: '#/'}, {label: 'Instances'}]),
    pageHead({title: 'Instances', subtitle: 'Spartan instances created from this dashboard', actions: [button('Refresh', {icon: 'refresh', onClick: () => render()}), h('a', {class: 'btn primary', href: '#/instances/new'}, icon('plus'), 'Create instance')]}),
    rows.length ? h('div', {class: 'card table-card'}, h('div', {class: 'table-scroll'}, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Instance'), h('th', null, 'Status'), h('th', null, 'Product'), h('th', null, 'Region'), h('th', null, 'Created'))), h('tbody', null, rows))))
      : h('div', {class: 'card'}, h('div', {class: 'empty'}, h('strong', null, 'No instances yet'), 'Create one to provision it on both nodes and publish it to the router.', h('div', {style: {marginTop: '14px'}}, h('a', {class: 'btn primary', href: '#/instances/new'}, icon('plus'), 'Create instance'))))]);
  if (data.instances.some(item => ['deploying', 'queued'].includes(item.status) || item.operation)) every(5000, () => render());
}

function choiceGroup(name, options, value, onChange) {
  return h('div', {class: 'choices', role: 'radiogroup'}, options.map(option => {
    const input = h('input', {type: 'radio', name, value: option.value, checked: option.value === value, disabled: option.disabled, onchange: () => onChange(option.value)});
    return h('label', {class: `choice ${option.disabled ? 'disabled' : ''}`}, input, h('span', {class: 'choice-body'}, h('span', {class: 'choice-title'}, option.lead || null, option.title), option.text ? h('span', {class: 'choice-text'}, option.text) : null));
  }));
}

async function newInstancePage(ctx) {
  if (!state.session.provisioning) return disabledNotice(ctx);
  const zone = state.session.provisioning.instanceDomain || state.session.provisioning.baseDomain;
  const nodes = state.session.nodes.map(n => n.region);
  const centralDatabase = state.session.provisioning.databaseMode === 'us-central';
  const form = {primary: nodes.includes('us') ? 'us' : nodes[0], domainMode: 'default'};
  const license = h('input', {class: 'input mono', placeholder: 'SPARTANPROFESSIONAL_…', spellcheck: 'false', autocomplete: 'off'});
  const product = h('span', {class: 'hint'});
  const syncProduct = () => { const name = productOf(license.value.trim()); product.replaceChildren(...(license.value.trim() ? (name ? [icon('check'), `Product: ${name}`] : ['Unknown prefix']) : ['The product is read from the key prefix.'])); product.className = `hint ${license.value.trim() && !name ? 'bad' : name ? 'good' : ''}`; };
  license.addEventListener('input', syncProduct);
  syncProduct();
  const domain = h('input', {class: 'input mono', placeholder: 'panel.customer.com', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off'});
  const domainField = h('label', {class: 'field', style: {display: 'none'}}, h('span', null, 'Customer domain'), domain, h('span', {class: 'hint'}, 'The licence must be issued for this domain. You will get DNS records to add before deploying.'));
  const customer = h('input', {class: 'input mono', placeholder: 'dashboard', spellcheck: 'false', autocomplete: 'off'});
  const submit = button('Continue', {kind: 'primary', icon: 'rocket'});
  const message = h('div', {class: 'banner error', style: {display: 'none'}});
  const regionChoices = choiceGroup('primary', [['us', 'Home: United States'], ['de', 'Home: Germany']].map(([value]) => ({value, lead: flag(value), title: regionName(value), text: centralDatabase ? value === 'us' ? 'US hosts every database. Both regions run the application.' : 'Germany connects to the US database.' : value === 'us' ? 'Database and app run in the US; Germany holds the standby.' : 'Database and app run in Germany; the US holds the standby.', disabled: !nodes.includes(value) || (centralDatabase && value !== 'us')})), form.primary, value => { form.primary = value; });
  const licenseSection = h('div', {class: 'form-section', style: {display: 'none'}}, h('h2', null, 'Licence'), h('label', {class: 'field'}, h('span', null, 'Spartan licence key, issued for the customer domain'), license, product));
  const domainChoices = choiceGroup('domain', [{value: 'default', title: 'Assigned subdomain', text: `instance-1234.${zone} style, free SSL. You get the name first, then enter its licence.`}, {value: 'custom', title: 'Customer domain', text: 'Verified with DNS before deploying'}], form.domainMode, value => { form.domainMode = value; domainField.style.display = licenseSection.style.display = value === 'custom' ? '' : 'none'; if (value === 'custom') domain.focus(); });
  submit.addEventListener('click', async () => {
    message.style.display = 'none';
    submit.disabled = true;
    try {
      const item = await api.post('/api/instances', {primary: form.primary, licenseKey: form.domainMode === 'custom' ? license.value.trim() : undefined, domain: form.domainMode === 'custom' ? domain.value.trim() : '', customerId: customer.value.trim() || undefined});
      go(`#/instances/${item.id}`);
    } catch (error) { if (error.code !== 'not_signed_in') { message.replaceChildren(icon('alert'), explain(error)); message.style.display = ''; } }
    finally { submit.disabled = false; }
  });
  ctx.fill([
    crumbs([{label: state.session.label, href: '#/'}, {label: 'Instances', href: '#/instances'}, {label: 'New'}]),
    pageHead({title: 'Create instance', subtitle: 'Provisions on both nodes, then publishes the tenant to the router.'}),
    nodes.length < 2 ? h('div', {class: 'banner warn'}, icon('alert'), 'Both nodes must be configured in this dashboard to create instances.') : null,
    h('div', {class: 'card form-card'},
      message,
      h('div', {class: 'form-section'}, h('h2', null, 'Region'), h('p', {class: 'muted'}, 'The home region owns the database. It cannot be changed later.'), regionChoices),
      h('div', {class: 'form-section'}, h('h2', null, 'Domain'), domainChoices, domainField),
      licenseSection,
      h('div', {class: 'form-section'}, h('h2', null, 'Reference'), h('label', {class: 'field'}, h('span', null, 'Customer reference (optional)'), customer, h('span', {class: 'hint'}, 'Stored with the routing record. Letters, digits, _ and -.'))),
      h('div', {class: 'form-foot'}, h('a', {class: 'btn', href: '#/instances'}, 'Cancel'), submit))]);
}

function dnsCard(item) {
  const records = item.dns?.records || [];
  const purpose = {routing: 'Points the domain at Spartan', spartan_ownership: 'Proves you own the domain', cloudflare_ownership: 'Cloudflare hostname check', certificate_validation: 'SSL certificate check'};
  const rows = records.map(r => { const value = r.value || r.target || ''; return h('tr', null,
    h('td', null, h('span', {class: 'chip static'}, r.type)),
    h('td', null, h('div', {class: 'copy-cell'}, h('span', {class: 'mono'}, r.name), copyButton(r.name))),
    h('td', null, h('div', {class: 'copy-cell'}, h('span', {class: 'mono wrap'}, value), copyButton(value))),
    h('td', {class: 'muted'}, purpose[r.purpose] || r.purpose || '', r.type === 'CNAME' && r.purpose === 'routing' ? h('div', {class: 'sub'}, 'DNS only (grey cloud) recommended') : null)); });
  return h('div', {class: 'card table-card'}, h('div', {class: 'table-scroll'}, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Type'), h('th', null, 'Name'), h('th', null, 'Value'), h('th', null, 'Purpose'))), h('tbody', null, rows.length ? rows : h('tr', null, h('td', {colspan: '4', class: 'faint'}, 'No records returned yet. Verify to refresh.'))))));
}
const clock = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };
// Text that counts up or down every second without re-rendering the page.
function liveText(compute) { const el = h('span', {class: 'live-text'}, compute()); el._compute = compute; return el; }
function tickLive() { document.querySelectorAll('.live-text').forEach(el => { el.textContent = el._compute(); }); }
function stepList(item) {
  const p = item.progress;
  const steps = [
    ['primary', `Provision on node-${item.primary} (home) with the administrator`, 'Creates the database, pulls the image if needed, starts the container, waits for the app, then creates the admin.'],
    ['secondary', `Provision the standby on node-${item.secondary}`, 'A lightweight copy that forwards visitors to the home node.'],
    ['routing', 'Publish to the router', 'Tells the routing Worker the instance is ready so its address starts working.']];
  return h('ol', {class: 'steps'}, steps.map(([key, label, hint]) => {
    const value = item.steps?.[key];
    const live = value === 'running' && p && p.role === key ? h('div', {class: 'sub'}, liveText(() => {
      const elapsed = clock(Date.now() - Date.parse(p.startedAt));
      const retry = p.retryAt ? Date.parse(p.retryAt) - Date.now() : null;
      return `Attempt ${p.attempt} · ${elapsed} elapsed · ${retry !== null && retry > 0 ? `asking again in ${clock(retry)}` : `waiting on node-${p.region} for ${clock(Date.now() - Date.parse(p.callStartedAt))}`} · gives up after 20 min`;
    })) : value === 'running' || !value ? h('div', {class: 'sub'}, hint) : null;
    return h('li', {class: value || 'pending'}, h('span', {class: 'step-mark'}, value === 'done' ? icon('check') : value === 'running' ? h('span', {class: 'spinner'}) : value === 'failed' ? icon('alert') : null), h('div', {class: 'step-text'}, label, live));
  }));
}
function activityLog(item) {
  const entries = item.log || [];
  if (!entries.length) return null;
  return h('div', {class: 'section'}, h('div', {class: 'section-head'}, h('h2', null, 'What happened'), h('span', {class: 'note'}, 'Newest last')),
    h('div', {class: 'card'}, h('ol', {class: 'timeline'}, entries.map(entry => h('li', {class: entry.tone || ''}, h('time', {title: entry.time}, new Date(entry.time).toLocaleTimeString()), h('span', null, entry.text))))));
}
// While a node works on the tenant, show what its container is doing.
async function nodeWatch(item) {
  const p = item.progress;
  if (!p) return null;
  const base = `/api/nodes/${p.region}/tenants/${item.id}`;
  const [detail, logs] = await Promise.allSettled([api.get(`${base}/detail`), api.post(`${base}/logs`, {tail: 25})]);
  const d = detail.status === 'fulfilled' ? detail.value : null;
  const state = !d ? 'The node has not created the container yet (it may be pulling the image or preparing the database).'
    : !d.container?.running ? `Container ${d.container?.state || 'not running'}.`
    : d.applicationHealthy ? 'Container running and the app answers. The node finishes on its next check.'
    : `Container running for ${d.container.startedAt ? ago(d.container.startedAt).replace(' ago', '') : 'a moment'}; the app is still starting (migrations and seeders run on first start).`;
  const lines = logs.status === 'fulfilled' ? logs.value.lines.slice(-25) : [];
  return h('div', {class: 'section'}, h('div', {class: 'section-head'}, h('h2', null, `Live from node-${p.region}`), h('span', {class: 'note'}, 'Refreshes every 4 seconds')),
    h('div', {class: 'card table-card'}, h('div', {class: 'toolbar'}, h('span', {class: 'status'}, h('span', {class: `dot ${d?.applicationHealthy ? 'green' : 'amber'}`}), state)),
      h('div', {class: 'term short', role: 'log'}, lines.length ? lines.map(line => h('div', {class: `log-line ${line.stream}`}, h('time', null, line.time ? line.time.replace('T', ' ').slice(11, 19) : ''), h('span', null, line.text))) : h('span', {class: 'sys'}, d ? 'No container output yet.' : 'Waiting for the container…'))));
}
function dnsStages(item) {
  const order = ['spartan_ownership', 'cloudflare_validation', 'routing_setup', 'ready_to_provision'];
  const labels = [['Ownership', 'The _spartan-verification TXT record proves you control the domain.'], ['SSL certificate', 'Cloudflare checks the _acme-challenge / _cf-custom-hostname records and issues the certificate. Usually 2 to 10 minutes.'], ['Routing', 'The Worker route for the domain is attached automatically.'], ['Ready', 'You can deploy.']];
  const current = Math.max(0, order.indexOf(item.dns?.stage));
  return h('div', {class: 'card'}, h('ol', {class: 'steps'}, labels.map(([label, hint], i) => h('li', {class: i < current ? 'done' : i === current ? 'running' : 'pending'}, h('span', {class: 'step-mark'}, i < current ? icon('check') : i === current ? h('span', {class: 'spinner'}) : null), h('div', {class: 'step-text'}, label, h('div', {class: 'sub'}, hint))))));
}
// Upper and lower case, digits and a symbol, so it passes Spartan's password rules.
function strongPassword() {
  const pick = (set, n) => Array.from(crypto.getRandomValues(new Uint32Array(n)), v => set[v % set.length]).join('');
  return `${pick('ABCDEFGHJKLMNPQRSTUVWXYZ', 3)}${pick('abcdefghijkmnopqrstuvwxyz', 6)}-${pick('23456789', 4)}!${pick('ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789', 6)}`;
}
function adminForm(item, onDone) {
  const automatic = h('input', {type: 'checkbox'});
  const name = h('input', {class: 'input', autocomplete: 'off', placeholder: 'Customer Owner'});
  const email = h('input', {class: 'input', type: 'email', autocomplete: 'off', placeholder: 'owner@customer.com'});
  const password = h('input', {class: 'input mono', type: 'text', autocomplete: 'off', spellcheck: 'false', value: strongPassword()});
  const adminFields = h('div', {hidden: true},
    h('p', {class: 'muted'}, 'Created as superadmin on the primary only. The password is never stored by the dashboard; copy it now.'),
    h('div', {class: 'form-grid'}, h('label', {class: 'field'}, h('span', null, 'Name'), name), h('label', {class: 'field'}, h('span', null, 'Email'), email)),
    h('label', {class: 'field'}, h('span', null, 'Password (8 to 128 characters)'), h('div', {class: 'copy-cell'}, password, copyButton(() => password.value))));
  automatic.addEventListener('change', () => { adminFields.hidden = !automatic.checked; });
  const license = item.licenseHint ? null : h('input', {class: 'input mono', placeholder: 'SPARTANCLOUD_…', spellcheck: 'false', autocomplete: 'off'});
  const product = h('span', {class: 'hint'}, `Get the Spartan licence for ${item.hostname} from DezerX and paste it here.`);
  license?.addEventListener('input', () => { const name = productOf(license.value.trim()); product.className = `hint ${name ? 'good' : 'bad'}`; product.replaceChildren(...(name ? [icon('check'), `Product: ${name}`] : ['Unknown prefix'])); });
  const deployButton = button(item.status === 'failed' ? 'Retry deployment' : 'Deploy', {kind: 'primary', icon: 'rocket'});
  deployButton.addEventListener('click', async () => {
    deployButton.disabled = true;
    try { const next = await api.post(`/api/instances/${item.id}/deploy`, {...(license ? {licenseKey: license.value.trim()} : {}), ...(automatic.checked ? {initialAdmin: {displayName: name.value.trim(), email: email.value.trim(), password: password.value}} : {})}); toast(next.status === 'queued' ? 'Queued until both nodes have room' : 'Deployment started'); onDone(); }
    catch (error) { fail(error); deployButton.disabled = false; }
  });
  return h('div', {class: 'card form-card'},
    license ? h('div', {class: 'form-section'}, h('h2', null, 'Licence'), h('label', {class: 'field'}, h('span', null, `Spartan licence key for ${item.hostname}`), license, product)) : null,
    h('div', {class: 'form-section'}, h('h2', null, 'First account'), h('p', {class: 'muted'}, 'After deployment, open the instance and complete Spartan’s signup. The first account receives superadmin access.'),
      h('label', {class: 'check'}, automatic, 'Create administrator automatically'), adminFields),
    h('div', {class: 'form-foot'}, deployButton));
}

// Polls in place while deploying, so the page does not blink back to a loading spinner.
async function instancePage(ctx, id, polling = false) {
  if (!state.session.provisioning) return disabledNotice(ctx);
  const item = await api.get(`/api/instances/${id}`);
  const status = instanceStatus(item);
  const reload = () => { if (ctx.alive()) render(); };
  const discard = async () => {
    if (!await confirmDialog({title: 'Discard this instance?', message: item.status === 'terminated' ? ['Removes this terminated instance from the list. Nothing changes on the nodes.'] : ['The dashboard forgets this draft. Nothing has been deployed for it.', item.custom ? 'The pending domain reservation stays on the routing Worker until it expires or is reused.' : ''].filter(Boolean), confirm: 'Discard', danger: true})) return;
    try { await api.post(`/api/instances/${id}/discard`); go('#/instances'); } catch (error) { fail(error); }
  };
  const verify = async event => {
    const btn = event?.currentTarget; if (btn) btn.disabled = true;
    try { const next = await api.post(`/api/instances/${id}/verify`); toast(next.dns?.readyToProvision ? 'Domain verified. Ready to deploy.' : 'Not verified yet. Records can take a few minutes to propagate.', {error: !next.dns?.readyToProvision}); reload(); }
    catch (error) { fail(error); if (btn) btn.disabled = false; }
  };
  const canDiscard = item.status === 'terminated' || (!['ready', 'deploying', 'queued', 'suspended'].includes(item.status) && item.steps?.primary !== 'done' && item.steps?.secondary !== 'done');
  const details = h('div', {class: 'card'}, h('dl', {class: 'details'},
    detail('URL', item.url), detail('Tenant ID', h('span', {class: 'mono'}, item.id)),
    detail('Home region', h('span', {class: 'label-icon'}, flag(item.primary), regionName(item.primary))), detail('Standby', h('span', {class: 'label-icon'}, flag(item.secondary), regionName(item.secondary))),
    detail('Product', item.product || '—'), detail('Licence', item.licenseHint ? h('span', {class: 'mono'}, item.licenseHint) : h('span', {class: 'faint'}, 'Entered at deploy')),
    detail('Customer reference', item.customerId), detail('Created', `${ago(item.createdAt)} by ${item.createdBy || '—'}`)));
  const body = [];
  if (item.error) body.push(h('div', {class: 'banner error'}, icon('alert'), h('div', null, h('strong', null, item.status === 'failed' ? 'Deployment stopped: ' : ''), explain(new ApiError(item.error)), item.log?.length ? ' The full sequence is under What happened, below.' : '', item.status === 'failed' ? ' Fix the cause if there is one, then press Retry deployment; it continues where it stopped.' : '')));
  if (item.status === 'awaiting_dns') body.push(
    h('div', {class: 'section'}, h('div', {class: 'section-head'}, h('h2', null, 'Domain checks'), h('span', {class: 'note'}, 'Press Verify DNS to re-check')), dnsStages(item)),
    h('div', {class: 'banner info'}, icon('info'), `Add these records at the DNS provider for ${item.hostname}, then verify. Cloudflare may add certificate records after the first check; keep all of them.`),
    h('div', {class: 'section'}, h('div', {class: 'section-head'}, h('h2', null, 'DNS records'), h('span', {class: 'note'}, item.dns?.checkedAt ? `Checked ${ago(item.dns.checkedAt)}${item.dns.stage ? ` · ${item.dns.stage.replace(/_/g, ' ')}` : ''}` : '')), dnsCard(item)));
  if (['deploying', 'ready'].includes(item.status) || (item.status === 'failed' && Object.keys(item.steps || {}).length)) body.push(h('div', {class: 'section'}, h('div', {class: 'section-head'}, h('h2', null, 'Deployment')), h('div', {class: 'card'}, stepList(item))));
  if (item.status === 'queued') {
    const q = item.queue || {};
    body.push(h('div', {class: 'section'}, h('div', {class: 'section-head'}, h('h2', null, 'Queue'), h('span', {class: 'note'}, q.checkedAt ? `Checked ${ago(q.checkedAt)} · re-checked every minute` : 'Re-checked every minute')),
      h('div', {class: 'card'}, h('div', {class: 'queue-box'}, h('div', {class: 'queue-pos'}, h('strong', null, String(q.position || 1)), h('span', null, `of ${q.length || 1}`)),
        h('div', null, h('div', {class: 'queue-title'}, q.reason ? `Waiting: ${q.reason}.` : 'Checking that both nodes have room…'),
          h('div', {class: 'sub'}, 'Deployments start one at a time per node, and only when both nodes have enough free memory and disk (DASHBOARD_MIN_FREE_MEMORY_MB, DASHBOARD_MIN_FREE_DISK_GB). It starts by itself; keep this dashboard running, since a restart clears the queue.'),
          q.since ? h('div', {class: 'sub'}, liveText(() => `In the queue for ${clock(Date.now() - Date.parse(q.since))}`)) : null)))));
  }
  if (item.status === 'deploying') { const watch = await nodeWatch(item).catch(() => null); if (watch) body.push(watch); }
  if (item.status === 'ready') body.push(h('div', {class: 'banner info'}, icon('check'), 'Live. If a master website also bills this tenant, suspend and resume it in one place only, so the two do not undo each other.'));
  if (item.status === 'ready' && item.adminCreation === 'signup') body.push(h('div', {class: 'banner info'}, icon('info'), 'Open the site to complete Spartan’s first-account signup. The first account receives superadmin access.'));
  if (item.status === 'suspended') body.push(h('div', {class: 'banner info'}, icon('lock'), 'Suspended. Visitors see the suspended page; the database and files are kept. Resume to bring it back.'));
  if (item.operation) body.push(h('div', {class: 'banner info'}, icon('info'), `${item.operation} is queued or running. The dashboard runner will finish it automatically.`));
  if (item.status === 'terminated') body.push(h('div', {class: 'banner info'}, icon('info'), 'Terminated. The containers are gone; the database, storage folder and backups remain on the nodes. Discard removes this record from the list.'));
  if (item.status === 'ready_to_deploy' || item.status === 'failed') body.push(h('div', {class: 'section'}, adminForm(item, reload)));
  if (item.custom && item.status === 'ready_to_deploy') body.push(h('div', {class: 'section'}, h('div', {class: 'section-head'}, h('h2', null, 'DNS records')), dnsCard(item)));
  body.push(activityLog(item));
  ctx.fill([
    crumbs([{label: state.session.label, href: '#/'}, {label: 'Instances', href: '#/instances'}, {label: item.hostname}]),
    pageHead({title: item.hostname, lead: h('span', {class: 'app-icon large'}, icon('rocket')), pill: status, subtitle: h('span', {class: 'mono'}, item.id), actions: [
      item.custom && ['awaiting_dns', 'ready_to_deploy', 'failed'].includes(item.status) ? button('Verify DNS', {icon: 'refresh', kind: item.status === 'awaiting_dns' ? 'primary' : '', onClick: verify}) : null,
      item.status === 'queued' ? button('Leave queue', {icon: 'stop', onClick: async () => { try { await api.post(`/api/instances/${id}/cancel`); toast('Removed from the queue'); reload(); } catch (error) { fail(error); } }}) : null,
      canDiscard ? button('Discard', {icon: 'trash', kind: 'danger', onClick: discard}) : null,
      item.status === 'suspended' ? button('Resume', {icon: 'play', kind: 'primary', onClick: () => changeLifecycle(item.id, item.hostname, 'resume', reload)}) : null,
      ['ready', 'suspended'].includes(item.status) ? h('button', {type: 'button', class: 'btn', 'aria-label': 'Lifecycle actions', title: 'Suspend or terminate', onclick: event => openMenu(event.currentTarget, lifecycleItems(item.id, item.hostname, item.status, reload).filter(entry => entry !== '-' && !(item.status === 'suspended' && entry.label === 'Resume tenant')))}, icon('more')) : null,
      ['ready', 'suspended'].includes(item.status) ? h('a', {class: 'btn', href: `#/tenant/${item.primary}/${item.id}`}, icon('docker'), 'Manage tenant') : null,
      item.status === 'ready' ? h('a', {class: 'btn primary', href: item.url, target: '_blank', rel: 'noopener noreferrer'}, icon('external'), 'Open site') : null]}),
    body,
    h('div', {class: 'section'}, h('div', {class: 'section-head'}, h('h2', null, 'Details')), details)]);
  if ((['deploying', 'queued'].includes(item.status) || item.operation) && !polling) { every(4000, () => { if (ctx.alive()) instancePage(ctx, id, true).catch(() => {}); }); every(1000, tickLive); }
}

render();
})();
