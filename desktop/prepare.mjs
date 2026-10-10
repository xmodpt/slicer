// Copies the built web app (../dist) and the AI server code into this folder
// for packaging. Run `npm run build` in the main folder first.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('No ../dist found – run "npm run build" in the main folder first.');
  process.exit(1);
}
for (const [from, to] of [[dist, 'app'], [path.join(here, '..', 'server'), 'server']]) {
  fs.rmSync(path.join(here, to), { recursive: true, force: true });
  fs.cpSync(from, path.join(here, to), { recursive: true });
}
// server/ai.js is an ES module.
fs.writeFileSync(path.join(here, 'server', 'package.json'), '{ "type": "module" }\n');
console.log('Copied the web app into desktop/app and desktop/server.');
