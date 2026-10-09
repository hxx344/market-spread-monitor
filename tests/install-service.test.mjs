import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const linuxOnly = { skip: process.platform !== "linux" };
const installer = await readFile(new URL("../deploy/install.sh", import.meta.url), "utf8");
const entrypoint = installer.lastIndexOf("\nif (( EUID != 0 )); then");
assert.ok(entrypoint > 0, "Service tests load functions without invoking installation");
const service = "market-spread-monitor.service";
const readReloadState = `show --property=NeedDaemonReload --value ${service}`;
const readEnabledState = `is-enabled ${service}`;

async function invoke(t, action, { changed = 0, needReload = "no", showStatus = 0, reloadStatus = 0, enabledStatus = 0, enableStatus = 0, enabledState = "enabled" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "market-spread-service-test-"));
  const callsPath = join(root, "calls");
  await writeFile(callsPath, "");
  t.after(async () => {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}/market-spread-service-test-`));
    await rm(root, { recursive: true, force: true });
  });
  const script = `${installer.slice(0, entrypoint)}
calls=$1
need_reload=$2
show_status=$3
reload_status=$4
enabled_status=$5
enable_status=$6
changed=$7
action=$8
enabled_state=$9
# Every service interaction stays in this mock; never contact the host manager.
systemctl() {
  printf '%s\\n' "$*" >> "$calls"
  case "$1" in
    show) printf '%s\\n' "$need_reload"; return "$show_status" ;;
    daemon-reload) return "$reload_status" ;;
    is-enabled) printf '%s\\n' "$enabled_state"; return "$enabled_status" ;;
    enable) return "$enable_status" ;;
    *) printf 'Unexpected service operation: %s\\n' "$*" >&2; return 90 ;;
  esac
}
case "$action" in
  reload) reload_service_definition "$changed" ;;
  enable) enable_service ;;
  *) exit 91 ;;
esac
`;
  let result;
  try {
    result = { ...await exec("bash", ["--noprofile", "--norc", "-c", script, "service-test", callsPath, needReload, String(showStatus), String(reloadStatus), String(enabledStatus), String(enableStatus), String(changed), action, enabledState], { timeout: 10_000 }), code: 0 };
  } catch (error) {
    result = { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code };
  }
  return { ...result, calls: (await readFile(callsPath, "utf8")).trim().split("\n").filter(Boolean) };
}

test("unchanged loaded service definition skips daemon-reload", linuxOnly, async t => {
  const result = await invoke(t, "reload");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.calls, [readReloadState]);
});

test("a changed service unit reloads even when systemd would report no pending change", linuxOnly, async t => {
  const result = await invoke(t, "reload", { changed: 1 });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.calls, ["daemon-reload"]);
});

test("pending, missing and unreadable service definition state all reload safely", linuxOnly, async t => {
  for (const options of [{ needReload: "yes" }, { needReload: "" }, { needReload: "", showStatus: 1 }]) {
    const result = await invoke(t, "reload", options);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.calls, [readReloadState, "daemon-reload"]);
  }
});

test("daemon-reload failure is reported to the installer", linuxOnly, async t => {
  const result = await invoke(t, "reload", { needReload: "yes", reloadStatus: 42 });
  assert.equal(result.code, 42);
  assert.deepEqual(result.calls, [readReloadState, "daemon-reload"]);
});

test("an enabled service avoids enable and its implicit daemon-reload", linuxOnly, async t => {
  const result = await invoke(t, "enable");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.calls, [readEnabledState]);
});

test("disabled or missing enablement is repaired", linuxOnly, async t => {
  for (const options of [{ enabledState: "disabled", enabledStatus: 1 }, { enabledState: "not-found", enabledStatus: 4 }]) {
    const result = await invoke(t, "enable", options);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.calls, [readEnabledState, `enable ${service}`]);
  }
});

test("runtime-only enablement is made persistent even when is-enabled succeeds", linuxOnly, async t => {
  const result = await invoke(t, "enable", { enabledState: "enabled-runtime" });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.calls, [readEnabledState, `enable ${service}`]);
});

test("enable failure is reported to the installer", linuxOnly, async t => {
  const result = await invoke(t, "enable", { enabledState: "disabled", enabledStatus: 1, enableStatus: 43 });
  assert.equal(result.code, 43);
  assert.deepEqual(result.calls, [readEnabledState, `enable ${service}`]);
});
