// Moves an existing tenant's app.env from the file cache and file sessions to the Redis
// server that already runs inside every tenant container.
//
// New tenants get CACHE_STORE=redis from provisioning. Tenants provisioned earlier keep
// their app.env until something rewrites it, so the agent applies this once, when an
// upgrade recreates the container (the record remembers it, so an operator who later sets
// the file cache back on purpose is not overridden). SESSION_DRIVER=database, used by the
// US-central database mode to share logins across regions, is left alone.
const RULES = [
  [/^(CACHE_STORE|CACHE_DRIVER)=("?)file\2[ \t]*$/gm, '$1=redis'],
  [/^SESSION_DRIVER=("?)file\1[ \t]*$/gm, 'SESSION_DRIVER=redis']
];

export function migrateCacheEnvironment(text) {
  let next = String(text);
  for (const [pattern, replacement] of RULES) next = next.replace(pattern, replacement);
  return {text: next, changed: next !== text};
}
