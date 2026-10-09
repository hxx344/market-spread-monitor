import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { applicationKey } from '../scripts/release-inputs.mjs';

test('deployment identity follows runtime content and excludes documentation, tests and workflows', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-inputs-'));
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: root, stdio: 'pipe' });
  const write = (name, value) => {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), value);
    git('add', name);
  };
  const key = () => applicationKey(root, 'x64');
  try {
    git('init', '-q');
    write('package-lock.json', '{"lockfileVersion":3}');
    write('server/application.mjs', 'export const value = 1;');
    const initial = key();
    for (const name of ['README.md', 'docs/install.md', 'deploy/README.md', 'tests/runtime.test.mjs', '.github/workflows/release.yml']) write(name, 'first');
    assert.equal(key(), initial);
    for (const name of ['README.md', 'docs/install.md', 'deploy/README.md', 'tests/runtime.test.mjs', '.github/workflows/release.yml']) write(name, 'second');
    assert.equal(key(), initial);
    write('package-lock.json', '{"lockfileVersion":3,"changed":true}');
    assert.notEqual(key(), initial);
    write('package-lock.json', '{"lockfileVersion":3}');
    write('server/application.mjs', 'export const value = 2;');
    assert.notEqual(key(), initial);
    write('server/application.mjs', 'export const value = 1;');
    write('future-runtime/entry.mjs', 'export default 1;');
    assert.notEqual(key(), initial, 'New runtime folders invalidate deployment identity');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
