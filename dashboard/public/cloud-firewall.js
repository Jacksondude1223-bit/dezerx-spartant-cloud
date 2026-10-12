'use strict';
window.spartanFirewallPage = async function ({ctx, id, h, api, button, icon, crumbs, pageHead, badge, modal, confirmDialog, toast, fail, go, reload}) {
  const header = () => [crumbs([{label: 'Spartan Cloud', href: '#/'}, {label: 'Cloud Firewall', href: '#/firewall'}, id ? {label: 'Firewall details'} : null].filter(Boolean)), pageHead({title: 'Cloud Firewall', subtitle: 'Manage Contabo network firewalls for your Spartan nodes.', actions: [button('Refresh', {icon: 'refresh', onClick: reload})]})];
  const config = await api.get('/api/firewall/config');
  if (!ctx.alive()) return;
  if (!config.configured) {
    ctx.fill([...header(), h('div', {class: 'card form-card'}, h('h2', null, 'Connect Contabo'), h('p', null, 'Add these secrets to the dashboard Worker in Cloudflare → Settings → Variables and Secrets. Save and deploy the changes, then refresh this page.'), h('ul', null, config.missingSettings.map(name => h('li', {class: 'mono'}, name))), h('p', {class: 'muted'}, 'Contabo requires your client ID, client secret, API username and separate API-user password. Credentials stay on the Worker.'), h('a', {class: 'btn', href: 'https://my.contabo.com/', target: '_blank', rel: 'noopener noreferrer'}, icon('external'), 'Open Contabo'))]);
    return;
  }
  const data = await api.get('/api/firewall');
  if (!ctx.alive()) return;
  const label = item => item.displayName || item.name || String(item.instanceId);
  const field = (name, control, hint) => h('label', {class: 'field'}, h('span', null, name), control, hint ? h('span', {class: 'hint'}, hint) : null);
  const table = (columns, rows) => h('div', {class: 'card table-card'}, h('div', {class: 'table-scroll'}, h('table', null, h('thead', null, h('tr', null, columns.map(name => h('th', null, name)))), h('tbody', null, rows.length ? rows : h('tr', null, h('td', {colspan: String(columns.length), class: 'faint'}, 'No entries.'))))));
  const status = value => badge({label: value === 'active' ? 'Active' : 'Inactive', tone: value === 'active' ? 'green' : 'amber'});
  let acting = false;
  async function change(path, payload, title, message, after) {
    if (acting) return;
    acting = true;
    try {
      if (!await confirmDialog({title, message, confirm: 'Apply change', danger: true})) return;
      const result = await api.post(path, {...payload, confirmed: true});
      toast('Firewall change submitted to Contabo.');
      if (ctx.alive()) (after || reload)(result);
    } catch (error) {fail(error);} finally {acting = false;}
  }
  function nameForm(title, name, description, save) {
    const nameInput = h('input', {class: 'input', value: name, maxlength: '255', required: true});
    const descInput = h('input', {class: 'input', value: description, maxlength: '255'});
    const error = h('p', {class: 'muted', role: 'status'});
    const form = h('form', {onsubmit: event => {event.preventDefault(); if (!nameInput.value.trim()) {error.textContent = 'Enter a firewall name.'; return;} ref.close(); save(nameInput.value.trim(), descInput.value);}}, field('Name', nameInput), field('Description', descInput), error, h('div', {class: 'actions'}, button('Cancel', {onClick: () => ref.close()}), h('button', {type: 'submit', class: 'btn primary'}, 'Continue')));
    const ref = modal({title, body: h('div', {class: 'body'}, form)});
    nameInput.focus();
  }
  if (!id) {
    const rows = data.firewalls.map(firewall => h('tr', null,
      h('td', null, h('a', {href: '#/firewall/' + firewall.firewallId, class: 'primary-text'}, firewall.name), h('div', {class: 'sub mono'}, firewall.firewallId)),
      h('td', null, status(firewall.status)), h('td', null, String(firewall.rules.inbound.length)),
      h('td', null, firewall.instances.map(label).join(', ') || 'Unassigned'),
      h('td', null, h('a', {class: 'btn small', href: '#/firewall/' + firewall.firewallId}, 'Manage'))));
    ctx.fill([crumbs([{label: 'Spartan Cloud', href: '#/'}, {label: 'Cloud Firewall'}]), pageHead({title: 'Cloud Firewall', subtitle: 'Contabo network protection for your nodes', actions: [button('Refresh', {icon: 'refresh', onClick: reload}), button('Create firewall', {kind: 'primary', icon: 'plus', onClick: () => nameForm('Create firewall', '', '', (name, description) => change('/api/firewall/create', {name, description}, 'Create an inactive firewall?', 'The firewall will be created without assigning any servers. Add your rules before activating it.', result => go('#/firewall/' + result.firewallId)))} )]}), table(['Firewall', 'Status', 'Inbound rules', 'Assigned servers', ''], rows)]);
    return;
  }
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw Error('not_found');
  const firewall = await api.get('/api/firewall/' + id);
  if (!ctx.alive()) return;
  const endpoint = '/api/firewall/' + id;
  const original = JSON.stringify(firewall.rules.inbound);
  let draft = structuredClone(firewall.rules.inbound);
  const rulesPanel = h('div'), saved = h('span', {class: 'muted', role: 'status'});
  const save = button('Save rule changes', {kind: 'primary', disabled: true, onClick: () => change(endpoint + '/rules', {version: firewall.version, rules: draft}, 'Apply inbound rules?', [`This replaces the inbound rules for ${firewall.name} on ${firewall.instances.length} assigned server(s).`, 'Traffic not accepted by an active rule is dropped while the firewall is active. Keep SSH access and the peer UDP 51820 WireGuard rule needed by the Germany database connection.'])});
  const discard = button('Discard draft', {disabled: true, onClick: () => {draft = structuredClone(firewall.rules.inbound); drawRules();}});
  const sourceText = rule => [...(rule.srcCidr?.ipv4 || []), ...(rule.srcCidr?.ipv6 || [])].join(', ') || 'Unspecified';
  const portsText = rule => !rule.protocol || rule.protocol === 'icmp' ? '—' : rule.destPorts.join(', ') || 'Any port';
  function editRule(index) {
    const value = index === undefined ? {displayName: '', protocol: 'tcp', destPorts: [], srcCidr: {ipv4: [], ipv6: []}, action: 'accept', status: 'active'} : draft[index];
    const name = h('input', {class: 'input', value: value.displayName, maxlength: '255'});
    const protocol = h('select', {class: 'input'}, [['tcp', 'TCP'], ['udp', 'UDP'], ['icmp', 'ICMP'], ['', 'All protocols']].map(([key, text]) => h('option', {value: key}, text))); protocol.value = value.protocol;
    const ports = h('input', {class: 'input mono', value: value.destPorts.join(', '), placeholder: '22, 443, 8000-8100'});
    const ipv4 = h('input', {class: 'input mono', value: (value.srcCidr.ipv4 || []).join(', '), placeholder: '203.0.113.10/32 or AnyIPv4'});
    const ipv6 = h('input', {class: 'input mono', value: (value.srcCidr.ipv6 || []).join(', '), placeholder: '2001:db8::/64 or AnyIPv6'});
    const active = h('input', {type: 'checkbox'}); active.checked = value.status === 'active';
    const message = h('p', {class: 'muted', role: 'status'});
    const split = input => input.value.split(',').map(x => x.trim()).filter(Boolean);
    const updatePorts = () => {ports.disabled = protocol.value === 'icmp' || protocol.value === ''; if (ports.disabled) ports.value = '';};
    protocol.addEventListener('change', updatePorts); updatePorts();
    const form = h('form', {onsubmit: event => {
      event.preventDefault();
      const next = {displayName: name.value.trim(), protocol: protocol.value, destPorts: ports.disabled ? [] : split(ports), srcCidr: {ipv4: split(ipv4), ipv6: split(ipv6)}, action: 'accept', status: active.checked ? 'active' : 'inactive'};
      if (!next.srcCidr.ipv4.length && !next.srcCidr.ipv6.length) {message.textContent = 'Specify a source address, CIDR, AnyIPv4 or AnyIPv6.'; return;}
      if (index === undefined) draft.push(next); else draft[index] = next;
      ref.close(); drawRules();
    }}, field('Rule name', name), field('Protocol', protocol), field('Destination ports', ports, 'Leave empty to accept all ports for the selected protocol.'), field('IPv4 sources', ipv4, 'Comma-separated IP addresses or CIDRs. AnyIPv4 allows every IPv4 source.'), field('IPv6 sources', ipv6, 'AnyIPv6 allows every IPv6 source.'), h('label', {class: 'field'}, h('span', null, active, ' Enable this accept rule')), message, h('div', {class: 'actions'}, button('Cancel', {onClick: () => ref.close()}), h('button', {type: 'submit', class: 'btn primary'}, 'Add to draft')));
    const ref = modal({title: index === undefined ? 'Add inbound accept rule' : 'Edit inbound rule', body: h('div', {class: 'body'}, form)}); name.focus();
  }
  function drawRules() {
    const dirty = JSON.stringify(draft) !== original;
    save.disabled = discard.disabled = !dirty;
    saved.textContent = dirty ? 'Unsaved draft — not applied to Contabo.' : 'Rules loaded from Contabo.';
    const rows = draft.map((rule, index) => h('tr', null, h('td', null, rule.displayName || 'Accept rule'), h('td', null, rule.protocol.toUpperCase() || 'ALL'), h('td', {class: 'mono'}, portsText(rule)), h('td', {class: 'mono'}, sourceText(rule)), h('td', null, status(rule.status)), h('td', null, h('div', {class: 'actions'}, button('Edit', {small: true, icon: 'edit', onClick: () => editRule(index)}), button('Remove', {small: true, icon: 'trash', onClick: () => {draft.splice(index, 1); drawRules();}})))));
    rows.push(h('tr', null, h('td', {colspan: '6', class: 'muted'}, 'Permanent default: DROP inbound traffic that does not match an active accept rule. Outbound traffic is unrestricted.')));
    rulesPanel.replaceChildren(table(['Rule', 'Protocol', 'Ports', 'Sources', 'Status', ''], rows));
  }
  drawRules();
  const active = firewall.status === 'active';
  const assignmentStatus = item => {
    const value = firewall.instanceStatus.find(x => x.instanceId === item.instanceId)?.status || 'Assigned';
    if (value.toLowerCase() !== 'processing') return value;
    const namespace = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(namespace, 'svg');
    svg.setAttribute('viewBox', '25 25 50 50');
    svg.setAttribute('aria-hidden', 'true');
    const circle = document.createElementNS(namespace, 'circle');
    circle.setAttribute('r', '20');
    circle.setAttribute('cy', '50');
    circle.setAttribute('cx', '50');
    svg.append(circle);
    return h('span', {class: 'firewall-assignment-loader', role: 'status', 'aria-label': 'Processing', title: 'Processing'}, svg);
  };
  const update = changes => ({version: firewall.version, name: firewall.name, description: firewall.description, status: firewall.status, ...changes});
  const assigned = new Set(firewall.instances.map(x => x.instanceId));
  const available = data.instances.filter(x => !assigned.has(x.instanceId));
  const selected = h('select', {class: 'input'}, h('option', {value: ''}, 'Select a Contabo server'), available.map(item => h('option', {value: String(item.instanceId)}, `${label(item)} · ${item.ipv4 || item.ipv6 || item.instanceId}`)));
  const attach = button('Assign server', {onClick: () => {
    if (!selected.value) {toast('Select a server first.', {error: true}); return;}
    const item = available.find(x => String(x.instanceId) === selected.value);
    change(endpoint + '/attach', {version: firewall.version, instanceId: item.instanceId}, 'Assign this server?', [`Assign ${label(item)} to ${firewall.name}.`, active ? 'This firewall is active. Its inbound rules take effect immediately on the server. Review SSH and WireGuard access first.' : 'This firewall is inactive. Its rules start filtering when you activate it.']);
  }});
  const assignedRows = firewall.instances.map(item => h('tr', null, h('td', null, label(item), h('div', {class: 'sub mono'}, String(item.instanceId))), h('td', {class: 'mono'}, [item.ipv4, item.ipv6].filter(Boolean).join(' · ')), h('td', null, assignmentStatus(item)), h('td', null, button('Detach', {small: true, onClick: () => change(endpoint + '/detach', {version: firewall.version, instanceId: item.instanceId}, 'Detach this server?', `Remove ${label(item)} from this firewall. These network rules will stop protecting it.`)}))));
  ctx.fill([crumbs([{label: 'Spartan Cloud', href: '#/'}, {label: 'Cloud Firewall', href: '#/firewall'}, {label: firewall.name}]), pageHead({title: firewall.name, pill: {label: active ? 'Active' : 'Inactive', tone: active ? 'green' : 'amber'}, subtitle: firewall.description || firewall.firewallId, actions: [button('Refresh', {icon: 'refresh', onClick: async () => {if (JSON.stringify(draft) === original || await confirmDialog({title: 'Discard unsaved rules?', message: 'Reloading replaces your draft with the current Contabo rules.', confirm: 'Reload'})) reload();}}), button('Rename', {icon: 'edit', onClick: () => nameForm('Rename firewall', firewall.name, firewall.description, (name, description) => change(endpoint + '/update', update({name, description}), 'Update firewall name?', 'Save the firewall name and description.'))}), button(active ? 'Deactivate' : 'Activate', {kind: active ? '' : 'primary', onClick: () => change(endpoint + '/update', update({status: active ? 'inactive' : 'active'}), active ? 'Deactivate firewall?' : 'Activate firewall?', active ? 'Inbound filtering will stop on all assigned servers.' : [`Inbound filtering takes effect on ${firewall.instances.length} assigned server(s). Unmatched inbound traffic is dropped.`, 'Check the saved SSH and UDP 51820 WireGuard rules before activating. Unsaved draft rules will not be applied.'])}), button('Delete', {kind: 'danger', icon: 'trash', disabled: firewall.instances.length > 0, title: firewall.instances.length ? 'Detach every server first.' : '', onClick: () => change(endpoint + '/delete', {version: firewall.version}, 'Delete firewall?', `Permanently delete ${firewall.name} and its saved rules.`, () => go('#/firewall'))})]}), h('div', {class: 'section'}, h('div', {class: 'section-head'}, h('h2', null, 'Inbound rules'), button('Add rule', {icon: 'plus', onClick: () => editRule()})), rulesPanel, h('div', {class: 'toolbar'}, saved, save, discard)), h('div', {class: 'section'}, h('div', {class: 'section-head'}, h('h2', null, 'Assigned servers')), table(['Server', 'Addresses', 'Assignment status', ''], assignedRows), h('div', {class: 'toolbar'}, selected, attach))]);
};
