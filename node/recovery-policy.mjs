export const actions = ['repair_permissions', 'clear_cache', 'retry_pull', 'start_container', 'restart_container', 'retry_deployment', 'manual'];
export const stages = new Set(['prepare', 'pull', 'launch', 'start', 'health', 'replica']);
const signals = {
  permissions: /permission denied|not writable|failed to open stream.*permission|EACCES/i,
  stale_cache: /bootstrap\/cache|cached configuration|failed to load.*cache|view.*cache/i,
  transient_network: /TLS handshake timeout|connection reset|temporary failure|i\/o timeout|context deadline|request canceled|network is unreachable|429|too many requests/i,
  sqlite_locked: /database is locked|SQLITE_BUSY/i,
  missing_dependency: /could not find driver|class .* not found|undefined function|platform requirements|requires php|extension .* missing/i,
  migration_error: /SQLSTATE.*(?:syntax error|constraint)|migration.*failed|duplicate column|no such table/i,
  disk_full: /no space left|disk quota exceeded/i,
  out_of_memory: /out of memory|memory exhausted|OOMKilled/i
};
export function diagnose(stage, error, logs = '', state = {}) {
  const content = `${String(error?.stderr || '').slice(-12000)}\n${String(error?.message || '').slice(-2000)}\n${String(logs).slice(-12000)}`;
  return {stage: stages.has(stage) ? stage : 'prepare', signals: Object.entries(signals).filter(([, pattern]) => pattern.test(content)).map(([name]) => name), container: {exists: state.exists === true, running: state.running === true, oomKilled: state.oomKilled === true, exitCode: Number.isInteger(state.exitCode) ? Math.max(0, Math.min(255, state.exitCode)) : null}};
}
export function permitted(diagnostic, action) {
  if (['replica'].includes(diagnostic.stage) || diagnostic.container.oomKilled || diagnostic.signals.some(signal => ['disk_full', 'out_of_memory', 'missing_dependency', 'migration_error'].includes(signal))) return action === 'manual';
  switch (action) {
    case 'repair_permissions': return diagnostic.signals.includes('permissions');
    case 'clear_cache': return diagnostic.container.exists && diagnostic.container.running && diagnostic.signals.includes('stale_cache');
    case 'retry_pull': return diagnostic.stage === 'pull' && diagnostic.signals.includes('transient_network');
    case 'start_container': return diagnostic.container.exists && !diagnostic.container.running;
    case 'restart_container': return diagnostic.container.exists && diagnostic.container.running && diagnostic.stage === 'health';
    case 'retry_deployment': return diagnostic.signals.includes('sqlite_locked') || diagnostic.signals.includes('transient_network');
    case 'manual': return true;
    default: return false;
  }
}
