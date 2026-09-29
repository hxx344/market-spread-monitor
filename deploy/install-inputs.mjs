import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync, lstatSync } from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

export function dependencyKey(directory, { sourceId, nodeVersion, npmVersion, architecture }) {
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const lifecycle = ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"].some(name => manifest.scripts?.[name]);
  const localDependency = Object.values({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies }).some(value => /^(file:|link:|workspace:|\.\.?\/)/.test(value));
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ schema: 1, nodeVersion, npmVersion, architecture, install: "development,dev,optional", sourceId: lifecycle || localDependency || manifest.workspaces || existsSync(join(directory, "patches")) ? sourceId : null }));
  for (const file of ["package.json", "package-lock.json", ".npmrc"]) {
    hash.update(`\0${file}\0`);
    hash.update(existsSync(join(directory, file)) ? readFileSync(join(directory, file)) : "<absent>");
  }
  return hash.digest("hex");
}

const ignoredDirectories = new Set([".git", ".github", ".openai", "node_modules", ".next", "dist", ".vinext", ".sites-runtime", ".wrangler", "runtime-data", ".codex", ".agents", "output", "outputs", ".playwright-cli", ".runtime", "docs", "tests"]);
const nextEnvironmentFiles = new Set([".env", ".env.local", ".env.production", ".env.production.local"]);
// These custom-server entry points run outside Next. Everything else is a
// build input unless it is a deployment helper or documentation/test artifact.
const independentServerFiles = new Set(["server/linux.mjs", "server/entrypoint.sh", "server/http.mjs", "server/monitor-services.mjs", "server/market-collector.mjs", "server/market-store.mjs", "server/initial-market.mjs"]);
function sourceFiles(directory, path = "") {
  const files = [];
  for (const entry of readdirSync(join(directory, path), { withFileTypes: true })) {
    const name = path ? `${path}/${entry.name}` : entry.name;
    // public/ is served verbatim, including Markdown or paths named docs/tests.
    // Only known root-level development material is irrelevant to deployment.
    if (!path && ((entry.name.startsWith(".env") && !nextEnvironmentFiles.has(entry.name)) || entry.name.startsWith(".install-") || entry.name.startsWith(".tmp") || entry.name.endsWith(".tsbuildinfo") || name === "next-env.d.ts" || /\.md$/i.test(entry.name))) continue;
    if (entry.isDirectory()) {
      if (path || !ignoredDirectories.has(entry.name)) files.push(...sourceFiles(directory, name));
    } else if (entry.isFile() || entry.isSymbolicLink()) files.push(name);
  }
  return files;
}

function digestFiles(directory, label, files) {
  const hash = createHash("sha256").update(label);
  for (const file of [...files].sort()) {
    const data = readFileSync(join(directory, file));
    hash.update(`\0${file}\0${data.length}\0`).update(data);
  }
  return hash.digest("hex");
}

export function installKeys(directory, environment, buildEnvironment = process.env) {
  const dependencies = dependencyKey(directory, environment);
  const files = new Set(sourceFiles(directory));
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  // A build script may explicitly use a file under tests, as the CI installer
  // fixture does. Such a file is an actual build input rather than a test-only edit.
  for (const word of (manifest.scripts?.["build:linux"] ?? "").split(/\s+/)) {
    const name = word.replace(/^['"]|['"]$/g, "").replace(/^\.\//, "");
    if (!name.startsWith("/") && !name.includes("..") && existsSync(join(directory, name)) && lstatSync(join(directory, name)).isFile()) files.add(name);
  }
  const build = new Set([...files].filter(name => !name.startsWith("deploy/") && !independentServerFiles.has(name)));
  // Promote an otherwise independent entry point if Next-facing code starts
  // referring to it. Match all local string references, including dynamic import.
  for (const name of build) {
    if (!/\.[cm]?[jt]sx?$/.test(name)) continue;
    const source = readFileSync(join(directory, name), "utf8");
    for (const match of source.matchAll(/["'`]((?:\.{1,2}\/|@\/)[^"'`\n]+)["'`]/g)) {
      const target = match[1].startsWith("@/") ? join(directory, match[1].slice(2)) : resolve(directory, dirname(name), match[1]);
      for (const suffix of ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.mjs"]) {
        const candidate = relative(resolve(directory), target + suffix).split(sep).join("/");
        if (files.has(candidate)) build.add(candidate);
      }
    }
  }
  const publicEnvironment = Object.fromEntries(Object.entries(buildEnvironment).filter(([key]) => /^(NEXT_PUBLIC_|MONITOR_BUILD_)/.test(key)).sort(([a], [b]) => a.localeCompare(b)));
  const runtime = digestFiles(directory, `runtime-v2:${dependencies}`, files);
  const compiled = digestFiles(directory, `next-v2:${dependencies}:${JSON.stringify(publicEnvironment)}:NODE_ENV=production`, build);
  return { dependencies, runtime, build: compiled };
}

export function validBuild(directory) {
  try {
    if (!readFileSync(join(directory, ".next/BUILD_ID"), "utf8").trim()) return false;
    for (const file of [".next/build-manifest.json", ".next/required-server-files.json", ".next/server/app-paths-manifest.json"]) {
      const value = JSON.parse(readFileSync(join(directory, file), "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    }
    const routes = JSON.parse(readFileSync(join(directory, ".next/server/app-paths-manifest.json"), "utf8"));
    return Object.values(routes).every(name => typeof name === "string" && !name.startsWith("/") && !name.split(/[\\/]/).includes("..") && existsSync(join(directory, ".next/server", name)));
  } catch { return false; }
}

export function storedSizes(directory) {
  try {
    const value = JSON.parse(readFileSync(join(directory, ".install-storage.json"), "utf8"));
    if (value.dependencies !== readFileSync(join(directory, ".install-dependencies"), "utf8").trim() || value.build !== readFileSync(join(directory, ".install-build"), "utf8").trim()) return null;
    const numbers = [value.dependencyKB, value.dependencyInodes, value.buildKB, value.buildInodes];
    return numbers.every(number => Number.isSafeInteger(number) && number > 0) ? numbers : null;
  } catch { return null; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [directory, sourceId, nodeVersion, npmVersion, architecture] = process.argv.slice(2);
  if (sourceId === "--valid-build") process.exitCode = validBuild(directory) ? 0 : 1;
  else if (sourceId === "--sizes") {
    const values = storedSizes(directory);
    if (values) console.log(values.join(" "));
  } else if (process.argv.includes("--all")) {
    const keys = installKeys(directory, { sourceId, nodeVersion, npmVersion, architecture });
    console.log([keys.dependencies, keys.runtime, keys.build].join("\n"));
  } else console.log(dependencyKey(directory, { sourceId, nodeVersion, npmVersion, architecture }));
}
