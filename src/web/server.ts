import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadConfig, type Config } from '../config/load.js';
import { editConfig, setServiceField, setSetting } from '../config/write.js';
import { SETTING_KEYS } from '../config/schema.js';
import { EXIT, SSError } from '../errors.js';
import { displayGroups, impliedDefaults, resolveTargets } from '../graph.js';
import { applyLoginSetting } from '../login.js';
import { c, pal } from '../output/term.js';
import { logPath, tildify } from '../paths.js';
import { composeLogsArgs } from '../runtime/docker.js';
import { Engine, type Patch } from '../runtime/engine.js';
import { follow, stripAnsi, tail } from '../runtime/logs.js';
import type { Listener } from '../runtime/ports.js';
import { getStatuses, summarize } from '../runtime/status.js';
import type { ServiceStatus } from '../runtime/types.js';

const FINAL = new Set(['ready', 'crashed', 'stopped', 'blocked']);

function webDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['web', '../../dist/web', '../dist/web']) {
    const p = join(here, rel);
    if (existsSync(join(p, 'index.html'))) return p;
  }
  return join(here, 'web');
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

interface PendingPrompt {
  id: string;
  service: string;
  port: number;
  holder: Listener;
  resolve: (kill: boolean) => void;
}

class Live {
  config: Config;
  engine: Engine;
  overlay = new Map<string, { patch: Patch; at: number }>();
  polled: { at: number; list: ServiceStatus[] } = { at: 0, list: [] };
  docker: number | null = null;
  prompts = new Map<string, PendingPrompt>();
  clients = new Set<ServerResponse>();
  lastResult: { at: number; text: string; level: 'ok' | 'err' | 'info' } | null = null;

  constructor(readonly override?: string) {
    this.config = loadConfig(override);
    this.engine = new Engine(this.config);
    this.engine.on('change', (name, patch) => {
      this.overlay.set(name, { patch: { ...(this.overlay.get(name)?.patch ?? {}), ...patch }, at: Date.now() });
      this.schedule();
    });
    this.engine.on('docker', (s) => {
      this.docker = s;
      this.schedule();
    });
  }

  reload(): void {
    try {
      this.config = loadConfig(this.override);
      this.engine.config = this.config;
    } catch {
      /* keep the last valid config while the file is mid-edit */
    }
  }

  async poll(): Promise<void> {
    this.reload();
    const at = Date.now();
    this.polled = { at, list: await getStatuses(this.config) };
  }

  statuses(): ServiceStatus[] {
    return this.polled.list.map((s) => {
      const o = this.overlay.get(s.name);
      if (!o) return s;
      const keepBlocked = o.patch.state === 'blocked' && s.state === 'stopped';
      if (!FINAL.has(o.patch.state) || o.at >= this.polled.at || keepBlocked) return { ...s, ...o.patch };
      this.overlay.delete(s.name);
      return s;
    });
  }

  snapshot() {
    const services = this.statuses();
    const implied = impliedDefaults(this.config);
    return {
      config: tildify(this.config.path),
      services,
      groups: displayGroups(this.config).map((g) => ({ group: g.group, names: g.names })),
      counts: summarize(services),
      settings: this.config.settings.raw,
      implied: Object.fromEntries(implied),
      docker: this.docker,
      prompts: [...this.prompts.values()].map(({ id, service, port, holder }) => ({ id, service, port, holder })),
      result: this.lastResult && Date.now() - this.lastResult.at < 3000 ? this.lastResult : null,
    };
  }

  private timer: NodeJS.Timeout | undefined;
  schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.broadcast();
    }, 100);
  }

  broadcast(): void {
    const data = `event: status\ndata: ${JSON.stringify(this.snapshot())}\n\n`;
    for (const res of this.clients) res.write(data);
  }

  confirmKill = (service: string, port: number, holder: Listener) =>
    new Promise<boolean>((resolve) => {
      const id = randomUUID();
      this.prompts.set(id, { id, service, port, holder, resolve });
      this.schedule();
    });

  result(text: string, level: 'ok' | 'err' | 'info'): void {
    this.lastResult = { at: Date.now(), text, level };
    this.schedule();
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) break;
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function sse(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write(': connected\n\n');
}

