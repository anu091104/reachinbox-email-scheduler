import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = { target: process.env.VITE_DEV_API_TARGET ?? 'http://localhost:4000', changeOrigin: true };

// In development the browser talks only to Vite (localhost:5173); Vite forwards
// /api to the backend. Same origin => the session cookie just works, no CORS dance.
// `allowedHosts` lets a free Cloudflare quick tunnel (*.trycloudflare.com) reach it.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    allowedHosts: ['.trycloudflare.com'],
    proxy: { '/api': api },
  },
  preview: {
    port: 5173,
    allowedHosts: ['.trycloudflare.com'],
    proxy: { '/api': api },
  },
});
