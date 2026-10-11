// Chooses between the file cache and the Redis server inside the tenant container.
//
// Only images built with runtime/entrypoint.sh that starts Redis before migrations can use
// Redis for the cache: an older image starts Redis under supervisord *after* migrate,
// seeders and optimize:clear, so a Redis cache makes those fail with "Connection refused"
// and the container never becomes ready. Such images carry no REDIS_CACHE_LABEL, and the
// node keeps their tenants on the file cache and file sessions.
export const REDIS_CACHE_LABEL = 'cloud.spartan.redis-cache';

// Reads the image's label; any failure (missing image, old Docker) means "no".
export async function imageSupportsRedis(docker, image) {
  const read = async () => (await docker(['image', 'inspect', '--format', `{{ index .Config.Labels "${REDIS_CACHE_LABEL}" }}`, image])).trim();
  try { return await read() === '1'; }
  catch {
    try { await docker(['pull', image]); return await read() === '1'; }
    catch { return false; }
  }
}

// Environment entries for a fresh app.env. Database sessions (the US-central mode) stay.
export function cacheEnvironment({redis, databaseSessions}) {
  const driver = redis ? 'redis' : 'file';
  return {SESSION_DRIVER: databaseSessions ? 'database' : driver, CACHE_STORE: driver, CACHE_DRIVER: driver};
}

// Rewrites an existing app.env to the given driver. Only the exact values `file` and
// `redis` are switched; database sessions and anything an operator set otherwise stay.
export function switchCacheEnvironment(text, redis) {
  const [from, to] = redis ? ['file', 'redis'] : ['redis', 'file'];
  let next = String(text);
  next = next.replace(new RegExp(`^(CACHE_STORE|CACHE_DRIVER)=("?)${from}\\2[ \\t]*$`, 'gm'), `$1=${to}`);
  next = next.replace(new RegExp(`^SESSION_DRIVER=("?)${from}\\1[ \\t]*$`, 'gm'), `SESSION_DRIVER=${to}`);
  return {text: next, changed: next !== text};
}

// Kept for callers of the first release of this module.
export const migrateCacheEnvironment = text => switchCacheEnvironment(text, true);
