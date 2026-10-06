import {mkdir} from 'node:fs/promises';
import path from 'node:path';

export async function applyLifecycle(input, {root, load, save, docker}) {
  const {id, fingerprint, lifecycleVersion, action} = input;
  if (!/^t-[a-f0-9]{24}$/.test(id || '') || !/^[a-f0-9]{64}$/.test(fingerprint || '') || !Number.isSafeInteger(lifecycleVersion) || lifecycleVersion < 1 || !['suspended', 'terminated'].includes(action)) throw new Error('invalid_lifecycle');
  const existing = await load(id);
  if (existing && existing.fingerprint !== fingerprint) throw new Error('tenant_conflict');
  if (existing?.status === 'terminated' && action !== 'terminated') throw new Error('service_terminated');
  if (lifecycleVersion < (existing?.lifecycleVersion || 0) || lifecycleVersion === existing?.lifecycleVersion && existing.lifecycleAction && existing.lifecycleAction !== action) throw new Error('stale_operation');
  const name = `spartan-${id}`;
  let inspect;
  try {
    const result = JSON.parse(await docker(['inspect', name]));
    if (!Array.isArray(result) || result.length !== 1 || !result[0]?.Config || !result[0]?.State) throw new Error('invalid_container_state');
    inspect = result[0];
  }
  catch (error) {
    if (!/No such (?:object|container)/i.test(String(error.stderr || error.message))) throw error;
  }
  if (inspect && (inspect.Config?.Labels?.['spartan.fingerprint'] !== fingerprint || inspect.Config?.Labels?.['spartan.tenant'] !== id || inspect.Config?.Labels?.['spartan.managed'] !== 'true')) throw new Error('container_conflict');
  await mkdir(path.join(root, id), {recursive: true, mode: 0o700});
  const record = {...existing, id, fingerprint, lifecycleVersion, lifecycleAction: action, status: action, updatedAt: new Date().toISOString()};
  await save(record);
  if (inspect) {
    await docker(['update', '--restart=no', name]);
    if (action === 'suspended' && inspect.State?.Running) await docker(['stop', '--time', '30', name]);
    if (action === 'terminated') await docker(['rm', '--force', name]);
  }
  return {id, status: action, lifecycleVersion};
}
