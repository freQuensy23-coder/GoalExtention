import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
const files = new Set();
files.add(manifest.background.service_worker);
files.add(manifest.action.default_popup);
files.add(manifest.options_ui.page);
for (const script of manifest.content_scripts || []) for (const file of script.js || []) files.add(file);

for (const file of files) await access(resolve(root, file));
if (manifest.manifest_version !== 3) throw new Error("manifest_version must be 3");
if (!manifest.permissions.includes("storage")) throw new Error("storage permission is required");
console.log(`Manifest references ${files.size} required files; all exist.`);
