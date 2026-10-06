import {actions, stages, permitted} from '../node/recovery-policy.mjs';
import {json} from './shared.js';

const signalNames = new Set(['permissions', 'stale_cache', 'transient_network', 'sqlite_locked', 'missing_dependency', 'migration_error', 'disk_full', 'out_of_memory']);
export function validDiagnostic(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'container,signals,stage' || !stages.has(value.stage) || !Array.isArray(value.signals) || value.signals.length > 8 || new Set(value.signals).size !== value.signals.length || !value.signals.every(x => signalNames.has(x))) return false;
  const state = value.container;
  return !!state && Object.keys(state).sort().join(',') === 'exists,exitCode,oomKilled,running' && ['exists', 'running', 'oomKilled'].every(key => typeof state[key] === 'boolean') && (state.exitCode === null || Number.isInteger(state.exitCode) && state.exitCode >= 0 && state.exitCode <= 255);
}
export class Recovery {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/choose') return json({error: 'not_found'}, 404);
      if (this.env.AI_RECOVERY_ENABLED !== 'true') return json({error: 'disabled'}, 503);
      const body = await request.text();
      if (body.length > 2048) return json({error: 'too_large'}, 413);
      let diagnostic;
      try { diagnostic = JSON.parse(body); } catch { return json({error: 'invalid_json'}, 400); }
      if (!validDiagnostic(diagnostic)) return json({error: 'invalid_diagnostic'}, 400);
      const allowed = actions.filter(action => permitted(diagnostic, action));
      if (allowed.length === 1) return json({action: 'manual', confidence: 1});
      const now = Date.now();
      const date = new Date(now).toISOString().slice(0, 10);
      const budget = await this.ctx.storage.get('budget') || {};
      const limit = Number(this.env.AI_MAX_CALLS_PER_DAY || 10);
      const count = budget.date === date ? budget.count || 0 : 0;
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) return json({error: 'invalid_budget'}, 503);
      if (count >= limit || now - Number(budget.lastCall || 0) < 60000) return json({error: 'rate_limited'}, 429);
      await this.ctx.storage.put('budget', {date, count: count + 1, lastCall: now});
      try {
        const result = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
          messages: [
            {role: 'system', content: 'Select one permitted repair for a failed first deployment of a Laravel Docker container. Input contains diagnostic categories only. Never invent commands, paths, secrets, code, or additional actions. Choose manual if uncertain. Return only JSON with action and confidence from 0 to 1.'},
            {role: 'user', content: JSON.stringify({diagnostic, allowedActions: allowed})}
          ], temperature: 0, max_tokens: 128, stream: false,
          response_format: {type: 'json_schema', json_schema: {type: 'object', properties: {action: {type: 'string', enum: allowed}, confidence: {type: 'number'}}, required: ['action', 'confidence'], additionalProperties: false}}
        });
        let decision;
        try { decision = typeof result.response === 'string' ? JSON.parse(result.response) : result.response; } catch { return json({action: 'manual', confidence: 1}); }
        if (!decision || Object.keys(decision).sort().join(',') !== 'action,confidence' || !allowed.includes(decision.action) || !Number.isFinite(decision.confidence) || decision.confidence < 0.8 || decision.confidence > 1) return json({action: 'manual', confidence: 1});
        return json(decision);
      } catch { return json({error: 'ai_unavailable'}, 503); }
    });
  }
}
