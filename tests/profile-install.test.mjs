import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const exec = promisify(execFile);
const linuxOnly = { skip: process.platform !== "linux" };
const wrapper = fileURLToPath(new URL("../deploy/profile-install.sh", import.meta.url));

async function runFixture(t, { installStatus = 0, downloadStatus = 0, formatterStatus = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "monitor-profile-entry-test-"));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.includes("monitor-profile-entry-test-"));
    await rm(root, { recursive: true, force: true });
  });
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(root, "fake-installer.sh"), `#!/usr/bin/env bash
printf '%s\\n' "$0" > "$FIXTURE_ROOT/executed-path"
printf '%s\\n' "$@" > "$FIXTURE_ROOT/arguments"
exit "$FIXTURE_INSTALL_STATUS"
`);
  await writeFile(join(bin, "curl"), `#!/usr/bin/env bash
(( FIXTURE_DOWNLOAD_STATUS == 0 )) || exit "$FIXTURE_DOWNLOAD_STATUS"
cp -- "$FIXTURE_ROOT/fake-installer.sh" "\${@: -1}"
`, { mode: 0o755 });
  if (formatterStatus) await writeFile(join(bin, "awk"), `#!/usr/bin/env bash\nexit ${formatterStatus}\n`, { mode: 0o755 });
  let result;
  try {
    result = { ...await exec("bash", [wrapper, "--source-dir", "/source with spaces", "--port", "31877", "--rebuild"], {
      timeout: 10_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_ROOT: root, FIXTURE_INSTALL_STATUS: String(installStatus), FIXTURE_DOWNLOAD_STATUS: String(downloadStatus) },
    }), code: 0 };
  } catch (error) {
    result = { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code };
  }
  if (downloadStatus === 0) {
    assert.deepEqual((await readFile(join(root, "arguments"), "utf8")).trim().split("\n"), ["--profile", "--source-dir", "/source with spaces", "--port", "31877", "--rebuild"]);
    const downloaded = (await readFile(join(root, "executed-path"), "utf8")).trim();
    assert.match(downloaded, /^\/tmp\/market-spread-profile-bootstrap\.[^/]+\/install\.sh$/);
    assert.equal(existsSync(dirname(downloaded)), false, "Downloaded bootstrap files must be removed on either installer outcome");
  } else assert.equal(existsSync(join(root, "arguments")), false, "A failed download must never execute an installer");
  return result;
}

test("profiling entry forwards explicit deployment options and cleans up after success", linuxOnly, async t => {
  const result = await runFixture(t);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /部署脚本下载：[0-9.]+ 秒/);
});

test("profiling entry preserves the installer failure code", linuxOnly, async t => {
  const result = await runFixture(t, { installStatus: 42 });
  assert.equal(result.code, 42, result.stderr);
});

test("profiling entry stops on download failure and preserves its code", linuxOnly, async t => {
  const result = await runFixture(t, { downloadStatus: 28 });
  assert.equal(result.code, 28, result.stderr);
});

test("download timing formatter failure does not mask download or installer results", linuxOnly, async t => {
  const installed = await runFixture(t, { installStatus: 42, formatterStatus: 72 });
  assert.equal(installed.code, 42, installed.stderr);
  const downloadFailed = await runFixture(t, { downloadStatus: 28, formatterStatus: 72 });
  assert.equal(downloadFailed.code, 28, downloadFailed.stderr);
});
