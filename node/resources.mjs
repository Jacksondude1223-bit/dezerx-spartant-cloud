// Per-tenant container resources.
//
// A tenant runs nginx, two to four Octane workers, the queue worker, the scheduler and
// Redis in one container. One CPU left page requests waiting behind the scheduler and
// queue, so new tenants default to 2.5 CPUs. Operators can override the limit for one
// tenant through the admin API (dashboard) or the signed control API (master website);
// the override is stored in the tenant record so a recreated container keeps it.
export const DEFAULT_TENANT_CPUS = '2.5';
export const MIN_TENANT_CPUS = 0.1;
export const MAX_TENANT_CPUS = 64;

// Returns the canonical string form ("2.5", "1", "0.25") or null when invalid.
export function normalizeCpuLimit(value) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d{1,2}(?:\.\d{1,2})?$/.test(text.trim())) return null;
  const number = Number(text.trim());
  if (!Number.isFinite(number) || number < MIN_TENANT_CPUS || number > MAX_TENANT_CPUS) return null;
  return String(number);
}

export function nodeCpuDefault(cfg) {
  return normalizeCpuLimit(cfg.TENANT_CPUS) || DEFAULT_TENANT_CPUS;
}

// The limit a tenant's container runs with: its own override, else the node's default.
export function tenantCpus(cfg, record) {
  return normalizeCpuLimit(record?.cpuLimit) || nodeCpuDefault(cfg);
}

export function cpuSummary(cfg, record) {
  const override = normalizeCpuLimit(record?.cpuLimit);
  return {cpuLimit: override || nodeCpuDefault(cfg), cpuLimitSource: override ? 'tenant' : 'node', nodeCpuDefault: nodeCpuDefault(cfg)};
}

// Reads a requested limit from an API body. `null` (or "default") clears the override.
// Throws invalid_cpu_limit for anything else that is not a valid limit.
export function requestedCpuLimit(value) {
  if (value === null || value === 'default') return null;
  const limit = normalizeCpuLimit(value);
  if (!limit) throw Object.assign(new Error('invalid_cpu_limit'), {apiStatus: 422});
  return limit;
}
