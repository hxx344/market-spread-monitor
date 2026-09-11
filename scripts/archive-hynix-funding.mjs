import { readFile, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { fetchHynixFundingSnapshot } from "../lib/hynix-funding-history.ts";

const file = fileURLToPath(new URL("../data/hynix-funding.json", import.meta.url));
let previous = null;
try { previous = JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
const snapshot = await fetchHynixFundingSnapshot(previous);
await writeFile(`${file}.tmp`, JSON.stringify(snapshot));
await rename(`${file}.tmp`, file);
console.log(JSON.stringify(snapshot.metadata));
