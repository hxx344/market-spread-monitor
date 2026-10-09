import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
// Never fall back to the Windows bash launcher: it can enter WSL.
const gitDirectories = process.platform === "win32" ? (process.env.PATH ?? "").split(delimiter).filter(path => path && existsSync(join(path, "git.exe"))) : [];
const gitBash = gitDirectories.flatMap(path => [join(path, "bash.exe"), resolve(path, "../bin/bash.exe"), resolve(path, "../../bin/bash.exe")]).find(path => existsSync(path));
const bash = process.platform === "linux" ? "bash" : gitBash;
const shellOnly = { skip: !bash };
const installer = (await readFile(new URL("../deploy/install.sh", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
const entrypoint = installer.lastIndexOf("\nif (( EUID != 0 )); then");
assert.ok(entrypoint > 0, "Load installer functions without invoking installation");

async function fixture(t, body) {
  const root = await mkdtemp(join(tmpdir(), "market-spread-profile-test-"));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.includes("market-spread-profile-test-"));
    await rm(root, { recursive: true, force: true });
  });
  const scriptPath = join(root, "profile-fixture.sh");
  await writeFile(scriptPath, `${installer.slice(0, entrypoint)}\nfixture_root=$1\nprofile_now=1000\nprofile_clock() { profile_clock_ms=$profile_now; return 0; }\n${body}\n`);
  let result;
  try {
    result = { ...await exec(bash, ["--noprofile", "--norc", scriptPath.replaceAll("\\", "/"), root.replaceAll("\\", "/")], { timeout: 10_000 }), code: 0 };
  } catch (error) {
    result = { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code };
  }
  const directories = (await readdir(root)).filter(name => name.startsWith("market-spread-profile."));
  const directory = directories.length === 1 ? join(root, directories[0]) : undefined;
  const events = directory && existsSync(join(directory, "events.tsv")) ? await readFile(join(directory, "events.tsv"), "utf8") : "";
  const summary = directory && existsSync(join(directory, "summary.txt")) && (await stat(join(directory, "summary.txt"))).isFile() ? await readFile(join(directory, "summary.txt"), "utf8") : "";
  return { ...result, root, directory, directories, events, summary };
}

function rows(summary) {
  return summary.split("\n").flatMap(line => {
    const match = line.match(/^(\d+\.\d{3})\t(\d+\.\d{2})%\t([^\t]+)\t.+ \[([a-z_]+)\]$/);
    return match ? [{ seconds: Number(match[1]), percent: Number(match[2]), state: match[3], id: match[4] }] : [];
  });
}

test("profile combines child-shell phases, accumulates repeated phases, and leaves skips outside the clock", shellOnly, async t => {
  const result = await fixture(t, String.raw`
profile_init "$fixture_root"
profile_phase preflight
profile_now=2000
profile_phase deps_install
(
  profile_now=2500
  profile_skip compiler_cache cache_unavailable
  profile_now=4500
  profile_phase next_build
)
profile_now=8500
profile_skip source_download unchanged
profile_now=9500
profile_phase health_check
profile_now=10000
profile_phase deps_install
profile_now=11000
profile_phase exit_cleanup
profile_now=11500
profile_report 0
profile_report 99
profile_phase rollback
`);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.directories.length, 1);
  assert.match(result.summary, /总耗时：10\.500 秒/);
  assert.match(result.summary, /部署退出码：0/);
  assert.match(result.summary, /主要耗时：Next\.js 构建（含类型检查） \[next_build\]（5\.000 秒，47\.62%）/);
  const stages = rows(result.summary);
  assert.equal(stages.length, 28);
  assert.deepEqual(stages.slice(0, 5).map(({ id, seconds }) => [id, seconds]), [["next_build", 5], ["deps_install", 3.5], ["preflight", 1], ["health_check", 0.5], ["exit_cleanup", 0.5]]);
  assert.equal(stages.reduce((total, row) => total + row.seconds, 0), 10.5);
  assert.ok(Math.abs(stages.reduce((total, row) => total + row.percent, 0) - 100) < 0.02);
  assert.equal(stages.find(row => row.id === "source_download").state, "跳过（内容未变）");
  assert.equal(stages.find(row => row.id === "compiler_cache").state, "跳过（无可用缓存）");
  assert.equal(stages.find(row => row.id === "rollback").state, "未执行");
  assert.equal(result.events.split("\n").filter(line => line.startsWith("end\t")).length, 1, "Report is idempotent");
  assert.match(result.events, /phase\t4500\tnext_build\t0/);
  assert.equal((result.stdout.match(/计时报告：/g) ?? []).length, 1);
  if (process.platform === "linux") {
    assert.equal((await stat(result.directory)).mode & 0o777, 0o700);
    for (const name of ["events.tsv", "summary.txt"]) assert.equal((await stat(join(result.directory, name))).mode & 0o777, 0o600);
  }
});

