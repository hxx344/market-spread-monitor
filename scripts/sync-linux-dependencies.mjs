import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, delimiter, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createLinuxManifest, validateLinuxLock } from "../deploy/linux-dependencies.mjs";

// Keep this version aligned with the pinned Node distribution in Linux CI.
const npmVersion = "11.12.1";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
if (process.argv.slice(2).some(argument => argument !== "--check")) throw new Error("Usage: node scripts/sync-linux-dependencies.mjs [--check]");
const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const rootManifest = readJson(join(root, "package.json"));
const rootLock = readJson(join(root, "package-lock.json"));
const manifest = createLinuxManifest(rootManifest);
const candidates = [
  process.env.npm_execpath,
  join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
  ...(process.env.PATH ?? "").split(delimiter).flatMap(directory => [join(directory, "node_modules/npm/bin/npm-cli.js"), join(directory, "../lib/node_modules/npm/bin/npm-cli.js")]),
].filter(Boolean);
const npmCli = candidates.find(path => existsSync(path) && path.endsWith("npm-cli.js"));
if (!npmCli) throw new Error(`Cannot locate npm ${npmVersion}; run this script using npm or the pinned Node distribution.`);
const version = spawnSync(process.execPath, [npmCli, "--version"], { encoding: "utf8" });
if (version.status !== 0 || version.stdout.trim() !== npmVersion) throw new Error(`Linux lock generation requires npm ${npmVersion}; found ${version.stdout?.trim() || "unavailable"}.`);

const temporaryPrefix = join(tmpdir(), "monitor-linux-lock-");
const temporary = mkdtempSync(temporaryPrefix);
try {
  writeJson(join(temporary, "package.json"), manifest);
  // npm owns graph resolution and pruning. Starting from the complete lock in
  // an empty directory retains cross-platform optional package metadata.
  writeJson(join(temporary, "package-lock.json"), rootLock);
  const result = spawnSync(process.execPath, [npmCli, "install", "--package-lock-only", "--ignore-scripts", "--offline", "--no-audit", "--no-fund", "--include=dev", "--include=optional"], {
    cwd: temporary,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "development", npm_config_update_notifier: "false" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Offline Linux lock generation failed:\n${result.stderr || result.stdout}`);
  const lock = readJson(join(temporary, "package-lock.json"));
  validateLinuxLock(rootManifest, rootLock, manifest, lock);
  const destination = join(root, "deploy/linux");
  if (check) {
    for (const [name, expected] of [["package.json", manifest], ["package-lock.json", lock]]) {
      const path = join(destination, name);
      if (!existsSync(path) || !isDeepStrictEqual(readJson(path), expected)) throw new Error(`deploy/linux/${name} is out of date. Run node scripts/sync-linux-dependencies.mjs and commit the result.`);
    }
  } else {
    mkdirSync(destination, { recursive: true });
    writeJson(join(destination, "package.json"), manifest);
    writeJson(join(destination, "package-lock.json"), lock);
  }
  console.log(`Linux dependency profile ${check ? "verified" : "updated"}: ${Object.keys(rootLock.packages).length - 1} → ${Object.keys(lock.packages).length - 1} lock package entries (not platform installation counts).`);
} finally {
  const target = resolve(temporary);
  const parent = resolve(tmpdir());
  if (dirname(target) !== parent || !target.startsWith(resolve(temporaryPrefix)) || relative(parent, target).includes(sep)) throw new Error("Refusing to remove an unexpected temporary directory");
  rmSync(target, { recursive: true, force: true });
}
