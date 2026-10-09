import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { applicationKey } from './release-inputs.mjs';
import { validBuild } from '../deploy/install-inputs.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(process.argv[2] ?? join(root, 'release-output'));
const commit = process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
if (!/^[a-f0-9]{40}$/.test(commit) || process.platform !== 'linux') throw new Error('Release packaging requires an immutable commit and native Linux');
if (!validBuild(root)) throw new Error('Build the complete client and SSR artifacts before packaging');
const workspace = await mkdtemp(join(tmpdir(), 'monitor-release-'));
const stage = join(workspace, 'package');
await mkdir(stage);
async function containedLinks(directory, boundary = directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.name === '.bin') continue;
    const file = join(directory, item.name);
    if (item.isSymbolicLink()) {
      const target = await realpath(file);
      if (target !== boundary && !target.startsWith(boundary + sep)) throw new Error(`Release symlink escapes its input tree: ${file}`);
    } else if (item.isDirectory()) await containedLinks(file, boundary);
  }
}
async function copy(name) {
  const source = join(root, name);
  if ((await stat(source)).isDirectory()) await containedLinks(source);
  await cp(source, join(stage, name), { recursive: true, dereference: true, filter: path => path.split(sep).at(-1) !== '.bin' });
}
try {
  for (const name of ['dist', 'server', 'lib', 'modules', 'data', 'public', 'package.json', 'package-lock.json', 'web/page-props.ts', 'deploy/check-install.mjs', 'deploy/install-inputs.mjs', 'deploy/linux-dependencies.mjs', 'deploy/market-spread-monitor.service']) await copy(name);
  // Stage an independent dependency copy: pruning can never alter the checked build.
  await copy('node_modules');
  execFileSync('npm', ['prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit' });
  async function inspect(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.name === '.bin') { await rm(path, { recursive: true, force: true }); continue; }
      if (item.isSymbolicLink()) throw new Error(`Unexpected package symlink: ${path}`);
      if (item.isDirectory()) await inspect(path);
      else if (item.isFile()) {
        const bytes = await readFile(path);
        if (/\.(?:node|so|dll|dylib|exe)$/i.test(item.name) || bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error(`Native binary requires architecture-specific packaging: ${path}`);
      } else throw new Error(`Unexpected package entry: ${path}`);
    }
  }
  await inspect(stage);
  for (const name of ['vite', 'typescript', '@vitejs/plugin-react']) {
    try { await stat(join(stage, 'node_modules', name)); throw new Error(`Development tool leaked into runtime: ${name}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const key = applicationKey(root);
  await writeFile(join(stage, '.release-commit'), commit + '\n');
  await writeFile(join(stage, '.release-application-key'), key + '\n');
  await mkdir(output, { recursive: true });
  const file = `market-spread-monitor-${commit}-linux-any.tar.gz`;
  execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', join(output, file), '-C', stage, '.']);
  const artifact = { file, sha256: createHash('sha256').update(await readFile(join(output, file))).digest('hex'), application_key: key };
  await writeFile(join(output, 'release-manifest.json'), JSON.stringify({ schema: 1, repository: 'hxx344/market-spread-monitor', commit, tag: `deploy-${commit}`, node_version: '24.15.0', artifacts: { 'linux-x64': artifact, 'linux-arm64': artifact } }, null, 2) + '\n');
  console.log(`Prepared ${file}; application key ${key}`);
} finally { await rm(workspace, { recursive: true, force: true }); }
