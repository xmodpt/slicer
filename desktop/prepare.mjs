// Copies the built web app (../dist) into this folder for packaging. Run `npm run build` in the main folder first.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('No ../dist found – run "npm run build" in the main folder first.');
  process.exit(1);
}
fs.rmSync(path.join(here, 'app'), { recursive: true, force: true });
fs.cpSync(dist, path.join(here, 'app'), { recursive: true });
console.log('Copied the web app into desktop/app.');
