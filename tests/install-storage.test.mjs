import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const linuxOnly = { skip: process.platform !== "linux" };
const installer = await readFile(new URL("../deploy/install.sh", import.meta.url), "utf8");
const entrypoint = installer.lastIndexOf("\nif (( EUID != 0 )); then");
assert.ok(entrypoint > 0, "Storage tests must load function definitions without invoking installation");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "market-spread-storage-test-"));
  const base = join(root, "installation");
  await mkdir(join(base, "releases"), { recursive: true });
  t.after(async () => {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}/market-spread-storage-test-`));
    await rm(root, { recursive: true, force: true });
  });
  async function release(index, { ready, owned = true, legacy = false } = {}) {
    const name = `${index.toString(16).padStart(12, "0")}-TEST${String(index).padStart(4, "0")}`;
    const path = join(base, "releases", name);
    await mkdir(path);
    if (owned) await writeFile(join(path, ".install-owned"), "");
    if (legacy) {
      await mkdir(join(path, "server"));
      await writeFile(join(path, "server/linux.mjs"), "");
      await writeFile(join(path, "package-lock.json"), "{}");
    }
    if (ready !== undefined) {
      const marker = join(path, ".install-ready");
      await writeFile(marker, "");
      await utimes(marker, ready, ready);
    }
    return path;
  }
  async function run(body) {
    // Remap only the fixed npm cache root; never inspect or remove a user's real cache.
    const definitions = installer.slice(0, entrypoint).replaceAll("/var/cache/market-spread-monitor", `${root}/npm-cache`);
    const script = `${definitions}
fixture_root=$1
base=$2
source_dir=''
old_current=''
new_release=''
storage_current=''
storage_running=''
storage_data_dir=''
read_storage_protection() { :; }
# A second guard makes all destructive operations fail closed outside this fixture.
rm() {
  local argument
  for argument in "$@"; do
    [[ "$argument" == -* ]] && continue
    [[ "$argument" == "$fixture_root/"* ]] || { printf 'unsafe test deletion: %s\\n' "$argument" >&2; return 90; }
  done
  command rm "$@"
}
${body}`;
    try {
      const result = await exec("bash", ["--noprofile", "--norc", "-c", script, "storage-test", root, base], { timeout: 10_000 });
      return { ...result, code: 0 };
    } catch (error) {
      return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code };
    }
  }
  return { root, base, release, run };
}

test("installer cleanup protects running, current, source, data and unfinished active candidate independently", linuxOnly, async t => {
  const f = await fixture(t);
  const current = await f.release(1, { ready: 500 });
  const running = await f.release(2, { ready: 200 });
  const rollback = await f.release(3, { ready: 400 });
  const old = await f.release(4, { ready: 100 });
  const failed = await f.release(5);
  const source = await f.release(6);
  const data = await f.release(7);
  const candidate = await f.release(8);
  const unowned = await f.release(9, { owned: false });
  const legacy = await f.release(10, { owned: false, legacy: true });
  const foreign = join(f.base, "releases", "user-saved-project");
  await mkdir(foreign);
  await writeFile(join(foreign, ".install-owned"), "unrecognized name remains untouched");
  const outside = join(f.root, "outside-release-root");
  await mkdir(outside);
  await writeFile(join(outside, "preserve"), "external data");
  const linked = join(f.base, "releases", "ffffffffffff-LINK0001");
  await symlink(outside, linked);
  const result = await f.run(`
storage_current="$base/releases/${current.split("/").at(-1)}"
storage_running="$base/releases/${running.split("/").at(-1)}"
source_dir="$base/releases/${source.split("/").at(-1)}/nested/source"
storage_data_dir="$base/releases/${data.split("/").at(-1)}/nested/data"
new_release="$base/releases/${candidate.split("/").at(-1)}"
prune_releases
`);
  assert.equal(result.code, 0, result.stderr);
  for (const path of [current, running, rollback, source, data, candidate, unowned, foreign, linked]) {
    assert.equal(existsSync(path), true, `Protected or unmanaged directory must remain: ${path}`);
  }
  for (const path of [old, failed, legacy]) assert.equal(existsSync(path), false, `Unused managed release must be removed: ${path}`);
  assert.equal(await readFile(join(outside, "preserve"), "utf8"), "external data");
});

test("successful upgrade retains its actual previous release even when another ready marker is newer", linuxOnly, async t => {
  const f = await fixture(t);
  const current = await f.release(1, { ready: 500 });
  const previous = await f.release(2, { ready: 100 });
  const other = await f.release(3, { ready: 400 });
  const result = await f.run(`
storage_current="$base/releases/${current.split("/").at(-1)}"
old_current="releases/${previous.split("/").at(-1)}"
prune_releases
`);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(current), true);
  assert.equal(existsSync(previous), true);
  assert.equal(existsSync(other), false);
});

test("cleanup refuses a releases directory that resolves through a symlink", linuxOnly, async t => {
  const f = await fixture(t);
  const external = join(f.root, "external");
  await mkdir(external);
  const protectedRelease = join(external, "aaaaaaaaaaaa-TEST0001");
  await mkdir(protectedRelease);
  await writeFile(join(protectedRelease, ".install-owned"), "");
  await rm(join(f.base, "releases"), { recursive: true });
  await symlink(external, join(f.base, "releases"));
  const result = await f.run("prune_releases");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(protectedRelease), true);
});

test("cache reclamation preserves protected data, source and runtime caches", linuxOnly, async t => {
  const f = await fixture(t);
  const plain = await f.release(1);
  const data = await f.release(2);
  const source = await f.release(3);
  const linked = await f.release(4);
  const outside = join(f.root, "external-cache");
  for (const path of [
    join(plain, ".next/cache/webpack"), join(plain, ".next/cache/images"), join(plain, ".next/cache/fetch-cache"),
    join(data, ".next/cache/webpack/records"), join(source, ".next/cache/webpack/source"),
    join(linked, ".next/cache"), outside,
    ...["_cacache", "_logs", "_npx"].map(name => join(f.root, "npm-cache", name)),
  ]) await mkdir(path, { recursive: true });
  await writeFile(join(outside, "preserve"), "external cache target");
  await symlink(outside, join(linked, ".next/cache/webpack"));
  const result = await f.run(`
storage_current="$fixture_root/npm-cache/_cacache/keep"
storage_running="$fixture_root/npm-cache/_logs/keep"
storage_data_dir="$base/releases/${data.split("/").at(-1)}/.next/cache/webpack/records"
source_dir="$base/releases/${source.split("/").at(-1)}/.next/cache/webpack/source"
reclaim_caches
`);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(join(plain, ".next/cache/webpack")), false);
  assert.equal(existsSync(join(f.root, "npm-cache/_npx")), false);
  for (const path of [
    join(plain, ".next/cache/images"), join(plain, ".next/cache/fetch-cache"),
    join(data, ".next/cache/webpack/records"), join(source, ".next/cache/webpack/source"),
    join(f.root, "npm-cache/_cacache"), join(f.root, "npm-cache/_logs"),
  ]) assert.equal(existsSync(path), true, `Runtime or protected cache must remain: ${path}`);
  assert.equal(await readFile(join(outside, "preserve"), "utf8"), "external cache target");
  assert.ok((await readdir(f.base)).includes("releases"));
});

test("cache reclamation never deletes descendants of a configured data root", linuxOnly, async t => {
  const f = await fixture(t);
  const release = await f.release(1);
  const npmRoot = join(f.root, "npm-cache");
  const releaseCache = join(release, ".next/cache");
  for (const path of [join(npmRoot, "_cacache"), join(npmRoot, "_logs"), join(npmRoot, "_npx"), join(releaseCache, "webpack")]) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "data-sentinel"), "configured data must remain");
  }
  const npmResult = await f.run(`
storage_data_dir="$fixture_root/npm-cache"
source_dir="$base/releases/${release.split("/").at(-1)}/.next/cache/webpack"
reclaim_caches
`);
  assert.equal(npmResult.code, 0, npmResult.stderr);
  for (const name of ["_cacache", "_logs", "_npx"]) {
    assert.equal(await readFile(join(npmRoot, name, "data-sentinel"), "utf8"), "configured data must remain");
  }
  const releaseResult = await f.run(`
storage_data_dir="$base/releases/${release.split("/").at(-1)}/.next/cache"
reclaim_caches
`);
  assert.equal(releaseResult.code, 0, releaseResult.stderr);
  assert.equal(await readFile(join(releaseCache, "webpack/data-sentinel"), "utf8"), "configured data must remain");
});

test("capacity checks retry after reclaim and reject insufficient bytes or inodes", linuxOnly, async t => {
  const f = await fixture(t);
  for (const scenario of [
    { bytes: 10, inodes: "10000", reclaimed: 10, status: 1, message: /空间不足/ },
    { bytes: 10000, inodes: "10", reclaimed: 10000, status: 1, message: /inode不足/ },
    { bytes: 10, inodes: "10000", reclaimed: 10000, status: 0 },
    { bytes: 10000, inodes: "-", reclaimed: 10000, status: 0 },
  ]) {
    const result = await f.run(`
available=${scenario.bytes}
df() {
  if [[ "$*" == *-Pi* ]]; then
    printf 'Filesystem Inodes IUsed IFree Use%% Mounted\\nfixture 100000 1 ${scenario.inodes} 1%% /\\n'
  else
    printf 'Filesystem Blocks Used Available Use%% Mounted\\nfixture 100000 1 %s 1%% /\\n' "$available"
  fi
}
reclaim_caches() { available=${scenario.reclaimed}; printf 'reclaim attempted\\n'; }
require_space "$fixture_root/nonexistent/nested" 1000 1000
`);
    assert.equal(result.code, scenario.status, result.stderr);
    if (scenario.message) assert.match(result.stderr, scenario.message);
    if (scenario.bytes < 1000 || Number(scenario.inodes) < 1000) assert.match(result.stdout, /reclaim attempted/);
  }
});
