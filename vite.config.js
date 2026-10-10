import { defineConfig, loadEnv } from 'vite';
import { aiMiddleware } from './server/ai.js';

// Listen on all network interfaces (not just localhost) so the app can be
// opened from other devices, e.g. when it runs on a Raspberry Pi.
const network = { host: true, allowedHosts: true };

export default defineConfig(({ mode }) => {
  // ANTHROPIC_API_KEY can come from the environment or a .env file. It is only
  // used on the server, never bundled into the page.
  const env = loadEnv(mode, process.cwd(), 'ANTHROPIC_');
  const getApiKey = () => process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;

  const aiPlugin = {
    name: 'ai-analysis',
    configureServer(server) {
      server.middlewares.use(aiMiddleware(getApiKey));
    },
    configurePreviewServer(server) {
      server.middlewares.use(aiMiddleware(getApiKey));
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
