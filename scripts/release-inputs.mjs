import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Hash tracked content, not commit IDs, mtimes, checkout paths or CI variables.
// New runtime folders are included by default; only non-runtime roots are omitted.
export function releaseInput(name) {
  if (/^(?:docs|tests|\.github|\.openai|\.codex|\.agents)\//.test(name)) return false;
  if (!name.includes('/') && (/\.md$/i.test(name) || /^\.git/.test(name))) return false;
  if (/^deploy\/(?:release-common\.sh|test-release\.py)$/.test(name) || /^scripts\/(?:publish|merge)-release\.mjs$/.test(name)) return false;
  return name !== 'deploy/install.sh' && name !== 'deploy/profile-install.sh' && name !== 'deploy/README.md';
}

export function applicationKey(root) {
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(name => name && releaseInput(name)).sort();
  const hash = createHash('sha256').update('monitor-ci-runtime-v1\0node-24.15.0\0');
  for (const name of paths) {
    const data = readFileSync(join(root, name));
    hash.update(`${name}\0${data.length}\0`).update(data);
  }
  return hash.digest('hex');
}
