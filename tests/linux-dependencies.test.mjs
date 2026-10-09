import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLinuxManifest, LINUX_BUILD_DEPENDENCIES, selectDependencyProfile } from "../deploy/linux-dependencies.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value));
const sourceManifest = readJson(join(root, "package.json"));
const sourceLock = readJson(join(root, "package-lock.json"));

function fixture(t, { profile = true, marker = true } = {}) {
  const prefix = join(tmpdir(), "monitor-linux-dependencies-test-");
  const directory = mkdtempSync(prefix);
  t.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(resolve(directory).startsWith(resolve(prefix)));
    rmSync(directory, { recursive: true, force: true });
  });
  writeJson(join(directory, "package.json"), sourceManifest);
  writeJson(join(directory, "package-lock.json"), sourceLock);
  mkdirSync(join(directory, "deploy/linux"), { recursive: true });
  if (marker) writeFileSync(join(directory, "deploy/linux-dependencies.mjs"), "");
  if (profile) {
    for (const name of ["package.json", "package-lock.json"]) {
      writeFileSync(join(directory, "deploy/linux", name), readFileSync(join(root, "deploy/linux", name)));
    }
  }
  return directory;
}

test("Linux profile includes runtime dependencies and the Vite/TypeScript build closure", () => {
  const profile = selectDependencyProfile(root);
  assert.equal(profile.kind, "linux-v1");
  assert.ok(isAbsolute(profile.manifestPath));
  assert.ok(isAbsolute(profile.lockPath));
  assert.deepEqual(profile.manifest.dependencies, sourceManifest.dependencies);
  assert.deepEqual(Object.keys(profile.manifest.devDependencies).sort(), [...LINUX_BUILD_DEPENDENCIES].sort());
  for (const [name, version] of Object.entries(profile.manifest.devDependencies)) assert.equal(version, sourceManifest.devDependencies[name]);
  assert.equal(profile.manifest.scripts, undefined);
  assert.equal(profile.manifest.devDependencies["react-server-dom-webpack"], undefined);
  const packages = readJson(profile.lockPath).packages;
  for (const name of ["next", "vinext", "wrangler", "eslint", "eslint-config-next", "drizzle-kit", "react-server-dom-webpack", "@cloudflare/vite-plugin", "@vitejs/plugin-rsc"]) {
    assert.ok(!packages[`node_modules/${name}`], `${name} must not remain in the Linux closure`);
  }
});

test("ordinary scripts and unrelated dev changes do not invalidate the Linux profile", t => {
  const directory = fixture(t);
  const manifest = readJson(join(directory, "package.json"));
  manifest.scripts["build:linux"] = "node tests/fixture-build.mjs";
  manifest.scripts.lint = "different lint command";
  manifest.devDependencies.eslint = "99.0.0";
  manifest.devDependencies["new-development-tool"] = "1.0.0";
  writeJson(join(directory, "package.json"), manifest);
  assert.equal(selectDependencyProfile(directory).kind, "linux-v1");
});

test("selected dependencies and installation metadata cannot silently drift", t => {
  for (const mutate of [
    manifest => { manifest.dependencies.react = "99.0.0"; },
    manifest => { manifest.devDependencies.vite = "99.0.0"; },
    manifest => { delete manifest.dependencies.ws; },
    manifest => { manifest.dependencies["new-runtime"] = "1.0.0"; },
    manifest => { manifest.devDependencies.typescript = "99.0.0"; },
    manifest => { manifest.engines.node = ">=99"; },
    manifest => { manifest.overrides = { react: "99.0.0" }; },
  ]) {
    const directory = fixture(t);
    const manifest = readJson(join(directory, "package.json"));
    mutate(manifest);
    writeJson(join(directory, "package.json"), manifest);
    assert.throws(() => selectDependencyProfile(directory), /out of date/);
  }
});

test("root and generated lock declarations and selected resolutions must agree", t => {
  for (const [file, mutate] of [
    ["package-lock.json", lock => { lock.packages[""].dependencies.react = "99.0.0"; }],
    ["package-lock.json", lock => { lock.packages["node_modules/react"].version = "99.0.0"; }],
    ["package-lock.json", lock => {
      lock.packages["node_modules/unused/node_modules/scheduler"] = { ...lock.packages["node_modules/scheduler"] };
      lock.packages["node_modules/scheduler"].version = "99.0.0";
    }],
    ["deploy/linux/package-lock.json", lock => { lock.packages[""].devDependencies.typescript = "99.0.0"; }],
    ["deploy/linux/package-lock.json", lock => { lock.packages["node_modules/react"].version = "99.0.0"; }],
    ["deploy/linux/package-lock.json", lock => { lock.packages["node_modules/clsx"].integrity = "changed"; }],
    ["deploy/linux/package-lock.json", lock => { delete lock.packages["node_modules/ws"]; }],
  ]) {
    const directory = fixture(t);
    const path = join(directory, file);
    const lock = readJson(path);
    mutate(lock);
    writeJson(path, lock);
    assert.throws(() => selectDependencyProfile(directory), /out of date/);
  }
});

