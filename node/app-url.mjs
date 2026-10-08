// A tenant's APP_URL is the customer's own domain, because their Spartan licence is
// issued for that domain and the application verifies it against the vendor. The tenant
// subdomain on the shared base domain stays available as a routing hostname, but it is
// not what the application calls itself.
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function appUrl(value, {baseDomain, originHostnames = []} = {}) {
  if (typeof value !== 'string' || value.length > 255) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') return null;
  if (!HOSTNAME.test(url.hostname)) return null;
  // The base domain itself is the control host, and the origins are the node tunnels;
  // pointing a tenant at either would route it back into the control plane.
  if (url.hostname === baseDomain || originHostnames.includes(url.hostname)) return null;
  return `https://${url.hostname}`;
}
