import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  plugins: [basicSsl()],
  server: {
    host: true,
    proxy: {
      // Forwards to scripts/server.ts (npm run server, from the repo root).
      // Same-origin from the browser's perspective either way -- avoids
      // needing a second TLS cert or CORS config just to reach it, and
      // works identically from the Quest's LAN URL as from localhost.
      '/api': { target: 'http://localhost:8787', ws: true },
    },
  },
});
