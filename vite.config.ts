import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const workerOrigin = 'http://127.0.0.1:8787';
export default defineConfig({
  base: '/drive/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: workerOrigin,
        changeOrigin: true,
        configure(server) {
          server.on('proxyReq', (proxyReq, request) => {
            if (request.headers.origin) proxyReq.setHeader('Origin', workerOrigin);
          });
        },
      },
      '/p': workerOrigin,
      '/s': workerOrigin,
    },
  },
});