test("an unconfigured tiny project falls back, while configured projects require both generated files", t => {
  const unconfigured = fixture(t, { profile: false, marker: false });
  assert.equal(selectDependencyProfile(unconfigured).kind, "root-v1");
  const missing = fixture(t, { profile: false });
  assert.throws(() => selectDependencyProfile(missing), /both required/);
  for (const missingName of ["package.json", "package-lock.json"]) {
    const directory = fixture(t, { marker: false });
    rmSync(join(directory, "deploy/linux", missingName));
    assert.throws(() => selectDependencyProfile(directory), /both required/);
  }
});

test("every root installation lifecycle falls back with the complete original manifest", t => {
  for (const name of ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"]) {
    const directory = fixture(t, { profile: false });
    const manifest = readJson(join(directory, "package.json"));
    manifest.scripts[name] = "node scripts/setup.mjs";
    writeJson(join(directory, "package.json"), manifest);
    const profile = selectDependencyProfile(directory);
    assert.equal(profile.kind, "root-v1");
    assert.deepEqual(profile.manifest, manifest);
    assert.equal(profile.manifestPath, join(directory, "package.json"));
    assert.equal(profile.lockPath, join(directory, "package-lock.json"));
    assert.match(profile.reason, new RegExp(name));
  }
});

test("local dependency formats, workspaces, patches and native root builds retain the complete installation", t => {
  const mutations = [
    ...["file:./fixture", "git+file:./fixture", "link:../fixture", "workspace:*", "./fixture", "../fixture", "~/fixture", "/tmp/fixture", "C:\\fixture"].map(value => manifest => { manifest.dependencies.fixture = value; }),
    manifest => { manifest.devDependencies.fixture = "file:./fixture"; },
    manifest => { manifest.optionalDependencies = { fixture: "file:./fixture" }; },
    manifest => { manifest.workspaces = ["packages/*"]; },
    manifest => { manifest.bundledDependencies = ["ws"]; },
    (_manifest, directory) => mkdirSync(join(directory, "patches")),
    (_manifest, directory) => writeFileSync(join(directory, "binding.gyp"), "{}"),
  ];
  for (const mutate of mutations) {
    const directory = fixture(t, { profile: false });
    const manifest = readJson(join(directory, "package.json"));
    mutate(manifest, directory);
    writeJson(join(directory, "package.json"), manifest);
    const profile = selectDependencyProfile(directory);
    assert.equal(profile.kind, "root-v1");
    assert.deepEqual(profile.manifest, manifest);
    assert.ok(profile.reason);
  }
});

test("generated closure keeps the root lock versions and all supported native optional variants", () => {
  const lock = readJson(join(root, "deploy/linux/package-lock.json"));
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    assert.ok(sourceLock.packages[path], `${path} was not in the root lock`);
    for (const field of ["version", "resolved", "integrity", "os", "cpu", "libc"]) {
      assert.deepEqual(entry[field], sourceLock.packages[path][field], `${path} ${field} changed`);
    }
  }
  const nativeVariants = Object.keys(sourceLock.packages).filter(path => /^node_modules\/(?:@rolldown\/binding-|@oxc-parser\/binding-|@oxc-transform\/binding-|@tailwindcss\/oxide-|lightningcss-)/.test(path));
  assert.ok(nativeVariants.some(path => path.includes("linux-arm64")));
  assert.ok(nativeVariants.some(path => path.includes("linux-x64")));
  for (const path of nativeVariants) assert.ok(lock.packages[path], `${path} was lost when pruning on the host platform`);
  assert.ok(Object.keys(lock.packages).length < Object.keys(sourceLock.packages).length);
});

test("Linux manifest preserves optional peers and npm installation metadata without copying arbitrary scripts", () => {
  const input = {
    name: "example", version: "1.0.0", type: "module", private: false,
    dependencies: { runtime: "1.0.0" }, devDependencies: { typescript: "5.9.3", unrelated: "1.0.0" },
    optionalDependencies: { native: "1.0.0" }, peerDependencies: { optional: "1.0.0" }, peerDependenciesMeta: { optional: { optional: true } },
    engines: { node: ">=22" }, overrides: { runtime: "$runtime" }, os: ["linux"], cpu: ["x64"], scripts: { build: "ignored" },
  };
  const manifest = createLinuxManifest(input);
  for (const field of ["optionalDependencies", "peerDependencies", "peerDependenciesMeta", "engines", "overrides", "os", "cpu", "type"]) assert.deepEqual(manifest[field], input[field]);
  assert.equal(manifest.private, true);
  assert.equal(manifest.scripts, undefined);
  assert.deepEqual(manifest.devDependencies, { typescript: "5.9.3" });
});

test("profile CLI prints only the selected kind and needs no installed dependencies", t => {
  const directory = fixture(t);
  assert.ok(!existsSync(join(directory, "node_modules")));
  const result = spawnSync(process.execPath, [join(root, "deploy/linux-dependencies.mjs"), directory, "--kind"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "linux-v1");
  assert.equal(result.stderr, "");
});
