import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

const exec = promisify(execFile);
const script = resolve('runtime/install-ioncube.sh');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'spartan-ioncube-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const bin = join(root, 'bin');
  const ext = join(root, 'extensions');
  const ini = join(root, 'ini');
  const payload = join(root, 'payload');
  for (const path of [bin, ext, join(ini, 'conf.d'), join(payload, 'ioncube')]) await mkdir(path, {recursive: true});
  await writeFile(join(payload, 'ioncube/ioncube_loader_lin_8.4.so'), 'fixture-loader');
  const archive = join(root, 'loaders.tar.gz');
  await exec('tar', ['-czf', archive, '-C', payload, 'ioncube']);
  const programs = {
    uname: '#!/bin/sh\nprintf "%s\\n" "${TEST_ARCH:-x86_64}"\n',
    php: '#!/bin/sh\ncase "$2" in *PHP_MAJOR_VERSION*) printf 8.4 ;; *) printf 15.0.0 ;; esac\n',
    'php-config': '#!/bin/sh\nprintf "%s\\n" "$TEST_EXT"\n',
    curl: '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; cp "$TEST_ARCHIVE" "$1"; exit; fi; shift; done\nexit 1\n'
  };
  for (const [name, content] of Object.entries(programs)) await writeFile(join(bin, name), content, {mode: 0o755});
  const sha = createHash('sha256').update(await readFile(archive)).digest('hex');
  return {root, ext, ini, env: {...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_EXT: ext, TEST_ARCHIVE: archive, PHP_INI_DIR: ini, IONCUBE_SHA256: sha}};
}

test('ionCube installation verifies the archive and enables the PHP 8.4 CLI loader', async t => {
  const f = await fixture(t);
  await exec('sh', [script], {env: f.env});
  assert.equal(await readFile(join(f.ext, 'ioncube_loader_lin_8.4.so'), 'utf8'), 'fixture-loader');
  assert.equal(await readFile(join(f.ini, 'conf.d/00-ioncube.ini'), 'utf8'), `zend_extension=${f.ext}/ioncube_loader_lin_8.4.so\n`);
});

test('a mismatched ionCube checksum stops installation before enabling a loader', async t => {
  const f = await fixture(t);
  await assert.rejects(exec('sh', [script], {env: {...f.env, IONCUBE_SHA256: '0'.repeat(64)}}));
  await assert.rejects(readFile(join(f.ini, 'conf.d/00-ioncube.ini')));
});

test('unsupported architectures fail before downloading ionCube', async t => {
  const f = await fixture(t);
  await assert.rejects(exec('sh', [script], {env: {...f.env, TEST_ARCH: 'riscv64'}}), error => error.stderr.includes('unsupported_ioncube_architecture'));
  await assert.rejects(readFile(join(f.ext, 'ioncube_loader_lin_8.4.so')));
});
