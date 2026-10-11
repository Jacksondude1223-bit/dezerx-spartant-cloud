'use strict';
const el = id => document.getElementById(id);
let state = null;
const hex = () => [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, '0')).join('');
const settingErrors = data => (data.invalidSettings || []).map(issue => issue.name + ': ' + issue.reason);
async function refresh() {
  try {
    const response = await fetch('api/setup', {cache: 'no-store'});
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'Setup status unavailable');
    state = data;
    el('status').textContent = data.initialized ? 'Setup is complete. Remove DASHBOARD_SETUP_TOKEN from Cloudflare, then sign in to the dashboard.' : 'Create the first account after saving the required Cloudflare secrets.';
    el('setup-form').hidden = el('secrets').hidden = data.initialized;
    const problems = [...data.missingSettings.map(name => 'Missing: ' + name), ...settingErrors(data)];
    el('missing').replaceChildren(...problems.map(text => {const li = document.createElement('li'); li.textContent = text; return li;}));
    el('submit').disabled = data.initialized || problems.length > 0;
    if (!data.initialized && problems.length) el('status').textContent = 'Correct the settings listed below in Cloudflare, save and deploy the changes, then click Re-check settings.';
    el('generate').disabled = data.initialized || !data.missingSettings.some(x => ['DASHBOARD_DATA_KEY', 'DASHBOARD_SETUP_TOKEN'].includes(x));
    if (data.initialized) {el('result').replaceChildren(); const link = document.createElement('a'); link.href = '/'; link.textContent = 'Open dashboard'; el('result').append(link);}
  } catch (error) {el('status').textContent = 'Setup unavailable: ' + error.message;}
}
el('generate').addEventListener('click', () => {
  if (!state || state.initialized) return;
  if (state.missingSettings.includes('DASHBOARD_DATA_KEY')) el('data-key').value = hex();
  if (state.missingSettings.includes('DASHBOARD_SETUP_TOKEN')) el('token').value = hex();
  el('result').textContent = 'Copy the generated values into Cloudflare, save and deploy the secret changes, then click Re-check settings here.';
});
for (const [button, input] of [['copy-key', 'data-key'], ['copy-token', 'token']]) el(button).addEventListener('click', async () => {
  if (!el(input).value) return;
  try {await navigator.clipboard.writeText(el(input).value); el('result').textContent = 'Copied. Save this value as the matching Cloudflare Worker secret.';}
  catch {el(input).focus(); el(input).select(); el('result').textContent = 'Select and copy this value manually.';}
});
el('refresh').addEventListener('click', refresh);
el('setup-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (el('password').value !== el('confirm').value) {el('result').textContent = 'Passwords do not match.'; return;}
  el('submit').disabled = true;
  try {
    const response = await fetch('api/setup', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({setupToken: el('token').value, username: el('username').value.trim(), password: el('password').value})});
    const data = await response.json();
    if (!response.ok) throw Error(settingErrors(data).join(' ') || ({too_many_attempts: 'Too many setup attempts. Wait 15 minutes before retrying.', invalid_setup_token: 'The setup token does not match the DASHBOARD_SETUP_TOKEN saved in Cloudflare.'}[data.error]) || data.error || 'Setup failed');
    el('password').value = el('confirm').value = el('token').value = el('data-key').value = '';
    el('result').textContent = 'Account created. Remove DASHBOARD_SETUP_TOKEN from Cloudflare, then sign in.';
    await refresh();
  } catch (error) {el('result').textContent = error.message;}
  finally {el('submit').disabled = !state || state.initialized || state.missingSettings.length > 0 || (state.invalidSettings || []).length > 0;}
});
refresh();
