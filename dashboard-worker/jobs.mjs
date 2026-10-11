import {store, ApiError} from './store.mjs';
import {clients} from './nodes.mjs';
import {open, seal} from './crypto.mjs';
import {permit} from './instances.mjs';
export async function runJobs(env, fetchImpl = fetch) {
  const db = store(env), client = clients(env, fetchImpl);
  const token = await db.lock('runner', 180000);
  if (!token) return false;
  let job, item, tenantToken;
  try {
    job = await db.query("SELECT * FROM dashboard_jobs WHERE status IN ('queued', 'running') AND next_at <= ? ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, created_at LIMIT 1", Date.now()).first();
    if (!job) return false;
    tenantToken = await db.lock('tenant:' + job.tenant_id, 180000);
    if (!tenantToken) return false;
    item = await db.find(job.tenant_id);
    if (Date.now() > job.deadline) throw new ApiError(504, 'not_ready_in_time');
    const payload = await open(env.DASHBOARD_DATA_KEY, 'job:' + job.id, job.payload);
    let next = job.stage;
    if (job.kind === 'deploy') {
      if (job.status === 'queued') {
        const rooms = await Promise.all(['us', 'de'].map(region => client.node(region, 'overview')));
        const missing = rooms.find(x => x.node?.resources?.memory?.freeBytes < client.config.memory || x.node?.resources?.disk?.availableBytes < client.config.disk || !x.node?.resources?.memory || !x.node?.resources?.disk);
        if (missing) {item.queue.reason = 'Waiting for both nodes to have enough memory and disk.'; await db.save(item); await db.query('UPDATE dashboard_jobs SET next_at = ? WHERE id = ?', Date.now() + 60000, job.id).run(); return true;}
        job.deadline = Date.now() + 30 * 60000;
        await db.query("UPDATE dashboard_jobs SET status = 'running', deadline = ? WHERE id = ?", job.deadline, job.id).run();
        job.status = 'running';
        item.status = 'deploying'; item.queue = null;
      }
      item.status = 'deploying'; item.queue = null;
      if (next === 'routing') {
        item.steps.routing = 'running'; await db.save(item);
        await client.routing('instances', {id: item.id, serviceId: item.serviceId, customerId: item.customerId, primary: item.primary, status: 'ready', lifecycleVersion: Math.max(1, item.lifecycleVersion || 0)});
        item.steps.routing = 'done'; item.status = 'ready'; item.lifecycleVersion = Math.max(1, item.lifecycleVersion || 0); item.progress = null;
        db.note(item, `Live at https://${item.hostname}.`, 'good');
        if (item.adminCreation === 'signup') db.note(item, 'Open the site to complete Spartan’s first-account signup.', 'good');
        next = 'done';
      } else {
        const region = next === 'primary' ? item.primary : item.secondary;
        const started = new Date().toISOString();
        item.steps[next] = 'running'; item.progress = {role: next, region, attempt: job.attempts + 1, startedAt: started, callStartedAt: started, deadline: new Date(job.deadline).toISOString()};
        db.note(item, `Provisioning node-${region}; attempt ${job.attempts + 1}.`); await db.save(item);
        const domainVerificationToken = await permit(item, env, client, db);
        const result = await client.control(region, 'provision', {id: item.id, primary: item.primary, appKey: item.appKey, url: 'https://' + item.hostname, fingerprint: item.fingerprint, licenseKey: item.licenseKey, lifecycleVersion: item.lifecycleVersion, domainVerificationToken, ...(next === 'primary' && payload.initialAdmin ? {initialAdmin: payload.initialAdmin} : {})});
        if (result.status === 'ready') {
          item.steps[next] = 'done'; item.progress = null; db.note(item, `node-${region} is ready.`, 'good');
          next = next === 'primary' ? 'secondary' : 'routing';
        }
      }
    } else if (job.kind === 'lifecycle') {
      if (next === 'plan') {
        const nodes = await Promise.all(['us', 'de'].map(region => client.node(region, 'overview').then(data => ({region, tenant: data.tenants?.find(x => x.id === item.id)}))));
        const copies = nodes.filter(x => x.tenant).map(x => ({...x.tenant, region: x.region}));
        if (!copies.length) throw new ApiError(404, 'tenant_not_found');
        if (!/^[a-f0-9]{64}$/.test(copies[0].fingerprint || '') || copies.some(x => x.fingerprint !== copies[0].fingerprint)) throw new ApiError(409, 'tenant_conflict');
        let routed = null;
        try {routed = await client.routing('instances/' + item.id, {}, {method: 'GET'});} catch (error) {if (error.status !== 404) throw error;}
        const current = copies.find(x => x.role === 'primary')?.status;
        if (payload.action === 'resume' && current !== 'suspended' && !copies.some(x => x.status === 'suspended') && routed?.status !== 'suspended') throw new ApiError(409, 'not_suspended');
        if (payload.action !== 'terminate' && copies.some(x => x.status === 'terminated')) throw new ApiError(409, 'service_terminated');
        payload.copies = copies.map(x => ({region: x.region, role: x.role})).sort((a, b) => a.role === 'primary' ? -1 : b.role === 'primary' ? 1 : 0);
        payload.fingerprint = copies[0].fingerprint; payload.routed = routed;
        payload.version = Math.max(item.lifecycleVersion || 0, routed?.lifecycleVersion || 0, ...copies.map(x => x.lifecycleVersion || 0)) + 1;
        next = payload.action === 'resume' ? 'node:0' : 'router';
        job.payload = await seal(env.DASHBOARD_DATA_KEY, 'job:' + job.id, payload);
        await db.query('UPDATE dashboard_jobs SET payload = ? WHERE id = ?', job.payload, job.id).run();
      } else if (next === 'router') {
        if (payload.action === 'terminate' && item.custom && payload.routed?.status === 'ready') {
          try {await client.routing(`instances/${item.id}/domains/delete`, {hostname: item.hostname});} catch (error) {if (error.status !== 404) throw error;}
        }
        if (payload.routed) await client.routing('instances', {id: item.id, serviceId: payload.routed.serviceId, customerId: payload.routed.customerId, primary: payload.routed.primary, status: {suspend: 'suspended', terminate: 'terminated', resume: 'ready'}[payload.action], lifecycleVersion: payload.version});
        next = payload.action === 'resume' ? 'done' : 'node:0';
      } else {
        const index = Number(next.split(':')[1]);
        const copy = payload.copies[index];
        if (payload.action === 'resume') {
          const detail = await client.node(copy.region, 'tenant', {id: item.id});
          const result = detail.status === 'ready' ? detail : await client.node(copy.region, 'resume', {id: item.id, lifecycleVersion: payload.version});
          if (result.status !== 'ready') throw new ApiError(503, 'primary_not_ready');
        } else await client.control(copy.region, 'lifecycle', {id: item.id, fingerprint: payload.fingerprint, lifecycleVersion: payload.version, action: payload.action === 'suspend' ? 'suspended' : 'terminated'});
        next = index + 1 < payload.copies.length ? 'node:' + (index + 1) : payload.action === 'resume' ? 'router' : 'done';
      }
      if (next === 'done') {item.status = {suspend: 'suspended', resume: 'ready', terminate: 'terminated'}[payload.action]; item.lifecycleVersion = payload.version; item.operation = null; item.error = null; db.note(item, payload.action + ' completed.', 'good');}
    } else throw new ApiError(422, 'invalid_job');
    await db.save(item);
    await db.query('UPDATE dashboard_jobs SET stage = ?, status = ?, attempts = ?, next_at = ?, payload = ? WHERE id = ?', next, next === 'done' ? 'done' : 'running', next === job.stage ? job.attempts + 1 : 0, Date.now() + 15000, next === 'done' ? await seal(env.DASHBOARD_DATA_KEY, 'job:' + job.id, {}) : job.payload, job.id).run();
    if (next === 'done') await db.audit('action', {action: job.kind + '_completed', id: item.id});
    return true;
  } catch (error) {
    if (job && item) {
      const retry = error.status >= 500 || error.status === 429 || ['node_capacity', 'domain_verification_required'].includes(error.message);
      const terminal = !retry || Date.now() > job.deadline || job.attempts >= 29;
      db.note(item, `Runner: ${error instanceof ApiError ? error.message : 'operation_failed'}. ${terminal ? 'Deployment stopped.' : 'Retry scheduled.'}`, terminal ? 'bad' : 'warn');
      if (terminal) {item.error = error instanceof ApiError ? error.message : 'operation_failed'; item.progress = null; item.operation = null; if (job.kind === 'deploy') {item.status = 'failed'; for (const key of Object.keys(item.steps)) if (item.steps[key] === 'running') item.steps[key] = 'failed';}}
      await db.save(item);
      await db.query('UPDATE dashboard_jobs SET status = ?, attempts = attempts + 1, next_at = ?, payload = ? WHERE id = ?', terminal ? 'failed' : job.status, Date.now() + 60000, terminal ? await seal(env.DASHBOARD_DATA_KEY, 'job:' + job.id, {}) : job.payload, job.id).run();
    } else if (job) await db.query("UPDATE dashboard_jobs SET status = 'failed', payload = ? WHERE id = ?", await seal(env.DASHBOARD_DATA_KEY, 'job:' + job.id, {}), job.id).run();
    return false;
  } finally {
    if (tenantToken && job) await db.unlock('tenant:' + job.tenant_id, tenantToken);
    await db.unlock('runner', token);
  }
}
