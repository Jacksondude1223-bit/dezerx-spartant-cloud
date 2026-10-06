import {readFile, writeFile, rename, mkdir} from 'node:fs/promises';
import path from 'node:path';

import {createHmac} from 'node:crypto';
import {actions, stages, diagnose, permitted} from './recovery-policy.mjs';
export {diagnose, permitted} from './recovery-policy.mjs';

export async function chooseRepair(config, diagnostic, transport = fetch) {
  if (config.AI_RECOVERY_ENABLED !== 'true' || !config.AI_RECOVERY_URL || !config.AI_RECOVERY_SECRET || config.AI_RECOVERY_SECRET.includes('CHANGE_ME')) return {action: 'manual', status: 'disabled'};
  let endpoint;
  try { endpoint = new URL(config.AI_RECOVERY_URL); } catch { return {action: 'manual', status: 'disabled'}; }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.pathname !== '/v1/recovery' || endpoint.search || endpoint.hash) return {action: 'manual', status: 'disabled'};
  const body = JSON.stringify(diagnostic);
  const timestamp = String(Date.now());
  const signature = createHmac('sha256', config.AI_RECOVERY_SECRET).update(`${timestamp}\nPOST\n/v1/recovery\n${body}`).digest('hex');
  const response = await transport(endpoint.href, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000), headers: {'content-type': 'application/json', 'x-spartan-timestamp': timestamp, 'x-spartan-signature': signature}, body
  });
  if (response.status === 429) return {action: 'manual', status: 'rate_limited'};
  if (!response.ok) return {action: 'manual', status: 'api_unavailable'};
  let decision;
  try { decision = await response.json(); } catch { return {action: 'manual', status: 'invalid_response'}; }
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
      if (config.AI_RECOVERY_ENABLED !== 'true' || !config.AI_RECOVERY_URL || !config.AI_RECOVERY_SECRET || config.AI_RECOVERY_SECRET.includes('CHANGE_ME')) return false;
      return serialize(async () => {
        const directory = path.join(root, id);
        const tenant = await read(path.join(directory, 'state.json'));
        if (tenant.status === 'ready' || !tenant.id || !stages.has(stage) || stage === 'replica') return false;
        const file = path.join(directory, 'recovery.json');
        const history = await read(file);
        if ((history.attempts || 0) >= 2) return false;
        const budgetFile = path.join(root, 'llama-budget.json');
        const budget = await read(budgetFile);
        const date = new Date(now()).toISOString().slice(0, 10);
        const count = budget.date === date ? budget.count || 0 : 0;
        const limit = Math.min(20, Math.max(1, Number(config.AI_MAX_CALLS_PER_DAY || 10)));
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
