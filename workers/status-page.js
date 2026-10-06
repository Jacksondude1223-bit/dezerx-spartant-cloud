import {region, visitorIp, json} from './shared.js';
const escape = value => String(value).replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));

export async function routingStatus(request, env) {
  const country = request.cf?.country || 'Unknown';
  const selected = region(country);
  const node = selected === 'us' ? 'United States' : 'Germany';
  const origin = selected === 'us' ? env.US_ORIGIN : env.DE_ORIGIN;
  let connection = 'Not configured';
  try {
    const url = new URL(origin);
    if (url.protocol === 'https:' && !url.hostname.endsWith('.example.com') && url.hostname !== 'example.com' && env.ORIGIN_SECRET) {
      url.pathname = '/__cloud_node_health';
      url.search = '';
      url.hash = '';
      connection = 'Not connected';
      const response = await fetch(url, {headers: {'x-spartan-origin': env.ORIGIN_SECRET}, redirect: 'manual', signal: AbortSignal.timeout(2500)});
      if (response.ok) {
        const health = await response.json();
        if (health.status === 'ready' && health.region === selected) connection = 'Connected';
      }
    }
  } catch {}
  return {hostname: new URL(request.url).hostname, ip: visitorIp(request.headers) || 'Unavailable', country, edge: request.cf?.colo || 'Unavailable', node, connection, connectedTo: connection === 'Connected' ? `${node} node` : 'Cloudflare edge', checkedAt: new Date().toISOString()};
}

export async function statusPage(request, env, asJson = false, status = 200) {
  const data = await routingStatus(request, env);
  if (asJson) return json(data);
  const row = (label, value, id) => `<div class="row"><span>${label}</span><strong id="${id}">${escape(value)}</strong></div>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spartan Cloud · Routing status</title><style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b1018;color:#edf2f7}*{box-sizing:border-box}body{margin:0;min-height:100vh;padding:48px 24px;display:grid;place-items:center}.page{width:100%;max-width:820px}header{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:30px}.brand{font-size:17px;font-weight:700;letter-spacing:.02em}.brand span{color:#9ba8bb;font-weight:400}.badge{display:flex;align-items:center;gap:8px;font-size:12px;color:#b9e6d0}.dot{height:7px;width:7px;border-radius:50%;background:#6bcea0}.hero{border:1px solid #293345;border-radius:18px;background:#121a27;padding:36px}.emoji{font-size:64px;line-height:1;margin-bottom:23px}h1{font-size:clamp(25px,4vw,36px);line-height:1.2;letter-spacing:-.035em;margin:0 0 16px}p{color:#b2bfd1;line-height:1.7;font-size:15px;margin:0;max-width:640px}.ip{display:inline-flex;flex-direction:column;gap:8px;border:1px solid #354158;background:#0d1521;border-radius:12px;padding:16px 20px;margin-top:26px;max-width:100%}.ip span{font-size:11px;text-transform:uppercase;letter-spacing:.11em;color:#9aaabe}.ip strong{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:20px;overflow-wrap:anywhere}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px}.card{border:1px solid #293345;border-radius:14px;padding:24px;background:#101722}h2{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:#9aaabe;margin:0 0 18px}.row{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-top:1px solid #242e3e;font-size:13px}.row span{color:#9ba8bb}.row strong{text-align:right;font-weight:500;overflow-wrap:anywhere;max-width:65%}.foot{display:flex;justify-content:space-between;align-items:center;gap:18px;font-size:12px;color:#8291a6;padding:22px 2px}button{font:inherit;color:#d6deea;background:#172231;border:1px solid #354158;border-radius:8px;padding:8px 13px;cursor:pointer}button:disabled{opacity:.5}button:focus-visible{outline:2px solid #b7d8fa;outline-offset:3px}@media(max-width:620px){body{padding:28px 16px}.hero{padding:26px}.grid{grid-template-columns:1fr}header{align-items:flex-start}.badge{white-space:nowrap}.foot{align-items:flex-start}}
</style></head><body><main class="page"><header><div class="brand">SPARTAN <span>/ Cloud</span></div><div class="badge"><span class="dot"></span>Routing Worker online</div></header><section class="hero"><div class="emoji" aria-label="laughing face">🤣</div><h1>Ha ha. You thought!</h1><p>You thought you were gonna get a free server by manipulating the load balancer? Jokes on you. 😏</p><div class="ip"><span>Your IP address</span><strong id="ip">${escape(data.ip)}</strong></div></section><div class="grid"><section class="card"><h2>Connection</h2>${row('Connected to', data.connectedTo, 'connectedTo')}${row('Selected node', data.node, 'node')}${row('Node connection', data.connection, 'connection')}</section><section class="card"><h2>Current request</h2>${row('Hostname served', data.hostname, 'hostname')}${row('Cloudflare location', data.edge, 'edge')}${row('Detected country', data.country, 'country')}</section></div><div class="foot"><span id="checkedAt">Checked ${escape(data.checkedAt)}</span><button type="button" id="refresh">Refresh status</button></div></main><script>
document.getElementById('refresh').addEventListener('click',async function(){this.disabled=true;try{const response=await fetch('/__routing_status',{cache:'no-store'});if(!response.ok)throw new Error();const data=await response.json();for(const key of ['ip','connectedTo','node','connection','hostname','edge','country'])document.getElementById(key).textContent=data[key];document.getElementById('checkedAt').textContent='Checked '+data.checkedAt}catch{document.getElementById('checkedAt').textContent='Status refresh unavailable'}finally{this.disabled=false}});
</script></body></html>`;
  return new Response(request.method === 'HEAD' ? null : html, {status, headers: {'x-spartan-page': 'routing-status-v1', 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"}});
}
