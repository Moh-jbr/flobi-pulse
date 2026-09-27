// Starts the Vite dev server, then launches Electron pointed at it.
//   npm run dev    -> real data (sign in on first launch)
//   npm run demo   -> simulated data, no credentials needed
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const electronBinary = require('electron'); // resolves to the Electron executable path

const demo = process.argv.includes('--demo');

const server = await createServer({ configFile: 'vite.config.js' });
await server.listen();
const url = server.resolvedUrls?.local?.[0] ?? 'http://localhost:5173/';
console.log(`\n  Flobi Pulse renderer on ${url}${demo ? '  (demo mode)' : ''}\n`);

const env = { ...process.env, PULSE_DEV_URL: url };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBinary, ['.', ...(demo ? ['--demo'] : [])], { stdio: 'inherit', env });

const shutdown = async (code = 0) => {
  await server.close().catch(() => {});
  process.exit(code);
};
child.on('exit', (code) => shutdown(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
