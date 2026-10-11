// Decides the Cache-Control a tenant response leaves the node with.
//
// The tenant's nginx marks Vite's content-hashed bundles (/build/assets/*) immutable and
// Laravel sends its own directive on every page, so the application is the authority on
// what may be cached. Forcing `private, no-store` on everything made browsers and
// Cloudflare re-download every script and stylesheet on every page visit.
//
// Still forced to `private, no-store`:
// - responses that set a cookie, so a session can never be stored by a shared cache;
// - responses that name no policy at all, which keeps the previous safe default;
// - anything other than GET or HEAD.
export const NO_STORE = 'private, no-store';

export function proxyCacheControl(method, headers) {
  if (!['GET', 'HEAD'].includes(String(method || '').toUpperCase())) return NO_STORE;
  if (headers['set-cookie'] !== undefined) return NO_STORE;
  const value = headers['cache-control'];
  const directive = Array.isArray(value) ? value.join(', ') : value;
  if (typeof directive !== 'string' || !directive.trim() || /[\r\n]/.test(directive)) return NO_STORE;
  return directive;
}
