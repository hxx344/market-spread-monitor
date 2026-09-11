import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { dependencyKey } from "../deploy/install-inputs.mjs";

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
