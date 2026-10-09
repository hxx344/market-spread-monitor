import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('only a complete successful deployment advances latest, with ancestry ordering independent of newer pending main commits', () => {
  const directory = mkdtempSync(join(tmpdir(), 'release-publish-'));
  const commit = 'b'.repeat(40);
  const bytes = Buffer.from('fixture archive bytes');
  const item = { file: 'runtime.tar.gz', sha256: createHash('sha256').update(bytes).digest('hex'), application_key: 'c'.repeat(64) };
  writeFileSync(join(directory, item.file), bytes);
  writeFileSync(join(directory, 'release-manifest.json'), JSON.stringify({ schema: 1, repository: 'fixture/application', commit, tag: 'deploy-' + commit, artifacts: { 'linux-x64': item, 'linux-arm64': item } }));
  const script = new URL('../scripts/publish-release.mjs', import.meta.url).href;
  const mock = `
    import { writeFileSync } from 'node:fs';
    const requests = [];
    const scenario = process.env.RELEASE_TEST_SCENARIO;
    globalThis.fetch = async (url, options = {}) => {
      const path = new URL(url).pathname;
      requests.push({ path, method: options.method ?? 'GET', body: typeof options.body === 'string' ? JSON.parse(options.body) : null });
      writeFileSync(process.env.RELEASE_TEST_LOG, JSON.stringify(requests));
      const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
      if (path.includes('/releases/tags/')) return reply({}, 404);
      if (options.method === undefined && path.endsWith('/releases')) return reply(scenario === 'resume' ? [{ id: 42, draft: true, tag_name: 'deploy-' + 'b'.repeat(40), target_commitish: 'b'.repeat(40), assets: [], upload_url: 'https://uploads.github.com/repos/fixture/application/releases/42/assets{?name}' }] : []);
      if (options.method === 'POST' && path.endsWith('/releases')) return reply({ id: 42, assets: [], upload_url: 'https://uploads.github.com/repos/fixture/application/releases/42/assets{?name}' });
      if (path.endsWith('/assets')) return reply({}, scenario === 'upload-failure' ? 503 : 201);
      if (path.endsWith('/releases/latest')) return scenario === 'first' ? reply({}, 404) : reply({ tag_name: 'deploy-' + 'a'.repeat(40) });
      if (path.includes('/compare/')) return reply({ status: scenario === 'resume' ? 'ahead' : scenario });
      if (options.method === 'PATCH' && path.endsWith('/releases/42')) return reply({});
      throw new Error('Unexpected network request: ' + path);
    };
    await import(${JSON.stringify(script)});
  `;
  try {
    for (const scenario of ['first', 'ahead', 'identical', 'behind', 'diverged', 'resume', 'upload-failure']) {
      const log = join(directory, scenario + '.json');
      const execute = () => execFileSync(process.execPath, ['--input-type=module', '--eval', mock, 'fixture', directory], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GITHUB_REPOSITORY: 'fixture/application', GITHUB_SHA: commit, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', GITHUB_TOKEN: 'fixture-token', RELEASE_TEST_SCENARIO: scenario, RELEASE_TEST_LOG: log } });
      if (scenario === 'upload-failure') assert.throws(execute);
      else execute();
      const requests = JSON.parse(readFileSync(log, 'utf8'));
      const published = requests.find(request => request.method === 'PATCH');
      if (scenario === 'upload-failure') assert.equal(published, undefined, 'Partial uploads must stay draft');
      else {
        assert.equal(published.body.draft, false, 'Every complete passing commit receives its immutable release');
        assert.equal(published.body.make_latest, String(['first', 'ahead', 'identical', 'resume'].includes(scenario)));
        assert.equal(requests.filter(request => request.path.endsWith('/assets')).length, 2, 'Archive and manifest are uploaded before publication');
        if (scenario === 'resume') assert.equal(requests.some(request => request.path.endsWith('/releases') && request.method === 'POST'), false, 'An existing draft is resumed by its returned ID');
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
