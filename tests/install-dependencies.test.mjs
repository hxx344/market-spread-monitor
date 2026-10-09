import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
// On Windows use only Bash from a located Git installation, never the Windows
// bash launcher, which can enter WSL. Linux CI uses its native Bash directly.
const gitDirectories = process.platform === "win32" ? (process.env.PATH ?? "").split(delimiter).filter(path => path && existsSync(join(path, "git.exe"))) : [];
const gitBash = gitDirectories.flatMap(path => [join(path, "bash.exe"), resolve(path, "../bin/bash.exe"), resolve(path, "../../bin/bash.exe")]).find(path => existsSync(path));
const bash = process.platform === "linux" ? "bash" : gitBash;
const shellOnly = { skip: !bash };
const installer = (await readFile(new URL("../deploy/install.sh", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
const entrypoint = installer.lastIndexOf("\nif (( EUID != 0 )); then");
assert.ok(entrypoint > 0, "Dependency tests load functions without invoking installation");

async function installFixture(t, profile, status) {
  const root = await mkdtemp(join(tmpdir(), "market-spread-dependencies-test-"));
  const release = join(root, "release with spaces");
  const runtime = join(root, "runtime");
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.includes("market-spread-dependencies-test-"));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(release, "deploy/linux"), { recursive: true });
  await mkdir(join(runtime, "bin"), { recursive: true });
  const original = { "package.json": '{ "scripts": { "build:linux": "original recipe" }, "source": true }\n', "package-lock.json": '{ "sourceLock": true }\n' };
  const reduced = { "package.json": '{ "linuxProfile": true }\n', "package-lock.json": '{ "linuxLock": true }\n' };
  const originalInodes = {};
  for (const name of Object.keys(original)) {
    await writeFile(join(release, name), original[name]);
    await writeFile(join(release, "deploy/linux", name), reduced[name]);
    originalInodes[name] = (await stat(join(release, name))).ino;
  }
  await writeFile(join(release, "deploy/linux-dependencies.mjs"), "// Selection is handled by the fixture runtime.\n");
  await writeFile(join(runtime, "bin/node"), `#!/usr/bin/env bash\nprintf '%s\\n' '${profile}'\n`, { mode: 0o755 });
  const script = `${installer.slice(0, entrypoint)}
fixture_root=$1
release=$2
runtime=$3
npm_status=$4
# Observe the files visible to npm, without installing packages or changing users.
runuser() {
  [[ "$*" == *' npm ci '* ]] || return 90
  cp -- "$release/package.json" "$fixture_root/observed-package.json"
  cp -- "$release/package-lock.json" "$fixture_root/observed-package-lock.json"
  if [[ -e "$release/.install-source-package.json" && -e "$release/.install-source-package-lock.json" ]]; then
    printf 'present' > "$fixture_root/backups-during-install"
  else
    printf 'absent' > "$fixture_root/backups-during-install"
  fi
  return "$npm_status"
}
cd "$release"
install_project_dependencies
`;
  const scriptPath = join(root, "install-fixture.sh");
  await writeFile(scriptPath, script);
  let result;
  try {
    result = { ...await exec(bash, ["--noprofile", "--norc", ...[scriptPath, root, release, runtime].map(path => path.replaceAll("\\", "/")), String(status)], { timeout: 10_000 }), code: 0 };
  } catch (error) {
    result = { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code };
  }
  assert.equal(result.code, status, `${result.stdout}\n${result.stderr}`);
  for (const name of Object.keys(original)) {
    assert.equal(await readFile(join(root, `observed-${name}`), "utf8"), profile === "linux-v1" ? reduced[name] : original[name], `npm must receive the selected ${name}`);
    assert.equal(await readFile(join(release, name), "utf8"), original[name], `Original ${name} must be restored even when npm fails`);
    assert.equal(existsSync(join(release, `.install-source-${name}`)), false, "No temporary manifest backup may remain");
    if (profile === "root-v1") assert.equal((await stat(join(release, name))).ino, originalInodes[name], "Full installation must not replace source manifests");
  }
  assert.equal(await readFile(join(root, "backups-during-install"), "utf8"), profile === "linux-v1" ? "present" : "absent");
}

test("successful Linux dependency installation restores the original manifest and lock", shellOnly, async t => {
  await installFixture(t, "linux-v1", 0);
});

test("failed Linux dependency installation restores both originals and preserves npm failure status", shellOnly, async t => {
  await installFixture(t, "linux-v1", 42);
});

test("full dependency fallback never substitutes source manifests, on success or failure", shellOnly, async t => {
  for (const status of [0, 43]) await installFixture(t, "root-v1", status);
});
