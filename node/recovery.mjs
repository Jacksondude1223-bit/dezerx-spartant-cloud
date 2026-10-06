import {readFile, writeFile, rename, mkdir} from 'node:fs/promises';
import path from 'node:path';

const actions = ['repair_permissions', 'clear_cache', 'retry_pull', 'start_container', 'restart_container', 'retry_deployment', 'manual'];
const stages = new Set(['prepare', 'pull', 'launch', 'start', 'health', 'replica']);
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
export async function chooseRepair(config, diagnostic, transport = fetch) {
  if (config.GEMINI_RECOVERY_ENABLED !== 'true' || config.GEMINI_FREE_TIER_CONFIRMED !== 'true' || !config.GEMINI_API_KEY || config.GEMINI_API_KEY.includes('CHANGE_ME')) return {action: 'manual', status: 'disabled'};
  const allowed = actions.filter(action => permitted(diagnostic, action));
  const response = await transport('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent', {
    method: 'POST', signal: AbortSignal.timeout(20000), headers: {'content-type': 'application/json', 'x-goog-api-key': config.GEMINI_API_KEY},
    body: JSON.stringify({systemInstruction: {parts: [{text: 'Select one permitted repair for a failed first deployment of a Laravel Docker container. Input contains diagnostic categories only. Never invent commands, paths, secrets, code, or additional actions. Choose manual if uncertain. Do not choose a repair outside allowedActions.'}]}, contents: [{role: 'user', parts: [{text: JSON.stringify({diagnostic, allowedActions: allowed})}]}], generationConfig: {temperature: 0, maxOutputTokens: 128, responseMimeType: 'application/json', responseSchema: {type: 'OBJECT', properties: {action: {type: 'STRING', enum: allowed}, confidence: {type: 'NUMBER'}}, required: ['action', 'confidence']}}})
  });
  if (response.status === 429) return {action: 'manual', status: 'rate_limited'};
  if (!response.ok) return {action: 'manual', status: 'api_unavailable'};
  const data = await response.json();
  const candidate = data.candidates?.[0];
  if (candidate?.finishReason !== 'STOP') return {action: 'manual', status: 'invalid_response'};
  const content = candidate.content?.parts?.filter(part => !part.thought).map(part => part.text || '').join('') || '';
  let decision;
  try { decision = JSON.parse(content); } catch { return {action: 'manual', status: 'invalid_response'}; }
  if (!decision || Object.keys(decision).sort().join(',') !== 'action,confidence' || !actions.includes(decision.action) || !Number.isFinite(decision.confidence) || decision.confidence < 0.8 || decision.confidence > 1 || !permitted(diagnostic, decision.action)) return {action: 'manual', status: 'rejected'};
  return {action: decision.action, status: 'selected'};
}
export function createRecovery({config, root, docker, run, transport = fetch, now = Date.now}) {
  let tail = Promise.resolve();
  const read = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; } };
  const save = async (file, value) => { await mkdir(path.dirname(file), {recursive: true, mode: 0o700}); await writeFile(`${file}.tmp`, JSON.stringify(value), {mode: 0o600}); await rename(`${file}.tmp`, file); };
  const serialize = fn => { const result = tail.then(fn); tail = result.catch(() => {}); return result; };
  return {
    async success(id) {
      if (!/^t-[a-f0-9]{24}$/.test(id)) return;
      await serialize(async () => {
        const file = path.join(root, id, 'recovery.json');
        const state = await read(file);
        if (state.attempts) await save(file, {...state, attempts: 0, outcome: 'deployment_ready'});
      });
    },
    async recover(id, stage, error) {
      if (!/^t-[a-f0-9]{24}$/.test(id)) return false;
      if (config.GEMINI_RECOVERY_ENABLED !== 'true' || config.GEMINI_FREE_TIER_CONFIRMED !== 'true' || !config.GEMINI_API_KEY || config.GEMINI_API_KEY.includes('CHANGE_ME')) return false;
      return serialize(async () => {
        const directory = path.join(root, id);
        const tenant = await read(path.join(directory, 'state.json'));
        if (tenant.status === 'ready' || !tenant.id || !stages.has(stage) || stage === 'replica') return false;
        const file = path.join(directory, 'recovery.json');
        const history = await read(file);
        if ((history.attempts || 0) >= 2) return false;
        const budgetFile = path.join(root, 'gemini-budget.json');
        const budget = await read(budgetFile);
        const date = new Date(now()).toISOString().slice(0, 10);
        const count = budget.date === date ? budget.count || 0 : 0;
        const limit = Math.min(20, Math.max(1, Number(config.GEMINI_MAX_CALLS_PER_DAY || 10)));
        if (!Number.isFinite(limit) || count >= limit || Number(budget.blockedUntil || 0) > now() || now() - Number(budget.lastCall || 0) < 60000) return false;
        let state = {exists: false};
        let logs = '';
        const name = `spartan-${id}`;
        try {
          const inspect = JSON.parse(await docker(['inspect', name]))[0];
          if (inspect.Config?.Labels?.['spartan.fingerprint'] !== tenant.fingerprint) return false;
          state = {exists: true, running: inspect.State.Running, oomKilled: inspect.State.OOMKilled, exitCode: inspect.State.ExitCode};
          logs = await docker(['logs', '--tail', '80', name]);
        } catch {}
        const diagnostic = diagnose(stage, error, logs, state);
        await save(budgetFile, {date, count: count + 1, lastCall: now()});
        const event = {at: new Date(now()).toISOString(), stage: diagnostic.stage, signals: diagnostic.signals, outcome: 'pending'};
        history.attempts = (history.attempts || 0) + 1;
        history.events = [...(history.events || []).slice(-9), event];
        await save(file, history);
        let choice;
        try { choice = await chooseRepair(config, diagnostic, transport); }
        catch { choice = {action: 'manual', status: 'api_unavailable'}; }
        event.action = choice.action;
        event.outcome = choice.status;
        if (choice.status === 'rate_limited') await save(budgetFile, {date, count: count + 1, lastCall: now(), blockedUntil: now() + 3600000});
        if (choice.action === 'manual') { await save(file, history); return false; }
        try {
          if (choice.action === 'repair_permissions') {
            for (const leaf of ['storage', 'database']) {
              await run('chown', ['-R', '33:33', path.join(directory, leaf)]);
              await run('chmod', ['-R', 'u+rwX', path.join(directory, leaf)]);
            }
            if (state.exists && state.running) await docker(['exec', '--user', '0', name, 'chown', '-R', 'www-data:www-data', '/var/www/html/storage', '/var/www/html/database/persistent', '/var/www/html/bootstrap/cache']);
          }
          if (choice.action === 'clear_cache') {
            for (const command of ['config:clear', 'view:clear', 'route:clear']) await docker(['exec', '--user', 'www-data', name, 'php', 'artisan', command]);
          }
          if (choice.action === 'retry_pull') await docker(['pull', config.SPARTAN_IMAGE]);
          if (choice.action === 'start_container') await docker(['start', name]);
          if (state.exists && ['repair_permissions', 'clear_cache', 'restart_container'].includes(choice.action)) await docker(['restart', name]);
          event.outcome = 'applied';
          await save(file, history);
          return true;
        } catch {
          event.outcome = 'repair_failed';
          await save(file, history);
          return false;
        }
      });
    }
  };
}