test("a failing child reports the build failure once and preserves the original deployment status", shellOnly, async t => {
  const result = await fixture(t, String.raw`
profile_init "$fixture_root"
profile_phase preflight
profile_now=2000
profile_phase next_build
trap 'status=$?; profile_now=6500; profile_phase exit_cleanup "$status"; profile_now=7000; profile_report "$status"; exit "$status"' EXIT
(
  trap 'status=$?; profile_report "$status"; exit "$status"' EXIT
  profile_now=3000
  profile_phase next_build
  exit 37
)
`);
  assert.equal(result.code, 37, result.stderr);
  const stages = rows(result.summary);
  assert.equal(stages.find(row => row.id === "next_build").state, "失败（退出码 37）");
  assert.equal(stages.find(row => row.id === "exit_cleanup").state, "完成", "Successful cleanup does not inherit the earlier failure");
  assert.equal(stages.find(row => row.id === "rollback").state, "未执行");
  assert.match(result.summary, /总耗时：6\.000 秒/);
  assert.match(result.summary, /部署退出码：37/);
  assert.equal(result.events.split("\n").filter(line => line.startsWith("end\t")).length, 1);
  assert.match(result.events, /end\t7000\t37\t0\n$/);
});

test("disabled profiling has no output or filesystem side effects", shellOnly, async t => {
  const result = await fixture(t, String.raw`
profile_phase preflight
profile_skip next_build reused
profile_report 43
`);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(await readdir(result.root), ["profile-fixture.sh"]);
});

test("profile artifacts contain fixed identifiers only, without deployment output or environment secrets", shellOnly, async t => {
  const secret = "PRIVATE_profile_token_sentinel_4ac81";
  const result = await fixture(t, String.raw`
export SECRET_VALUE=PRIVATE_profile_token_sentinel_4ac81
profile_init "$fixture_root"
profile_phase preflight
printf '%s\n' "$SECRET_VALUE"
profile_phase "$SECRET_VALUE"
profile_skip "$SECRET_VALUE" reused
profile_skip next_build "$SECRET_VALUE"
profile_phase next_build "$SECRET_VALUE"
profile_skip next_build reused
profile_now=2000
profile_report 0
`);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(secret), "The fixture really emitted deployment output");
  assert.ok(!result.events.includes(secret));
  assert.ok(!result.summary.includes(secret));
  assert.ok(!result.events.includes(result.root));
  assert.equal(rows(result.summary).find(row => row.id === "next_build").state, "跳过（已复用）");
  assert.deepEqual(result.events.trim().split("\n"), ["phase\t1000\tpreflight\t0", "skip\t1000\tnext_build\treused", "end\t2000\t0\t0"]);
});

test("unavailable clock, event writes, or report output never replace the deployment error", shellOnly, async t => {
  for (const failure of ["clock", "events", "summary", "awk"]) {
    const sabotage = {
      clock: "profile_clock() { profile_clock_ms=''; return 0; }",
      events: "profile_events=$profile_dir/missing/events.tsv",
      summary: 'mkdir "$profile_dir/summary.txt"',
      awk: "awk() { return 72; }",
    }[failure];
    const result = await fixture(t, `
profile_init "$fixture_root"
profile_phase preflight
${sabotage}
profile_phase next_build
trap 'status=$?; profile_report "$status"; exit "$status"' EXIT
exit 47
`);
    assert.equal(result.code, 47, `${failure}: ${result.stderr}`);
    assert.match(result.stderr, /部署退出状态保持不变/);
    assert.ok(!result.stdout.includes("计时报告："), `${failure} must not claim a completed report`);
  }
});

test("an unavailable profile directory leaves installation enabled and produces no partial report", shellOnly, async t => {
  const result = await fixture(t, String.raw`
profile_init "$fixture_root/missing"
profile_phase preflight
profile_report 0
printf 'installation-continued\n'
`);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "installation-continued\n");
  assert.match(result.stderr, /无法创建部署计时目录；继续安装/);
  assert.deepEqual(result.directories, []);
});
