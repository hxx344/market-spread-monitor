import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [directory, sourceId, nodeVersion, npmVersion, architecture] = process.argv.slice(2);
  console.log(dependencyKey(directory, { sourceId, nodeVersion, npmVersion, architecture }));
}
