import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Listen on all network interfaces (not just localhost) so the app can be
// opened from other devices, e.g. when it runs on a Raspberry Pi.
const network = { host: true, allowedHosts: true };

export default defineConfig(() => {
  // Never let browsers keep an old index.html: after an update it would point
  // to script files that no longer exist (the hashed assets can be cached).
  const noCachePage = (req, res, next) => {
    const path = req.url.split('?')[0];
    if (path === '/' || path.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    next();
  };

  const noCachePlugin = {
    name: 'no-cache-page',
    configureServer(server) {
      server.middlewares.use(noCachePage);
    },
    configurePreviewServer(server) {
      server.middlewares.use(noCachePage);
    },
  };

  return {
    base: './',
    define: { __APP_VERSION__: JSON.stringify(version) },
    build: { chunkSizeWarningLimit: 1000 },
    server: { ...network, port: 5173 },
    preview: { ...network, port: 4173 },
    plugins: [noCachePlugin],
  };
});
