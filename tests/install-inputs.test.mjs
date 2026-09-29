import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { dependencyKey, installKeys, validBuild, storedSizes } from "../deploy/install-inputs.mjs";

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
  for (const manifest of [{ dependencies: { fixture: "file:./fixture" } }, ...["postinstall", "prepublish", "preprepare", "postprepare"].map(name => ({ scripts: { [name]: "node scripts/setup.mjs" } })), { workspaces: ["packages/*"] }]) {
    const directory = fixture(t, manifest);
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

test("documentation and tests do not change deployment keys or claim a new artifact", t => {
  const directory = fixture(t);
  write(directory, "app/page.tsx", "export default function Page() { return null; }");
  const original = installKeys(directory, environment, {});
  for (const name of ["README.md", "docs/deployment.md", "tests/new.test.mjs", ".github/workflows/verify.yml"]) write(directory, name, "changed");
  assert.deepEqual(installKeys(directory, { ...environment, sourceId: "docs-commit" }, {}), original);
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
