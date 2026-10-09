import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const directory = resolve(process.argv[2] ?? 'release-output');
const repository = process.env.GITHUB_REPOSITORY;
const commit = process.env.GITHUB_SHA;
if (process.env.GITHUB_REF !== 'refs/heads/main' || !['push', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME)) throw new Error('Deployment releases are only published from main pushes or dispatches');
if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^[a-f0-9]{40}$/.test(commit ?? '') || !process.env.GITHUB_TOKEN) throw new Error('Missing release identity or authorization');
const apiRoot = `https://api.github.com/repos/${repository}`;
const headers = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' };
async function api(path, options = {}) {
  const response = await fetch(apiRoot + path, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(120_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub release request failed (${response.status} ${path})`);
  return response.status === 204 ? null : response.json();
}
const bytes = await readFile(join(directory, 'release-manifest.json'));
const manifest = JSON.parse(bytes);
if (manifest.schema !== 1 || manifest.repository !== repository || manifest.commit !== commit || manifest.tag !== `deploy-${commit}` || !manifest.artifacts['linux-x64'] || !manifest.artifacts['linux-arm64']) throw new Error('Incomplete or mismatched release manifest');
const files = new Map([['release-manifest.json', bytes]]);
for (const item of Object.values(manifest.artifacts)) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz$/.test(item.file) || !/^[a-f0-9]{64}$/.test(item.application_key)) throw new Error('Invalid release artifact');
  const content = await readFile(join(directory, item.file));
  if (createHash('sha256').update(content).digest('hex') !== item.sha256) throw new Error(`Artifact checksum mismatch: ${item.file}`);
  files.set(item.file, content);
}
let release = await api(`/releases/tags/${manifest.tag}`);
// Unpublished tag references are not reliably exposed by the by-tag endpoint.
// Discover an interrupted draft through the authenticated release collection.
if (!release) {
  for (let page = 1; ; page++) {
    const releases = await api(`/releases?per_page=100&page=${page}`);
    if (!Array.isArray(releases)) throw new Error('Cannot list existing deployment drafts');
    release = releases.find(item => item.tag_name === manifest.tag);
    if (release || releases.length < 100) break;
  }
}
if (release && !release.draft) {
  if ((await api(`/commits/${manifest.tag}`))?.sha !== commit || [...files.keys()].some(name => !release.assets.some(asset => asset.name === name))) throw new Error('Published immutable release is incomplete or targets another commit');
  console.log(`Immutable release ${manifest.tag} already exists; skipped publication.`);
  process.exit(0);
}
if (release && release.target_commitish !== commit) throw new Error('Existing draft targets a different immutable commit');
release ??= await api('/releases', { method: 'POST', body: JSON.stringify({ tag_name: manifest.tag, target_commitish: commit, name: `Candidate ${commit.slice(0, 12)}`, draft: true, prerelease: true, make_latest: 'false', body: 'Verified Linux deployment artifacts. Installers retain configuration and data.' }) });
for (const [name, content] of files) {
  const existing = release.assets.find(asset => asset.name === name);
  if (existing) {
    const response = await fetch(existing.url, { headers: { ...headers, Accept: 'application/octet-stream' }, signal: AbortSignal.timeout(120_000) });
    if (!response.ok || createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex') !== createHash('sha256').update(content).digest('hex')) throw new Error(`Refusing to overwrite immutable draft asset ${name}`);
    continue;
  }
  const upload = release.upload_url.replace(/\{.*$/, '') + `?name=${encodeURIComponent(name)}`;
  const response = await fetch(upload, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: content, signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`Upload failed (${response.status} ${name}); release remains draft`);
}
// Passing CI creates a candidate; only the explicit promotion workflow changes stable.
await api(`/releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ draft: false, prerelease: true, make_latest: 'false' }) });
console.log(`Published complete CI candidate ${manifest.tag}; stable channel unchanged.`);
