import { createHash } from "node:crypto";
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
    devDependencies: { typescript: "5.9.3", vite: "8.0.0", "@vitejs/plugin-react": "6.0.0", eslint: "9.0.0" },
    scripts: { "build:linux": "node scripts/build.mjs", build: "vite build" },
    ...extra,
  });
  return directory;
}

test("Linux keys omit unrelated root development dependencies, scripts and Sites tool files", t => {
  const directory = linuxFixture(t);
  const original = installKeys(directory, environment, {});
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  manifest.devDependencies.eslint = "9.0.1";
  manifest.scripts.build = "vite build --mode sites";
  write(directory, "package.json", JSON.stringify(manifest));
  write(directory, "package-lock.json", JSON.stringify(lockFor(manifest)));
  for (const name of ["drizzle.config.ts", "cloudflare-env.d.ts", "build/sites-vite-plugin.ts", "db/schema.ts"]) write(directory, name, "// changed Sites input");
  assert.deepEqual(installKeys(directory, { ...environment, sourceId: "sites-commit" }, {}), original);
});

test("Linux selected production, build dependencies and locked package versions invalidate all keys", t => {
  for (const [field, name] of [["dependencies", "runtime"], ["devDependencies", "typescript"], ["devDependencies", "vite"], ["devDependencies", "@vitejs/plugin-react"]]) {
    const directory = linuxFixture(t);
    const original = installKeys(directory, environment, {});
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    manifest[field][name] = "9.0.0";
    writeLinuxProfile(directory, manifest);
    const updated = installKeys(directory, environment, {});
    for (const key of ["dependencies", "runtime", "build"]) assert.notEqual(updated[key], original[key], `${name}: ${key}`);
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

test("Linux Vite, TypeScript, runtime metadata and build recipes remain build inputs", t => {
  const directory = linuxFixture(t);
  let previous = installKeys(directory, environment, {});
  for (const name of ["vite.config.ts", "index.html", "web/entry-client.tsx", "web/entry-server.tsx", "tsconfig.json", "tsconfig.linux.json", "postcss.config.mjs"]) {
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

test("Linux independent service imports affect runtime until SSR references the entry", t => {
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

test("SSR and shared-library imports rebuild while independent server entries reuse the build", t => {
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
  write(directory, "server/linux.mjs", 'console.log("now imported by SSR");');
  assert.notEqual(installKeys(directory, environment, {}).build, before.build);
});

test("lock, runtime and public build environment invalidate the appropriate content keys", t => {
  const directory = fixture(t);
  const before = installKeys(directory, environment, {});
  const envChanged = installKeys(directory, environment, { VITE_INSTALL_TEST: "changed" });
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

function artifactFixture(t) {
  const directory = fixture(t);
  const manifest = {
    "index.html": { file: "assets/client.js", isEntry: true, imports: ["_shared.js"], dynamicImports: ["web/panel.tsx"], css: ["assets/main.css"], assets: ["assets/logo.svg"] },
    "_shared.js": { file: "assets/shared.js" },
    "web/panel.tsx": { file: "assets/panel.js", imports: ["_shared.js"] },
  };
  const files = {
    "client/index.html": "<div id=app></div>",
    "client/.vite/manifest.json": JSON.stringify(manifest),
    "client/assets/client.js": "import './shared.js'; import('./panel.js');",
    "client/assets/shared.js": "export const value = 1;",
    "client/assets/panel.js": "export default {};",
    "client/assets/main.css": "body { color: black }",
    "client/assets/logo.svg": "<svg/>",
    "server/entry-server.js": "export function render() { return ''; }",
    "server/chunks/page.js": "export default {};",
  };
  const inventory = { schemaVersion: 1, files: {} };
  function save(name, value) {
    write(directory, `dist/${name}`, value);
    inventory.files[name] = createHash("sha256").update(value).digest("hex");
  }
  function seal() { write(directory, "dist/build-manifest.json", JSON.stringify(inventory)); }
  for (const [name, value] of Object.entries(files)) save(name, value);
  seal();
  return { directory, manifest, inventory, save, seal };
}

test("artifact validation hashes every client and SSR file before reuse", t => {
  const f = artifactFixture(t);
  assert.equal(validBuild(f.directory), true);
  for (const name of ["client/assets/panel.js", "server/chunks/page.js", "client/index.html"]) {
    const original = readFileSync(join(f.directory, "dist", name));
    write(f.directory, `dist/${name}`, "damaged");
    assert.equal(validBuild(f.directory), false, name);
    write(f.directory, `dist/${name}`, original);
    assert.equal(validBuild(f.directory), true);
  }
  write(f.directory, "dist/server/unlisted.js", "unlisted");
  assert.equal(validBuild(f.directory), false, "Unlisted output must not enter a reused release");
});

test("artifact validation checks static, lazy, CSS and asset reference closure", t => {
  for (const field of ["file", "imports", "dynamicImports", "css", "assets"]) {
    const f = artifactFixture(t);
    f.manifest["index.html"][field] = field === "file" ? "assets/absent.js" : ["absent"];
    f.save("client/.vite/manifest.json", JSON.stringify(f.manifest)); f.seal();
    assert.equal(validBuild(f.directory), false, field);
  }
  for (const name of ["client/assets/panel.js", "server/entry-server.js", "client/.vite/manifest.json"]) {
    const f = artifactFixture(t);
    rmSync(join(f.directory, "dist", name));
    delete f.inventory.files[name]; f.seal();
    assert.equal(validBuild(f.directory), false, name);
  }
});

test("artifact validation rejects traversals, malformed inventories and symlinked trees", t => {
  for (const path of ["../outside.js", "/outside.js", "assets/../client.js", "assets\\client.js", "C:/outside.js"]) {
    const f = artifactFixture(t);
    f.manifest["index.html"].file = path;
    f.save("client/.vite/manifest.json", JSON.stringify(f.manifest)); f.seal();
    assert.equal(validBuild(f.directory), false, path);
  }
  for (const inventory of [{ schemaVersion: 2, files: {} }, { schemaVersion: 1, files: { "../outside.js": "0".repeat(64) } }, null]) {
    const f = artifactFixture(t);
    write(f.directory, "dist/build-manifest.json", JSON.stringify(inventory));
    assert.equal(validBuild(f.directory), false);
  }
  const f = artifactFixture(t);
  const outside = join(f.directory, "outside");
  mkdirSync(outside);
  rmSync(join(f.directory, "dist/server/chunks"), { recursive: true });
  write(f.directory, "outside/page.js", "export default {};");
  symlinkSync(outside, join(f.directory, "dist/server/chunks"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(validBuild(f.directory), false, "Even a matching hash cannot authorize linked output");
});

test("generated type-check cache and old framework output do not affect content keys", t => {
  const directory = fixture(t);
  const original = installKeys(directory, environment, {});
  for (const name of [".build-cache/tsconfig.tsbuildinfo", "dist/server/entry-server.js", ".next/BUILD_ID"]) write(directory, name, "generated");
  assert.deepEqual(installKeys(directory, environment, {}), original);
  assert.notEqual(installKeys(directory, environment, { MONITOR_BUILD_TEST: "changed" }).build, original.build);
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
