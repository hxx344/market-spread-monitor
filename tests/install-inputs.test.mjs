import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { dependencyKey, installKeys, validBuild, storedSizes } from "../deploy/install-inputs.mjs";
import { createLinuxManifest } from "../deploy/linux-dependencies.mjs";

const environment = { sourceId: "source-a", nodeVersion: "v24.15.0", npmVersion: "11.11.0", architecture: "x64" };
function fixture(t, manifest = {}) {
  const directory = mkdtempSync(join(tmpdir(), "monitor-dependency-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(directory, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
  return directory;
}

test("ordinary source changes reuse dependency inputs, while lock/npmrc/runtime changes invalidate them", t => {
  const directory = fixture(t);
  const key = dependencyKey(directory, environment);
  assert.equal(dependencyKey(directory, { ...environment, sourceId: "source-b" }), key);
  for (const field of ["nodeVersion", "npmVersion", "architecture"]) assert.notEqual(dependencyKey(directory, { ...environment, [field]: "different" }), key);
  writeFileSync(join(directory, ".npmrc"), "ignore-scripts=true\n");
  assert.notEqual(dependencyKey(directory, environment), key);
  const withConfig = dependencyKey(directory, environment);
  writeFileSync(join(directory, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  assert.notEqual(dependencyKey(directory, environment), withConfig);
});

test("local dependency and install lifecycle inputs cannot reuse dependencies across source changes", t => {
  for (const manifest of [
    ...["file:./fixture", "C:\\fixture", "git+file:///tmp/fixture", "~/fixture"].map(value => ({ dependencies: { fixture: value } })),
    { peerDependencies: { fixture: "../fixture" } },
    { dependencies: { fixture: "file:./fixture" }, devDependencies: { fixture: "1.0.0" } },
    ...["postinstall", "prepublish", "preprepare", "postprepare"].map(name => ({ scripts: { [name]: "node scripts/setup.mjs" } })),
    { workspaces: ["packages/*"] }, { bundledDependencies: ["fixture"] },
  ]) {
    const directory = fixture(t, manifest);
    assert.notEqual(dependencyKey(directory, environment), dependencyKey(directory, { ...environment, sourceId: "source-b" }));
  }
  for (const name of ["binding.gyp", "patches/example.patch"]) {
    const directory = fixture(t);
    write(directory, name, "implicit installation input");
    assert.notEqual(dependencyKey(directory, environment), dependencyKey(directory, { ...environment, sourceId: "source-b" }));
  }
});

test("configuration is validated before a running service can be restarted", () => {
  const base = { ...process.env, ALERT_DATA_DIR: tmpdir(), APP_PASSWORD: "test-password-at-least-12", APP_USERNAME: "admin", PORT: "3000", OIL_POLL_INTERVAL_SECONDS: "30", OIL_FEISHU_WEBHOOK_URL: "" };
  const check = env => spawnSync(process.execPath, ["deploy/check-install.mjs", "--config-only"], { env: { ...base, ...env }, encoding: "utf8" });
  assert.equal(check({}).status, 0);
  for (const env of [{ APP_PASSWORD: "short" }, { PORT: "65536" }, { APP_USERNAME: "bad:name" }, { OIL_POLL_INTERVAL_SECONDS: "0" }, { ALERT_DATA_DIR: "relative" }, { OIL_FEISHU_WEBHOOK_URL: "https://example.com/hook" }]) {
    const result = check(env);
    assert.notEqual(result.status, 0);
    assert.ok(!result.stderr.includes(base.APP_PASSWORD));
  }
});

function write(directory, name, text) {
  mkdirSync(join(directory, name, ".."), { recursive: true });
  writeFileSync(join(directory, name), text);
}

function lockFor(manifest) {
  const entry = Object.fromEntries(["name", "version", "dependencies", "devDependencies", "engines"].filter(name => manifest[name] !== undefined).map(name => [name, manifest[name]]));
  const packages = { "": entry };
  for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) packages[`node_modules/${name}`] = { version };
  return { lockfileVersion: 3, packages };
}

function writeLinuxProfile(directory, manifest) {
  const linux = createLinuxManifest(manifest);
  write(directory, "package.json", JSON.stringify(manifest));
  write(directory, "package-lock.json", JSON.stringify(lockFor(manifest)));
  write(directory, "deploy/linux/package.json", JSON.stringify(linux));
  write(directory, "deploy/linux/package-lock.json", JSON.stringify(lockFor(linux)));
}

function linuxFixture(t, extra = {}) {
  const directory = fixture(t);
  writeLinuxProfile(directory, {
    name: "fixture",
    version: "1.0.0",
    private: true,
    type: "module",
    dependencies: { runtime: "1.0.0" },
    devDependencies: { typescript: "5.9.3", vite: "8.0.0" },
    scripts: { "build:linux": "next build --webpack", build: "vite build" },
    ...extra,
  });
  return directory;
}

test("Linux keys omit unrelated root development dependencies, scripts and Sites tool files", t => {
  const directory = linuxFixture(t);
  const original = installKeys(directory, environment, {});
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  manifest.devDependencies.vite = "8.0.1";
  manifest.scripts.build = "vite build --mode sites";
  write(directory, "package.json", JSON.stringify(manifest));
  write(directory, "package-lock.json", JSON.stringify(lockFor(manifest)));
  for (const name of ["vite.config.ts", "drizzle.config.ts", "cloudflare-env.d.ts", "build/sites-vite-plugin.ts", "db/schema.ts"]) write(directory, name, "// changed Sites input");
  assert.deepEqual(installKeys(directory, { ...environment, sourceId: "sites-commit" }, {}), original);
});

test("Linux selected production, build dependencies and locked package versions invalidate all keys", t => {
  for (const field of ["dependencies", "devDependencies"]) {
    const directory = linuxFixture(t);
    const original = installKeys(directory, environment, {});
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    manifest[field][field === "dependencies" ? "runtime" : "typescript"] = "9.0.0";
    writeLinuxProfile(directory, manifest);
    const updated = installKeys(directory, environment, {});
    for (const key of ["dependencies", "runtime", "build"]) assert.notEqual(updated[key], original[key], `${field}: ${key}`);
  }
  const directory = linuxFixture(t);
  const original = installKeys(directory, environment, {});
  for (const name of ["package-lock.json", "deploy/linux/package-lock.json"]) {
    const lock = JSON.parse(readFileSync(join(directory, name), "utf8"));
    lock.packages["node_modules/runtime"].integrity = "sha512-changed";
    write(directory, name, JSON.stringify(lock));
  }
  const updated = installKeys(directory, environment, {});
  for (const key of ["dependencies", "runtime", "build"]) assert.notEqual(updated[key], original[key], key);
});

test("Linux Next, TypeScript, runtime metadata and build recipes remain build inputs", t => {
  const directory = linuxFixture(t);
  let previous = installKeys(directory, environment, {});
  for (const name of ["next.config.ts", "tsconfig.json", "tsconfig.linux.json", "postcss.config.mjs"]) {
    write(directory, name, "// changed relevant input");
    const updated = installKeys(directory, environment, {});
    assert.equal(updated.dependencies, previous.dependencies, name);
    assert.notEqual(updated.build, previous.build, name);
    previous = updated;
  }
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  for (const script of ["prebuild:linux", "build:linux", "postbuild:linux"]) {
    manifest.scripts[script] = "node tests/build-fixture.mjs";
    write(directory, "package.json", JSON.stringify(manifest));
    const updated = installKeys(directory, environment, {});
    assert.equal(updated.dependencies, previous.dependencies, script);
    assert.notEqual(updated.build, previous.build, script);
    previous = updated;
  }
  manifest.imports = { "#linux-data": "./db/metadata.ts" };
  write(directory, "package.json", JSON.stringify(manifest));
  write(directory, "db/metadata.ts", "export const value = 1;");
  const metadataChanged = installKeys(directory, environment, {});
  assert.equal(metadataChanged.dependencies, previous.dependencies);
  assert.notEqual(metadataChanged.build, previous.build);
  write(directory, "db/metadata.ts", "export const value = 2;");
  assert.notEqual(installKeys(directory, environment, {}).build, metadataChanged.build);
});

test("Linux ignored files are promoted transitively when application code references them", t => {
  const directory = linuxFixture(t);
  write(directory, "app/page.tsx", 'import "../build/bridge";');
  write(directory, "build/bridge.ts", 'import "../db/used";');
  write(directory, "db/used.ts", "export const value = 1;");
  const original = installKeys(directory, environment, {});
  write(directory, "db/used.ts", "export const value = 2;");
  const updated = installKeys(directory, environment, {});
  assert.equal(updated.dependencies, original.dependencies);
  assert.notEqual(updated.runtime, original.runtime);
  assert.notEqual(updated.build, original.build);
});

test("Linux delegated npm build recipes retain other scripts and their file inputs", t => {
  const scripts = { "build:linux": "npm run actual-build", "actual-build": "node tests/actual-build.mjs" };
  const directory = linuxFixture(t, { scripts });
  write(directory, "tests/actual-build.mjs", "// first build implementation");
  const original = installKeys(directory, environment, {});
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  manifest.scripts["actual-build"] += " --production";
  write(directory, "package.json", JSON.stringify(manifest));
  const changedRecipe = installKeys(directory, environment, {});
  assert.equal(changedRecipe.dependencies, original.dependencies);
  assert.notEqual(changedRecipe.build, original.build);
  write(directory, "tests/actual-build.mjs", "// changed build implementation");
  assert.notEqual(installKeys(directory, environment, {}).build, changedRecipe.build);
});

test("Linux explicit root manifest and lock imports hash their original contents", t => {
  for (const name of ["package.json", "package-lock.json"]) {
    const directory = linuxFixture(t);
    write(directory, "app/page.tsx", `import data from "../${name}";`);
    const original = installKeys(directory, environment, {});
    writeFileSync(join(directory, name), `${readFileSync(join(directory, name), "utf8")}\n`);
    const updated = installKeys(directory, environment, {});
    assert.equal(updated.dependencies, original.dependencies, name);
    assert.notEqual(updated.runtime, original.runtime, name);
    assert.notEqual(updated.build, original.build, name);
  }
});

test("Linux independent service imports affect runtime until Next references the entry", t => {
  const directory = linuxFixture(t);
  write(directory, "server/linux.mjs", 'import "../db/used.ts";');
  write(directory, "db/used.ts", "export const value = 1;");
  const original = installKeys(directory, environment, {});
  write(directory, "db/used.ts", "export const value = 2;");
  const updated = installKeys(directory, environment, {});
  assert.notEqual(updated.runtime, original.runtime);
  assert.equal(updated.build, original.build);
  write(directory, "app/page.tsx", 'import "../server/linux.mjs";');
  const imported = installKeys(directory, environment, {});
  write(directory, "db/used.ts", "export const value = 3;");
  assert.notEqual(installKeys(directory, environment, {}).build, imported.build);
});

test("documentation and tests do not change deployment keys or claim a new artifact", t => {
  const directory = fixture(t);
  write(directory, "app/page.tsx", "export default function Page() { return null; }");
  const original = installKeys(directory, environment, {});
  for (const name of ["README.md", "docs/deployment.md", "tests/new.test.mjs", ".github/workflows/verify.yml"]) write(directory, name, "changed");
  assert.deepEqual(installKeys(directory, { ...environment, sourceId: "docs-commit" }, {}), original);
});

test("installed runtime directory links are excluded before file hashing", t => {
  const directory = fixture(t);
  const target = join(directory, "runtime-target");
  mkdirSync(target);
  const original = installKeys(directory, environment, {});
  symlinkSync(target, join(directory, ".runtime"), process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(installKeys(directory, environment, {}), original);
});

test("Next server and shared-library imports rebuild while independent server entries reuse the build", t => {
  const directory = fixture(t);
  write(directory, "app/api/hub/route.ts", 'import { summary } from "../../../server/hub-summary.mjs";');
  write(directory, "server/hub-summary.mjs", 'export const summary = "first";');
  write(directory, "server/linux.mjs", 'console.log("server first");');
  write(directory, "lib/backend.ts", 'export const backend = 1;');
  let before = installKeys(directory, environment, {});
  write(directory, "server/linux.mjs", 'console.log("server changed");');
  let after = installKeys(directory, environment, {});
  assert.notEqual(after.runtime, before.runtime);
  assert.equal(after.build, before.build);
  assert.equal(after.dependencies, before.dependencies);
  for (const name of ["server/hub-summary.mjs", "lib/backend.ts"]) {
    before = after;
    write(directory, name, 'export const changed = true;');
    after = installKeys(directory, environment, {});
    assert.notEqual(after.build, before.build);
  }
  write(directory, "lib/backend.ts", 'import "../server/linux.mjs";');
  before = installKeys(directory, environment, {});
  write(directory, "server/linux.mjs", 'console.log("now imported by Next");');
  assert.notEqual(installKeys(directory, environment, {}).build, before.build);
});

test("lock, runtime and public build environment invalidate the appropriate content keys", t => {
  const directory = fixture(t);
  const before = installKeys(directory, environment, {});
  const envChanged = installKeys(directory, environment, { NEXT_PUBLIC_INSTALL_TEST: "changed" });
  assert.equal(envChanged.dependencies, before.dependencies);
  assert.equal(envChanged.runtime, before.runtime);
  assert.notEqual(envChanged.build, before.build);
  for (const field of ["nodeVersion", "npmVersion", "architecture"]) {
    const changed = installKeys(directory, { ...environment, [field]: "changed" }, {});
    for (const key of ["dependencies", "runtime", "build"]) assert.notEqual(changed[key], before[key]);
  }
  write(directory, "package-lock.json", '{"lockfileVersion":3,"packages":{}}');
  for (const key of ["dependencies", "runtime", "build"]) assert.notEqual(installKeys(directory, environment, {})[key], before[key]);
});

test("an explicitly used build script stays in the fingerprint even under tests", t => {
  const directory = fixture(t, { scripts: { "build:linux": "node tests/build-fixture.mjs" } });
  write(directory, "tests/build-fixture.mjs", "// original");
  const before = installKeys(directory, environment, {});
  write(directory, "tests/build-fixture.mjs", "// changed build recipe");
  assert.notEqual(installKeys(directory, environment, {}).build, before.build);
});

test("public document-like assets and production dotenv files remain actual build inputs", t => {
  const directory = fixture(t);
  let previous = installKeys(directory, environment, {});
  for (const name of ["public/README.md", "public/docs/guide.md", "public/tests/asset.json", "public/.env-example", ".env.production", ".env.production.local"]) {
    write(directory, name, "changed");
    const updated = installKeys(directory, environment, {});
    assert.notEqual(updated.runtime, previous.runtime, name);
    assert.notEqual(updated.build, previous.build, name);
    previous = updated;
  }
});

test("artifact validation detects incomplete and damaged manifests before build reuse", t => {
  const directory = fixture(t);
  assert.equal(validBuild(directory), false);
  write(directory, ".next/BUILD_ID", "fixture");
  write(directory, ".next/build-manifest.json", "{}");
  write(directory, ".next/required-server-files.json", "{}");
  write(directory, ".next/server/app-paths-manifest.json", '{"/page":"app/page.js"}');
  assert.equal(validBuild(directory), false);
  write(directory, ".next/server/app/page.js", "export default {};");
  assert.equal(validBuild(directory), true);
  write(directory, ".next/server/app-paths-manifest.json", '{"/page":"../../outside.js"}');
  assert.equal(validBuild(directory), false);
  write(directory, ".next/server/app-paths-manifest.json", "malformed");
  assert.equal(validBuild(directory), false);
});

test("cached storage measurements require matching dependency and build keys", t => {
  const directory = fixture(t);
  write(directory, ".install-dependencies", "deps\n");
  write(directory, ".install-build", "build\n");
  const sizes = { dependencies: "deps", build: "build", dependencyKB: 100, dependencyInodes: 10, buildKB: 20, buildInodes: 5 };
  write(directory, ".install-storage.json", JSON.stringify(sizes));
  assert.deepEqual(storedSizes(directory), [100, 10, 20, 5]);
  write(directory, ".install-build", "different");
  assert.equal(storedSizes(directory), null);
  write(directory, ".install-build", "build");
  write(directory, ".install-storage.json", JSON.stringify({ ...sizes, dependencyInodes: -1 }));
  assert.equal(storedSizes(directory), null);
});
