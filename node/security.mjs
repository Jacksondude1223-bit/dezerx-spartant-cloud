import {sensitivePath} from './sensitive-path.mjs';
export {sensitivePath};
export function createSecurity({now = Date.now, log = value => console.error(JSON.stringify(value)), limit = 120, windowMs = 60000} = {}) {
  let started = now(), allowed = 0, denied = 0;
  const reset = () => { if (now() - started >= windowMs) { started = now(); allowed = 0; denied = 0; } };
  const audit = (event, fields = {}) => {
    const record = {event, timestamp: new Date(now()).toISOString()};
    if (/^t-[a-f0-9]{24}$/.test(fields.id || '')) record.id = fields.id;
    if (['provision', 'lifecycle', 'upgrade', 'node-health', 'instance', 'health', 'version', 'database/download', 'files', 'domain', 'reload'].includes(fields.operation)) record.operation = fields.operation;
    if (['ready', 'provisioning', 'suspended', 'terminated', 'current', 'upgraded', 'rolled_back'].includes(fields.status)) record.status = fields.status;
    log(record);
  };
  return {audit, denied() { reset(); if (++denied <= 5) audit('control_authentication_denied'); if (denied === limit + 1) audit('control_authentication_rate_limited'); return denied <= limit; }, allowed() { reset(); if (++allowed > limit) { if (allowed === limit + 1) audit('control_rate_limited'); return false; } return true; }};
}
