import { access, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
const paths = [manifest.background.service_worker, manifest.action.default_popup, manifest.options_ui.page];
for (const script of manifest.content_scripts) paths.push(...script.js);
for (const path of paths) await access(resolve(root, path));
for (const path of await readdir(resolve(root, 'src'), { recursive: true })) {
  if (path.endsWith('.js')) execFileSync(process.execPath, ['--check', resolve(root, 'src', path)]);
}
if (manifest.manifest_version !== 3 || !manifest.permissions.includes('storage')) throw new Error('Invalid manifest.');
if (manifest.content_scripts.some(s => s.all_frames)) throw new Error('Only top-level ChatGPT pages may drive goals.');
console.log('Manifest references and JavaScript syntax checked.');
