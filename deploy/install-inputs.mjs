import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync, lstatSync } from "node:fs";
import { join, dirname, resolve, relative, sep, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { selectDependencyProfile } from "./linux-dependencies.mjs";

function profileDependencyKey(directory, { sourceId, nodeVersion, npmVersion, architecture }, profile) {
  const manifest = profile.manifest;
  const lifecycle = ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"].some(name => Object.hasOwn(manifest.scripts ?? {}, name));
  const localDependency = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap(field => Object.values(manifest[field] ?? {})).some(value => typeof value === "string" && (/^(?:file:|git\+file:|link:|workspace:|~[\\/]|\.\.?[\\/]|[\\/]|[a-zA-Z]:[\\/])/.test(value) || isAbsolute(value)));
  const hash = createHash("sha256");
  const sourceBound = profile.kind === "root-v1" && (lifecycle || localDependency || manifest.workspaces || manifest.bundleDependencies || manifest.bundledDependencies || existsSync(join(directory, "patches")) || existsSync(join(directory, "binding.gyp")));
  hash.update(JSON.stringify({ schema: 3, profile: profile.kind, nodeVersion, npmVersion, architecture, install: "development,dev,optional", sourceId: sourceBound ? sourceId : null }));
  for (const [file, path] of [["package.json", profile.manifestPath], ["package-lock.json", profile.lockPath], [".npmrc", join(directory, ".npmrc")]]) {
    hash.update(`\0${file}\0`);
    hash.update(existsSync(path) ? readFileSync(path) : "<absent>");
  }
  return hash.digest("hex");
}

export function dependencyKey(directory, environment) {
  return profileDependencyKey(directory, environment, selectDependencyProfile(directory));
}

const ignoredDirectories = new Set([".git", ".github", ".openai", "node_modules", ".next", "dist", ".build-cache", ".vinext", ".sites-runtime", ".wrangler", "runtime-data", ".codex", ".agents", "output", "outputs", ".playwright-cli", ".runtime", "docs", "tests"]);
const buildEnvironmentFiles = new Set([".env", ".env.local", ".env.production", ".env.production.local"]);
// These custom-server entry points run outside the UI build. Everything else is a
// build input unless it is a deployment helper or documentation/test artifact.
const independentServerFiles = new Set(["server/linux.mjs", "server/entrypoint.sh", "server/http.mjs", "server/page-handler.mjs", "server/monitor-services.mjs", "server/market-collector.mjs", "server/market-store.mjs", "server/initial-market.mjs"]);
const linuxExcludedFiles = new Set(["drizzle.config.ts", "cloudflare-env.d.ts"]);
function linuxExcluded(name) {
  return linuxExcludedFiles.has(name) || name.startsWith("build/") || name.startsWith("db/");
}
function sourceFiles(directory, path = "") {
  const files = [];
  for (const entry of readdirSync(join(directory, path), { withFileTypes: true })) {
    const name = path ? `${path}/${entry.name}` : entry.name;
    // public/ is served verbatim, including Markdown or paths named docs/tests.
    // Only known root-level development material is irrelevant to deployment.
    if (!path && (ignoredDirectories.has(entry.name) || (entry.name.startsWith(".env") && !buildEnvironmentFiles.has(entry.name)) || entry.name.startsWith(".install-") || entry.name.startsWith(".tmp") || entry.name.endsWith(".tsbuildinfo") || name === "next-env.d.ts" || /\.md$/i.test(entry.name))) continue;
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

function promoteReferencedFiles(directory, included, available) {
  // Set iteration also visits newly promoted files, so transitive references
  // restore excluded tool files and independent server entries to the key.
  for (const name of included) {
    if (!/\.(?:[cm]?[jt]sx?|json|css)$/.test(name)) continue;
    const source = readFileSync(join(directory, name), "utf8");
    for (const match of source.matchAll(/["'`]((?:\.{1,2}\/|@\/)[^"'`\n]+)["'`]/g)) {
      const target = match[1].startsWith("@/") ? join(directory, match[1].slice(2)) : resolve(directory, dirname(name), match[1]);
      for (const suffix of ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", "/index.ts", "/index.tsx", "/index.js", "/index.mjs", "/index.cjs"]) {
        const candidate = relative(resolve(directory), target + suffix).split(sep).join("/");
        if (available.has(candidate)) included.add(candidate);
      }
    }
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}

function linuxScripts(manifest) {
  const all = manifest.scripts ?? {};
  const selected = Object.fromEntries(Object.entries(all).filter(([name]) => /^(pre|post)?(build|start):linux$/.test(name)));
  // Package-manager commands may delegate to any other root script and its
  // lifecycle hooks. Preserve the complete recipe in that case.
  return Object.values(selected).some(script => /\b(?:npm|pnpm|yarn)\b/.test(script)) ? all : selected;
}

function linuxPackageMetadata(manifest) {
  // The selected dependency profile covers dependency declarations and locks.
  // Keep every other field (including type/imports/exports/config) conservative,
  // while unrelated development scripts do not affect the Linux artifact.
  const metadata = { ...manifest };
  for (const name of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta"]) delete metadata[name];
  metadata.scripts = linuxScripts(manifest);
  return JSON.stringify(canonical(metadata));
}

function packageReferencedFiles(manifest, available) {
  const files = new Set();
  function visit(value) {
    if (typeof value === "string" && value.startsWith("./")) {
      const pattern = value.slice(2).split("*");
      for (const name of available) {
        if (pattern.length === 1 ? name === pattern[0] : name.startsWith(pattern[0]) && name.endsWith(pattern.at(-1))) files.add(name);
      }
    } else if (value && typeof value === "object") Object.values(value).forEach(visit);
  }
  for (const field of ["imports", "exports", "main", "module", "browser", "bin"]) visit(manifest[field]);
  return files;
}

export function installKeys(directory, environment, buildEnvironment = process.env) {
  const profile = selectDependencyProfile(directory);
  const dependencies = profileDependencyKey(directory, environment, profile);
  const available = new Set(sourceFiles(directory));
  const linux = profile.kind === "linux-v1";
  const files = new Set([...available].filter(name => !linux || (!linuxExcluded(name) && name !== "package.json" && name !== "package-lock.json")));
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (linux) for (const name of packageReferencedFiles(manifest, available)) files.add(name);
  // Scripts can explicitly consume an excluded file, including test fixtures.
  const recipes = linux ? Object.values(linuxScripts(manifest)) : ["prebuild:linux", "build:linux", "postbuild:linux"].map(name => manifest.scripts?.[name] ?? "");
  for (const script of recipes) {
    for (const word of script.split(/\s+/)) {
      const name = word.replace(/^['"]|['"]$/g, "").replace(/^\.\//, "");
      if (!name.startsWith("/") && !name.includes("..") && existsSync(join(directory, name)) && lstatSync(join(directory, name)).isFile()) {
        files.add(name);
        available.add(name);
      }
    }
  }
  const build = new Set([...files].filter(name => !name.startsWith("deploy/") && !independentServerFiles.has(name)));
  promoteReferencedFiles(directory, files, available);
  promoteReferencedFiles(directory, build, available);
  const publicEnvironment = Object.fromEntries(Object.entries(buildEnvironment).filter(([key]) => /^(VITE_|MONITOR_BUILD_)/.test(key)).sort(([a], [b]) => a.localeCompare(b)));
  const metadata = linux ? linuxPackageMetadata(manifest) : "";
  const runtime = digestFiles(directory, `runtime-v4:${dependencies}:${metadata}`, files);
  const compiled = digestFiles(directory, `react-vite-v1:${dependencies}:${metadata}:${JSON.stringify(publicEnvironment)}:NODE_ENV=production`, build);
  return { dependencies, runtime, build: compiled };
}

export function validBuild(directory) {
  try {
    const root = join(directory, "dist");
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const safePath = name => typeof name === "string" && name.length > 0 && !/[\\:\u0000-\u001f]/.test(name) && !name.split("/").some(part => !part || part === "." || part === "..");
    const actual = new Set();
    function inspect(path = "") {
      const full = join(root, path);
      const info = lstatSync(full);
      if (info.isSymbolicLink()) throw new Error("Linked build path");
      if (info.isDirectory()) {
        for (const name of readdirSync(full)) inspect(path ? `${path}/${name}` : name);
      } else if (info.isFile()) {
        if (path !== "build-manifest.json") {
          if (!safePath(path) || !/^(client|server)\//.test(path)) throw new Error("Unexpected build file");
          actual.add(path);
        }
      } else throw new Error("Non-regular build path");
    }
    inspect();
    const inventory = JSON.parse(readFileSync(join(root, "build-manifest.json"), "utf8"));
    if (!object(inventory) || inventory.schemaVersion !== 1 || !object(inventory.files)) return false;
    const expected = Object.keys(inventory.files);
    if (actual.size !== expected.length || !["client/index.html", "client/.vite/manifest.json", "server/entry-server.js"].every(name => actual.has(name))) return false;
    for (const name of expected) {
      if (!safePath(name) || !actual.has(name) || !/^[a-f0-9]{64}$/.test(inventory.files[name])) return false;
      if (createHash("sha256").update(readFileSync(join(root, name))).digest("hex") !== inventory.files[name]) return false;
    }
    const manifest = JSON.parse(readFileSync(join(root, "client/.vite/manifest.json"), "utf8"));
    if (!object(manifest) || !object(manifest["index.html"]) || manifest["index.html"].isEntry !== true) return false;
    for (const entry of Object.values(manifest)) {
      if (!object(entry) || !safePath(entry.file) || !actual.has(`client/${entry.file}`)) return false;
      for (const field of ["css", "assets", "imports", "dynamicImports"]) {
        if (entry[field] === undefined) continue;
        if (!Array.isArray(entry[field])) return false;
        for (const name of entry[field]) {
          if (field === "imports" || field === "dynamicImports") {
            if (typeof name !== "string" || !Object.hasOwn(manifest, name)) return false;
          } else if (!safePath(name) || !actual.has(`client/${name}`)) return false;
        }
      }
    }
    return true;
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
