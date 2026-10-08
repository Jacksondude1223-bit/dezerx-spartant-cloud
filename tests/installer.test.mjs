import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, chmodSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('private installer authenticates without retaining or logging credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spartan-installer-test-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const source = readFileSync(new URL('../install.sh', import.meta.url), 'utf8')
      .replace('export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', `export PATH="${bin}:/usr/bin:/bin"`)
      .replace('[ -d /run/systemd/system ]', 'true');
    writeFileSync(join(dir, 'install.sh'), source);
    writeFileSync(join(bin, 'id'), '#!/bin/bash\nprintf "0\\n"\n');
    writeFileSync(join(bin, 'git'), `#!/bin/bash
set -eu
[[ "$*" != *fake_test_secret* ]]
[[ "$("$GIT_ASKPASS" "Username for 'https://github.com': ")" = x-access-token ]]
[[ "$("$GIT_ASKPASS" "Password for 'https://x-access-token@github.com': ")" = fake_test_secret ]]
if "$GIT_ASKPASS" "Password for 'https://evil.example': "; then exit 20; fi
printf '%s' "$SPARTAN_GITHUB_TOKEN_FILE" > "$TEST_RESULT/auth-path"
destination="\${!#}"
mkdir -p "$destination/scripts"
cat > "$destination/scripts/install-node.sh" <<'INSTALL'
#!/bin/bash
set -eu
[[ -z "\${GIT_ASKPASS:-}" && -z "\${SPARTAN_GITHUB_TOKEN_FILE:-}" ]]
[[ ! -e "$(cat "$TEST_RESULT/auth-path")" ]]
printf '%s\\n' "$@" > "$TEST_RESULT/args"
INSTALL
`);
    for (const name of ['id', 'git']) chmodSync(join(bin, name), 0o755);
    const token = join(dir, 'token');
    writeFileSync(token, 'fake_test_secret\n', {mode: 0o600});
    const result = spawnSync('bash', [join(dir, 'install.sh'), 'de', '--github-token-file', token, '--env', 'node.env', '--token', 'tunnel-token', '--non-interactive'], {encoding:'utf8', env:{...process.env, TEST_RESULT:dir}});
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!`${result.stdout}${result.stderr}`.includes('fake_test_secret'));
    assert.equal(readFileSync(join(dir, 'args'), 'utf8'), 'de\n--env\nnode.env\n--token\ntunnel-token\n--non-interactive\n');
    const authPath = readFileSync(join(dir, 'auth-path'), 'utf8');
    assert.throws(() => readFileSync(authPath));
    chmodSync(token, 0o644);
    const rejected = spawnSync('bash', [join(dir, 'install.sh'), 'us', '--github-token-file', token], {encoding:'utf8', env:{...process.env, TEST_RESULT:dir}});
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /mode 600/);
    chmodSync(token, 0o600);
    writeFileSync(join(bin, 'git'), '#!/bin/bash\nprintf "%s" "$SPARTAN_GITHUB_TOKEN_FILE" > "$TEST_RESULT/failure-path"\nexit 1\n');
    const failed = spawnSync('bash', [join(dir, 'install.sh'), 'us', '--github-token-file', token], {encoding:'utf8', env:{...process.env, TEST_RESULT:dir}});
    assert.notEqual(failed.status, 0);
    assert.throws(() => readFileSync(readFileSync(join(dir, 'failure-path'), 'utf8')));

  } finally { rmSync(dir, {recursive:true, force:true}); }
});
