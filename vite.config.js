import { defineConfig } from 'vite';

// Listen on all network interfaces (not just localhost) so the app can be
// opened from other devices, e.g. when it runs on a Raspberry Pi.
const network = { host: true, allowedHosts: true };

export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 1000 },
  server: { ...network, port: 5173 },
  preview: { ...network, port: 4173 },
});