export function createHandler(live: Live, port: number) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const dir = webDir();

  return async (req: IncomingMessage, res: ServerResponse) => {
    // DNS-rebinding protection: only our own host names.
    if (!allowedHosts.has(req.headers.host ?? '')) return json(res, 403, { error: { code: 'FORBIDDEN', message: 'bad host' } });
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const path = url.pathname;

    if (req.method === 'POST' && req.headers['x-serverstart'] !== '1') {
      return json(res, 403, { error: { code: 'FORBIDDEN', message: 'missing X-ServerStart header' } });
    }

    try {
      // static
      if (req.method === 'GET' && !path.startsWith('/api/')) {
        const file = path === '/' ? 'index.html' : path.slice(1);
        if (file.includes('..')) return json(res, 404, {});
        const full = join(dir, file);
        if (!existsSync(full) || !statSync(full).isFile()) return json(res, 404, { error: { code: 'NOT_FOUND', message: path } });
        res.writeHead(200, { 'content-type': MIME[full.slice(full.lastIndexOf('.'))] ?? 'application/octet-stream', 'cache-control': 'no-store' });
        return res.end(readFileSync(full));
      }

      if (req.method === 'GET' && path === '/api/status') return json(res, 200, live.snapshot());

      if (req.method === 'GET' && path === '/api/events') {
        sse(res);
        live.clients.add(res);
        res.write(`event: status\ndata: ${JSON.stringify(live.snapshot())}\n\n`);
        req.on('close', () => live.clients.delete(res));
        return;
      }

      const logMatch = /^\/api\/logs\/([a-z0-9-]+)$/.exec(path);
      if (req.method === 'GET' && logMatch) {
        const svc = live.config.services[logMatch[1]];
        if (!svc) return json(res, 404, { error: { code: 'NOT_FOUND', message: `unknown service "${logMatch[1]}"` } });
        sse(res);
        const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        if (svc.docker) {
          const child = spawn('docker', composeLogsArgs(svc.docker.compose, svc.docker.service, true, 500), { stdio: ['ignore', 'pipe', 'pipe'] });
          send('init', { lines: [], path: 'docker compose logs', size: null });
          const on = (d: Buffer) => send('append', { text: stripAnsi(d.toString()) });
          child.stdout.on('data', on);
          child.stderr.on('data', on);
          req.on('close', () => child.kill());
          return;
        }
        const file = logPath(svc.name);
        const n = Math.min(5000, Number(url.searchParams.get('n')) || 1000);
        const size = existsSync(file) ? statSync(file).size : 0;
        send('init', { lines: tail(file, n).map(stripAnsi), path: tildify(file), size });
        const stop = follow(file, size, (text) => send('append', { text: stripAnsi(text), size: existsSync(file) ? statSync(file).size : null }));
        req.on('close', stop);
        return;
      }

      const actMatch = /^\/api\/services\/([a-z0-9-]+)\/(start|stop|restart|default)$/.exec(path);
      if (req.method === 'POST' && actMatch) {
        const [, name, action] = actMatch;
        if (!live.config.services[name]) return json(res, 404, { error: { code: 'NOT_FOUND', message: `unknown service "${name}"` } });
        if (action === 'default') {
          const body = await readBody(req);
          const value = typeof body.value === 'boolean' ? body.value : !live.config.services[name].isDefault;
          live.config = editConfig(live.override, (doc) => setServiceField(doc, name, 'start_by_default', value));
          live.engine.config = live.config;
          live.result(`${name}   ${value ? 'added to default set' : 'removed from default set'}`, 'info');
          return json(res, 200, { name, default: value });
        }
        const report = (o: { name: string; state: string; error: string | null }[], verb: string) => {
          const r = o.find((x) => x.name === name);
          if (!r) return;
          if (r.state === 'ready' || r.state === 'stopped') live.result(`${name}   ${verb}`, 'ok');
          else if (r.state !== 'skipped') live.result(`${name}   ${r.error ?? r.state}`, 'err');
        };
        if (action === 'start') void live.engine.up([name], { confirmKill: live.confirmKill }).then((o) => report(o, 'ready'));
        if (action === 'stop') void live.engine.down([name]).then((o) => report(o, 'stopped'));
        if (action === 'restart') void live.engine.restart([name], { confirmKill: live.confirmKill }).then((o) => report(o, 'restarted'));
        return json(res, 202, { name, action });
      }

      if (req.method === 'POST' && (path === '/api/up' || path === '/api/down')) {
        live.reload();
        if (path === '/api/up') {
          const names = resolveTargets(live.config, []);
          void live.engine.up(names, { confirmKill: live.confirmKill }).then((o) => {
            const failed = o.filter((x) => x.state !== 'ready').length;
            live.result(failed ? `default set   ${failed} failed` : 'default set   ready', failed ? 'err' : 'ok');
          });
          return json(res, 202, { starting: names });
        }
        const running = live.statuses().filter((s) => s.state === 'ready' || s.state === 'starting' || s.state === 'crashed').map((s) => s.name);
        void live.engine.down(running).then(() => live.result(`${running.length} services   stopped`, 'ok'));
        return json(res, 202, { stopping: running });
      }

      const promptMatch = /^\/api\/prompts\/([0-9a-f-]+)$/.exec(path);
      if (req.method === 'POST' && promptMatch) {
        const pr = live.prompts.get(promptMatch[1]);
        if (!pr) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'prompt expired' } });
        const body = await readBody(req);
        live.prompts.delete(pr.id);
        pr.resolve(body.kill === true);
        live.schedule();
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && path === '/api/settings') {
        const body = await readBody(req);
        const key = String(body.key ?? '');
        if (!SETTING_KEYS.includes(key as never)) return json(res, 400, { error: { code: 'USAGE', message: `unknown setting "${key}"` } });
        live.config = editConfig(live.override, (doc) => setSetting(doc, key, body.value));
        live.engine.config = live.config;
        let login = null;
        if (key === 'start_on_login' || key === 'open_dashboard_on_login') login = await applyLoginSetting(live.config);
        live.schedule();
        return json(res, 200, { settings: live.config.settings.raw, login });
      }

      return json(res, 404, { error: { code: 'NOT_FOUND', message: path } });
    } catch (e) {
      if (e instanceof SSError) return json(res, 400, e.toJSON());
      return json(res, 500, { error: { code: 'INTERNAL', message: (e as Error).message } });
    }
  };
}

