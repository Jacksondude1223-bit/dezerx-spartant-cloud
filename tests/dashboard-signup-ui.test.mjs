import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('deployment form defaults to signup and includes credentials only when selected', async () => {
  const source = await readFile(new URL('../dashboard/public/app.js', import.meta.url), 'utf8');
  const form = source.slice(source.indexOf('function adminForm('), source.indexOf('async function instancePage('));
  const elements = [];
  const requests = [];
  const h = (tag, props = {}, ...children) => {
    const element = {tag, ...props, children, value: props?.value || '', checked: props?.checked || false, events: {}, addEventListener(name, action) {this.events[name] = action;}};
    elements.push(element);
    return element;
  };
  const context = vm.createContext({h, button: label => h('button', {label}), copyButton: () => h('button'), strongPassword: () => 'Strong-password-123!', api: {post: async (path, payload) => {requests.push({path, payload: JSON.parse(JSON.stringify(payload))}); return {status: 'deploying'};}}, toast() {}, fail(error) {throw error;}});
  vm.runInContext(form, context);
  context.adminForm({id: 'test-instance', status: 'ready_to_deploy', hostname: 'customer.example.com', licenseHint: 'SPARTANCLOUD_…test'}, () => {});
  const checkbox = elements.find(element => element.type === 'checkbox');
  const fields = elements.find(element => element.hidden === true);
  const deploy = elements.find(element => element.label === 'Deploy');
  assert.equal(checkbox.checked, false);
  await deploy.events.click();
  assert.deepEqual(requests[0], {path: '/api/instances/test-instance/deploy', payload: {}});
  checkbox.checked = true;
  checkbox.events.change();
  assert.equal(fields.hidden, false);
  elements.find(element => element.placeholder === 'Customer Owner').value = 'Owner';
  elements.find(element => element.type === 'email').value = 'owner@example.com';
  await deploy.events.click();
  assert.deepEqual(requests[1].payload.initialAdmin, {displayName: 'Owner', email: 'owner@example.com', password: 'Strong-password-123!'});
  checkbox.checked = false;
  checkbox.events.change();
  assert.equal(fields.hidden, true);
  await deploy.events.click();
  assert.equal(Object.hasOwn(requests[2].payload, 'initialAdmin'), false);
});
