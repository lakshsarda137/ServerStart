import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConfig, type Config } from '../src/config/load.js';

/** Point XDG_* at fresh temp dirs so tests never touch the real config or state. */
export function isolate(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), 'ss-test-'));
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  process.env.XDG_STATE_HOME = join(root, 'state');
  delete process.env.SERVERSTART_CONFIG;
  return { root };
}

export async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export function listen(port: number): Promise<Server> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}

/** A tiny Node HTTP server that also spawns a long-lived grandchild and records its PID. */
export function nodeServerProject(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'server.js'),
    `const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(__dirname + '/grandchild.pid', String(kid.pid));
const port = Number(process.env.PORT);
http.createServer((req, res) => { res.end(req.url === '/health' ? 'ok' : 'hello'); }).listen(port, '127.0.0.1', () => {
  console.log('listening on ' + port);
});
`,
  );
  return dir;
}

export function config(services: Record<string, unknown>, settings: Record<string, unknown> = {}): Config {
  return buildConfig({ settings: { shell: 'sh', ready_timeout: '15s', ...settings }, services }, join(process.env.XDG_CONFIG_HOME!, 'serverstart', 'serverstart.yaml'), true);
}

export const node = process.execPath;
