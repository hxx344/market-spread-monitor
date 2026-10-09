import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('CI publishes complete candidates without changing stable and preserves public candidate or stable reruns', () => {
  const directory = mkdtempSync(join(tmpdir(), 'release-publish-'));
  const commit = 'b'.repeat(40), tag = 'deploy-' + commit;
  const bytes = Buffer.from('fixture archive bytes');
  const item = { file: 'runtime.tar.gz', sha256: createHash('sha256').update(bytes).digest('hex'), application_key: 'c'.repeat(64) };
  writeFileSync(join(directory, item.file), bytes);
  writeFileSync(join(directory, 'release-manifest.json'), JSON.stringify({ schema: 1, repository: 'fixture/application', commit, tag, artifacts: { 'linux-x64': item, 'linux-arm64': item } }));
  const script = new URL('../scripts/publish-release.mjs', import.meta.url).href;
  const mock = `
    import { writeFileSync } from 'node:fs';
    const requests = [], scenario = process.env.RELEASE_TEST_SCENARIO, commit = 'b'.repeat(40), tag = 'deploy-' + commit;
    const release = { id: 42, draft: true, prerelease: true, tag_name: tag, target_commitish: commit, assets: [], upload_url: 'https://uploads.github.com/repos/fixture/application/releases/42/assets{?name}' };
    if (scenario.startsWith('public-')) {
      release.draft = false; release.prerelease = scenario !== 'public-stable';
      release.assets = [{ name: 'runtime.tar.gz' }, { name: 'release-manifest.json' }];
      if (scenario === 'public-incomplete') release.assets.pop();
    }
    globalThis.fetch = async (url, options = {}) => {
      const path = new URL(url).pathname;
      requests.push({ path, method: options.method ?? 'GET', body: typeof options.body === 'string' ? JSON.parse(options.body) : null });
      writeFileSync(process.env.RELEASE_TEST_LOG, JSON.stringify(requests));
      const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
      if (path.includes('/releases/tags/')) return scenario.startsWith('public-') ? reply(release) : reply({}, 404);
      if (path.includes('/commits/')) return reply({ sha: scenario === 'public-wrong-commit' ? 'a'.repeat(40) : commit });
      if (options.method === undefined && path.endsWith('/releases')) return reply(scenario === 'resume' ? [release] : []);
      if (options.method === 'POST' && path.endsWith('/releases')) return reply(release);
      if (path.endsWith('/assets')) return reply({}, scenario === 'upload-failure' ? 503 : 201);
      if (options.method === 'PATCH' && path.endsWith('/releases/42')) return reply({});
      throw new Error('Candidate CI must not inspect or change stable: ' + path);
    };
    await import(${JSON.stringify(script)});
  `;
  try {
    for (const scenario of ['first', 'resume', 'upload-failure', 'public-candidate', 'public-stable', 'public-incomplete', 'public-wrong-commit']) {
      const log = join(directory, scenario + '.json');
      const execute = () => execFileSync(process.execPath, ['--input-type=module', '--eval', mock, 'fixture', directory], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GITHUB_REPOSITORY: 'fixture/application', GITHUB_SHA: commit, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', GITHUB_TOKEN: 'fixture-token', RELEASE_TEST_SCENARIO: scenario, RELEASE_TEST_LOG: log } });
      if (['upload-failure', 'public-incomplete', 'public-wrong-commit'].includes(scenario)) assert.throws(execute, undefined, scenario);
      else execute();
      const requests = JSON.parse(readFileSync(log, 'utf8'));
      const published = requests.find(request => request.method === 'PATCH');
      assert.equal(requests.some(request => request.path.endsWith('/latest') || request.path.includes('/compare/')), false, scenario);
      if (scenario.startsWith('public-')) assert.equal(requests.some(request => request.method !== 'GET'), false, 'Published assets and stable qualification remain untouched');
      else if (scenario === 'upload-failure') assert.equal(published, undefined, 'Partial uploads stay draft');
      else {
        assert.deepEqual(published.body, { draft: false, prerelease: true, make_latest: 'false' });
        assert.equal(requests.filter(request => request.path.endsWith('/assets')).length, 2, 'Archive and manifest upload before publication');
        const created = requests.find(request => request.path.endsWith('/releases') && request.method === 'POST');
        if (scenario === 'resume') assert.equal(created, undefined);
        else { assert.equal(created.body.draft, true); assert.equal(created.body.prerelease, true); assert.equal(created.body.make_latest, 'false'); }
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
