import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const LINUX_BUILD_DEPENDENCIES = Object.freeze([
  "@tailwindcss/postcss", "tailwindcss", "tw-animate-css", "typescript",
  "@types/node", "@types/react", "@types/react-dom",
]);

const lifecycleScripts = ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"];
const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const installFields = ["name", "version", "type", "engines", "devEngines", "os", "cpu", "libc", "overrides", "peerDependencies", "peerDependenciesMeta", "optionalDependencies"];
const lockRootFields = ["name", "version", "dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "engines", "os", "cpu", "libc"];
const readJson = path => JSON.parse(readFileSync(path, "utf8"));

export function createLinuxManifest(rootManifest) {
  const manifest = {};
  for (const field of installFields) if (rootManifest[field] !== undefined) manifest[field] = rootManifest[field];
  manifest.private = true;
  manifest.dependencies = { ...rootManifest.dependencies };
  manifest.devDependencies = Object.fromEntries(LINUX_BUILD_DEPENDENCIES
    .filter(name => rootManifest.devDependencies?.[name] !== undefined)
    .map(name => [name, rootManifest.devDependencies[name]]));
  return manifest;
}

function fallbackReason(root, manifest) {
  for (const name of lifecycleScripts) {
    if (Object.hasOwn(manifest.scripts ?? {}, name)) return `Root install lifecycle: ${name}`;
  }
  if (manifest.workspaces) return "Root workspaces require the complete installation";
  for (const field of dependencyFields) {
    for (const [name, value] of Object.entries(manifest[field] ?? {})) {
      if (typeof value === "string" && (/^(?:file:|git\+file:|link:|workspace:|~[\\/]|\.\.?[\\/]|[\\/]|[a-zA-Z]:[\\/])/.test(value) || isAbsolute(value))) {
        return `Local dependency requires the complete installation: ${name}`;
      }
    }
  }
  for (const field of ["bundleDependencies", "bundledDependencies"]) {
    if (manifest[field]) return `Root ${field} requires the complete installation`;
  }
  for (const name of ["patches", "binding.gyp"]) {
    if (existsSync(join(root, name))) return `Root ${name} requires the complete installation`;
  }
  return null;
}

function drift(message) {
  throw new Error(`Linux dependency profile is out of date: ${message}. Run node scripts/sync-linux-dependencies.mjs and commit both deploy/linux files.`);
}

function packageName(path) {
  return path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
}

function packageIdentity(path, entry) {
  return JSON.stringify([packageName(path), entry.version, entry.resolved, entry.integrity]);
}

export function validateLinuxLock(rootManifest, rootLock, manifest, lock) {
  if (rootLock.lockfileVersion !== 3 || !rootLock.packages?.[""]) drift("root package-lock.json must use lockfileVersion 3");
  if (lock.lockfileVersion !== 3 || !lock.packages?.[""]) drift("generated package-lock.json must use lockfileVersion 3");
  const rootEntry = rootLock.packages[""];
  const generatedEntry = lock.packages[""];
  for (const field of lockRootFields) {
    if (!isDeepStrictEqual(generatedEntry[field] ?? (dependencyFields.includes(field) ? {} : undefined), manifest[field] ?? (dependencyFields.includes(field) ? {} : undefined))) {
      drift(`generated lock root ${field} does not match its manifest`);
    }
  }
  for (const field of dependencyFields) {
    for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
      if (rootEntry[field]?.[name] !== specifier || rootManifest[field]?.[name] !== specifier) drift(`root lock ${field}.${name} does not match the selected dependency`);
      const path = `node_modules/${name}`;
      if (!rootLock.packages[path] || !lock.packages[path] || packageIdentity(path, rootLock.packages[path]) !== packageIdentity(path, lock.packages[path])) {
        // Optional peers can legitimately be absent in both locks.
        if (field === "peerDependencies" && manifest.peerDependenciesMeta?.[name]?.optional && !rootLock.packages[path] && !lock.packages[path]) continue;
        drift(`selected dependency ${name} does not retain the root locked version`);
      }
    }
  }
  const identities = new Set(Object.entries(rootLock.packages).filter(([path]) => path).map(([path, entry]) => packageIdentity(path, entry)));
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path && !identities.has(packageIdentity(path, entry))) drift(`${path} introduces a package version absent from the root lock`);
    if (path && rootLock.packages[path] && packageIdentity(path, entry) !== packageIdentity(path, rootLock.packages[path])) drift(`${path} no longer matches the root locked resolution`);
  }
}

export function selectDependencyProfile(directory) {
  const root = resolve(directory);
  const manifestPath = join(root, "package.json");
  const lockPath = join(root, "package-lock.json");
  const manifest = readJson(manifestPath);
  const full = reason => ({ kind: "root-v1", manifestPath, lockPath, manifest, reason });
  const reason = fallbackReason(root, manifest);
  if (reason) return full(reason);

  const linuxManifestPath = join(root, "deploy/linux/package.json");
  const linuxLockPath = join(root, "deploy/linux/package-lock.json");
  const hasManifest = existsSync(linuxManifestPath);
  const hasLock = existsSync(linuxLockPath);
  if (!hasManifest && !hasLock && !existsSync(join(root, "deploy/linux-dependencies.mjs"))) return full("Project has no Linux dependency profile");
  if (!hasManifest || !hasLock) drift("deploy/linux/package.json and deploy/linux/package-lock.json are both required");
  const linuxManifest = readJson(linuxManifestPath);
  if (!isDeepStrictEqual(linuxManifest, createLinuxManifest(manifest))) drift("selected root dependencies or installation metadata changed");
  validateLinuxLock(manifest, readJson(lockPath), linuxManifest, readJson(linuxLockPath));
  return { kind: "linux-v1", manifestPath: linuxManifestPath, lockPath: linuxLockPath, manifest: linuxManifest, reason: "Runtime dependencies and Linux build tools only" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root, option] = process.argv.slice(2);
  if (!root || option !== "--kind") throw new Error("Usage: node deploy/linux-dependencies.mjs <project-root> --kind");
  console.log(selectDependencyProfile(root).kind);
}
