import { defineConfig, loadEnv } from 'vite';

// Listen on all network interfaces (not just localhost) so the app can be
// opened from other devices, e.g. when it runs on a Raspberry Pi.
const network = { host: true, allowedHosts: true };

// A runtime URL (not a string literal) so Vite doesn't bundle the AI code –
// and its packages – into the config.
const AI_MODULE = new URL('./server/ai.js', import.meta.url).href;

export default defineConfig(({ mode }) => {
  // ANTHROPIC_API_KEY can come from the environment or a .env file. It is only
  // used on the server, never bundled into the page.
  const env = loadEnv(mode, process.cwd(), 'ANTHROPIC_');
  const getApiKey = () => process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;

  // The AI endpoint is loaded lazily so the editor still starts when its
  // packages are missing (e.g. `npm install` not run after an update).
  const aiHandler = (req, res, next) => {
    if (!req.url.startsWith('/api/ai/')) return next();
    import(AI_MODULE)
      .then(({ aiMiddleware }) => aiMiddleware(getApiKey)(req, res, next))
      .catch((err) => {
        console.error('[ai]', err.message);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'AI support is not installed on the server – run "npm install" and restart.' }));
      });
  };

  const aiPlugin = {
    name: 'ai-analysis',
    configureServer(server) {
      server.middlewares.use(aiHandler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(aiHandler);
    },
  };

  return {
    base: './',
    build: { chunkSizeWarningLimit: 1000 },
    server: { ...network, port: 5173 },
    preview: { ...network, port: 4173 },
    plugins: [aiPlugin],
  };
});
