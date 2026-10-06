import test from 'node:test';
import assert from 'node:assert/strict';
import provisioning from '../workers/provisioning.js';
import {Recovery} from '../workers/recovery.js';
import {diagnose, chooseRepair} from '../node/recovery.mjs';
import {signature, verify} from '../workers/shared.js';

const secret = 's'.repeat(64);
const diagnostic = diagnose('pull', {message: 'TLS handshake timeout'});
const request = value => new Request('https://recovery/choose', {method: 'POST', body: JSON.stringify(value)});
function fixture(run, limit = '10') {
  const values = new Map();
  let tail = Promise.resolve();
  const ctx = {storage: {get: async key => values.get(key), put: async (key, value) => { values.set(key, value); }}, blockConcurrencyWhile(fn) { const result = tail.then(fn); tail = result.catch(() => {}); return result; }};
  const worker = new Recovery(ctx, {AI_RECOVERY_ENABLED: 'true', AI_MAX_CALLS_PER_DAY: limit, AI: {run}});
  return {worker, values};
}
test('Llama receives bounded categorized input and an allowlisted JSON schema', async () => {
  const {worker} = fixture(async (model, input) => {
    assert.equal(model, '@cf/meta/llama-3.1-8b-instruct');
    assert.equal(input.max_tokens, 128);
    assert.equal(input.stream, false);
    const payload = JSON.parse(input.messages[1].content);
    assert.deepEqual(payload.diagnostic, diagnostic);
    assert.ok(payload.allowedActions.includes('retry_pull'));
    assert.equal(input.response_format.json_schema.additionalProperties, false);
    return {response: {action: 'retry_pull', confidence: 0.99}};
  });
  assert.deepEqual(await (await worker.fetch(request(diagnostic))).json(), {action: 'retry_pull', confidence: 0.99});
});
test('raw logs and injected fields are rejected before model use', async () => {
  const {worker} = fixture(async () => assert.fail('must_not_call'));
  for (const input of [{...diagnostic, logs: 'private'}, {...diagnostic, signals: ['rm -rf /']}, {...diagnostic, container: {...diagnostic.container, hostname: 'private'}}]) assert.equal((await worker.fetch(request(input))).status, 400);
});
test('global limiter serializes nodes and persists daily quota across restarts', async () => {
  let calls = 0;
  const {worker, values} = fixture(async () => { calls++; return {response: JSON.stringify({action: 'retry_pull', confidence: 0.99})}; }, '1');
  const results = await Promise.all([worker.fetch(request(diagnostic)), worker.fetch(request(diagnostic))]);
  assert.deepEqual(results.map(x => x.status), [200, 429]);
  values.get('budget').lastCall = Date.now() - 61000;
  const restarted = new Recovery(worker.ctx, worker.env);
  assert.equal((await restarted.fetch(request(diagnostic))).status, 429);
  assert.equal(calls, 1);
});
test('invalid answers fail closed and failed inference still consumes budget', async () => {
  for (const answer of [{response: {action: 'execute', confidence: 1}}, {response: {action: 'retry_pull', confidence: 0.5}}, {response: {action: 'retry_pull', confidence: 1, command: 'touch /x'}}]) {
    const {worker} = fixture(async () => answer);
    assert.equal((await (await worker.fetch(request(diagnostic))).json()).action, 'manual');
  }
  const {worker, values} = fixture(async () => { throw new Error('quota_exceeded'); });
  assert.equal((await worker.fetch(request(diagnostic))).status, 503);
  assert.equal(values.get('budget').count, 1);
});
test('AI endpoint uses its own secret and refuses unsigned and billing-signed requests', async () => {
  let calls = 0;
  const body = JSON.stringify(diagnostic);
  const env = {AI_RECOVERY_SECRET: secret, BILLING_WEBHOOK_SECRET: 'billing', RECOVERY: {getByName(name) { assert.equal(name, 'global-budget'); return {fetch: async () => { calls++; return Response.json({action: 'manual', confidence: 1}); }}; }}};
  for (const key of ['', 'billing', secret]) {
    const timestamp = String(Date.now());
    const headers = key ? {'x-spartan-timestamp': timestamp, 'x-spartan-signature': await signature(key, timestamp, 'POST', '/v1/recovery', body)} : {};
    const response = await provisioning.fetch(new Request('https://worker/v1/recovery', {method: 'POST', headers, body}), env);
    assert.equal(response.status, key === secret ? 200 : 401);
  }
  assert.equal(calls, 1);
});
test('node signature interoperates with Worker verification', async () => {
  const config = {AI_RECOVERY_ENABLED: 'true', AI_RECOVERY_SECRET: secret, AI_RECOVERY_URL: 'https://worker/v1/recovery'};
  const decision = await chooseRepair(config, diagnostic, async (url, init) => {
    const req = new Request(url, init);
    assert.equal(await verify(req, init.body, secret), true);
    return Response.json({action: 'retry_pull', confidence: 0.99});
  });
  assert.equal(decision.action, 'retry_pull');
});
