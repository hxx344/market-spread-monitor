import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const linuxOnly = { skip: process.platform !== "linux" };
const installer = await readFile(new URL("../deploy/install.sh", import.meta.url), "utf8");
const entrypoint = installer.lastIndexOf("\nif (( EUID != 0 )); then");
assert.ok(entrypoint > 0, "Workspace tests load functions without invoking installation");

async function fixture(t, { owned = true, version = "v1" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "market-spread-build-test-"));
  const base = join(root, "installation with spaces");
  const workspace = join(base, "build");
  const target = join(base, "releases/aaaaaaaaaaaa-TEST0001");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(base, "releases"));
  if (owned) await writeFile(join(workspace, ".install-owned"), "");
  if (version !== null) await writeFile(join(workspace, ".install-build-workspace"), version);
  await writeFile(join(workspace, "candidate-data"), "candidate contents");
  t.after(async () => {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}/market-spread-build-test-`));
    await rm(root, { recursive: true, force: true });
  });
  async function run(body) {
    const script = `${installer.slice(0, entrypoint)}
fixture_root=$1
base=$2
new_release=$3
release="$base/build"
building_release=''
storage_current=''
storage_running=''
storage_data_dir=''
source_dir=''
read_storage_protection() { :; }
# Guard mutations in case a regression passes an unintended absolute path.
rm() {
  local argument
  for argument in "$@"; do
    [[ "$argument" == -* ]] && continue
    [[ "$argument" == "$fixture_root/"* ]] || { printf 'unsafe test deletion: %s\\n' "$argument" >&2; return 90; }
  done
  command rm "$@"
}
mv() {
  local argument
  for argument in "$@"; do
    [[ "$argument" == -* ]] && continue
    [[ "$argument" == "$fixture_root/"* ]] || { printf 'unsafe test move: %s\\n' "$argument" >&2; return 90; }
  done
  command mv "$@"
}
${body}`;
    try {
      return { ...await exec("bash", ["--noprofile", "--norc", "-c", script, "build-workspace-test", root, base, target], { timeout: 10_000 }), code: 0 };
    } catch (error) {
      return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code };
    }
  }
  return { root, base, workspace, target, run };
}

test("interrupted owned build workspace is reclaimed without touching successful releases", linuxOnly, async t => {
  const f = await fixture(t);
  await mkdir(f.target);
  await writeFile(join(f.target, "running-data"), "running contents");
  const result = await f.run('storage_current="$new_release"; cleanup_build_workspace');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(f.workspace), false);
  assert.equal(await readFile(join(f.target, "running-data"), "utf8"), "running contents");
  assert.match(result.stdout, /上次中断/);
});

test("unrecognized build directory and marker variants are retained", linuxOnly, async t => {
  for (const options of [{ version: null }, { version: "v2" }, { owned: false }]) {
    const f = await fixture(t, options);
    const result = await f.run("cleanup_build_workspace");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /不属于本安装器/);
    assert.equal(await readFile(join(f.workspace, "candidate-data"), "utf8"), "candidate contents");
  }
});

test("cleanup preserves workspaces containing the current process, source or data", linuxOnly, async t => {
  const f = await fixture(t);
  for (const protection of [
    'storage_current="$base/build"',
    'storage_running="$base/build"',
    'source_dir="$base/build/nested-source"',
    'storage_data_dir="$base/build/nested-data"',
    'storage_data_dir="$base"',
  ]) {
    const result = await f.run(`${protection}\ncleanup_build_workspace`);
    assert.equal(result.code, 1, protection);
    assert.match(result.stderr, /运行版本、源码或数据/);
    assert.equal(await readFile(join(f.workspace, "candidate-data"), "utf8"), "candidate contents");
  }
});

test("workspace cleanup rejects a symlinked directory or ownership marker", linuxOnly, async t => {
  const f = await fixture(t);
  const external = join(f.root, "external");
  await mkdir(external);
  await writeFile(join(external, "preserve"), "external data");
  await rm(f.workspace, { recursive: true });
  await symlink(external, f.workspace);
  const linkedDirectory = await f.run("cleanup_build_workspace");
  assert.equal(linkedDirectory.code, 1);
  assert.equal(await readFile(join(external, "preserve"), "utf8"), "external data");
  await rm(f.workspace);
  await mkdir(f.workspace);
  await writeFile(join(f.workspace, ".install-owned"), "");
  await writeFile(join(external, "marker"), "v1");
  await symlink(join(external, "marker"), join(f.workspace, ".install-build-workspace"));
  const linkedMarker = await f.run("cleanup_build_workspace");
  assert.equal(linkedMarker.code, 1);
  assert.equal(await readFile(join(external, "marker"), "utf8"), "v1");
});

test("finishing a build moves its full candidate into its original release without a third copy", linuxOnly, async t => {
  const f = await fixture(t);
  const before = await stat(join(f.workspace, "candidate-data"));
  const result = await f.run(`
building_release="$new_release"
restore_build_workspace
[[ "$release" == "$new_release" && -z "$building_release" ]]
`);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(f.workspace), false);
  assert.equal(existsSync(join(f.target, ".install-build-workspace")), false);
  assert.equal(await readFile(join(f.target, "candidate-data"), "utf8"), "candidate contents");
  const after = await stat(join(f.target, "candidate-data"));
  assert.equal(after.ino, before.ino, "Moving a candidate must not create another dependency tree");
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("restoring a candidate refuses to overwrite an occupied or symlinked release destination", linuxOnly, async t => {
  const f = await fixture(t);
  await mkdir(f.target);
  await writeFile(join(f.target, "preserve"), "existing release");
  const occupied = await f.run('building_release="$new_release"; restore_build_workspace');
  assert.equal(occupied.code, 1);
  assert.equal(await readFile(join(f.target, "preserve"), "utf8"), "existing release");
  assert.equal(await readFile(join(f.workspace, "candidate-data"), "utf8"), "candidate contents");
  await rm(f.target, { recursive: true });
  await symlink(join(f.root, "absent"), f.target);
  const linked = await f.run('building_release="$new_release"; restore_build_workspace');
  assert.equal(linked.code, 1);
  assert.equal(await readFile(join(f.workspace, "candidate-data"), "utf8"), "candidate contents");
});
