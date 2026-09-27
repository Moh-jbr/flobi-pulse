import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The renderer is a plain static bundle. It never talks to the network itself:
// every request goes through the Electron main process and its read-only guard.
// The production build gets a strict Content-Security-Policy (no remote code, no
// network from the page). Dev mode skips it because Vite's hot reload needs inline scripts.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const csp = {
  name: 'pulse-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<!-- CSP is injected at build time (vite.config.js) -->', `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
};

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), csp],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: false,
  },
});