function listen(server: ReturnType<typeof createServer>, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onError = () => {
      server.off('listening', onListening);
      resolve(false);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

export async function runWeb(opts: { configOverride?: string; port: number; open: boolean; json: boolean }): Promise<number> {
  const live = new Live(opts.configOverride);
  await live.poll();
  let port = opts.port;
  let handler: ReturnType<typeof createHandler> = createHandler(live, port);
  const server = createServer((req, res) => void handler(req, res));
  let ok = false;
  for (let i = 0; i < 20 && !ok; i++) {
    handler = createHandler(live, port);
    ok = await listen(server, port);
    if (!ok) port++;
  }
  if (!ok) throw new SSError('PORT_IN_USE', `no free port from ${opts.port} to ${opts.port + 19}`);
  const url = `http://127.0.0.1:${port}`;

  const tick = setInterval(async () => {
    if (!live.clients.size) return;
    await live.poll();
    live.broadcast();
  }, 1000);

  if (opts.json) process.stdout.write(JSON.stringify({ url, port }) + '\n');
  else if (process.stdout.isTTY) {
    const p = pal();
    process.stdout.write('  ' + c(p.ok, '✓') + ' ' + c(p.text, 'web dashboard') + '   ' + c(p.path, url) + '   ' + c(p.accent, 'ctrl-c') + ' ' + c(p.muted, 'stop') + '\n');
  } else process.stdout.write(`web dashboard ${url}\n`);
  if (opts.open) spawn('open', [url], { stdio: 'ignore', detached: true }).unref();

  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  clearInterval(tick);
  for (const res of live.clients) res.end();
  server.close();
  if (process.stdout.isTTY && !opts.json) process.stdout.write('\r\u001b[2K  ' + c(pal().muted, 'web dashboard stopped') + '\n');
  process.exit(EXIT.OK);
}
