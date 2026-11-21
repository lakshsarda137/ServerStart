import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { Engine } from '../src/runtime/engine.js';
import { getStatuses } from '../src/runtime/status.js';
import { isAlive, sleep } from '../src/runtime/proc.js';
import { readState, updateState } from '../src/runtime/state.js';
import { config, freePort, isolate, listen, node, nodeServerProject } from './helpers.js';

const hasPython = (await execa('python3', ['--version'], { reject: false })).exitCode === 0;

describe('runtime (real processes)', () => {
  let root: string;
  const cleanup: (() => Promise<unknown>)[] = [];

  beforeAll(() => {
    root = isolate().root;
  });
  afterAll(async () => {
    for (const c of cleanup) await c();
  });

  it('starts a node server detached, reports ready by port, and stops the whole group', async () => {
    const dir = nodeServerProject(root, 'web');
    const port = await freePort();
    const cfg = config({ web: { cwd: dir, cmd: `"${node}" server.js`, port } });
    const engine = new Engine(cfg);
    cleanup.push(() => engine.down(['web']));
    const [r] = await engine.up(['web']);
    expect(r.state).toBe('ready');

    // a fresh reconcile (as from another terminal) sees it running
    const st = (await getStatuses(cfg))[0];
    expect(st.state).toBe('ready');
    expect(st.pid).toBeGreaterThan(0);

    const grandchild = Number(readFileSync(join(dir, 'grandchild.pid'), 'utf8'));
    expect(isAlive(grandchild)).toBe(true);
    const [d] = await new Engine(cfg).down(['web']);
    expect(d.state).toBe('stopped');
    await sleep(200);
    expect(isAlive(grandchild)).toBe(false);
    expect((await getStatuses(cfg))[0].state).toBe('stopped');
  });

  it('uses http readiness', async () => {
    const dir = nodeServerProject(root, 'api');
    const port = await freePort();
    const cfg = config({ api: { cwd: dir, cmd: `"${node}" server.js`, port, ready: { http: `http://127.0.0.1:${port}/health` } } });
    const engine = new Engine(cfg);
    cleanup.push(() => engine.down(['api']));
    expect((await engine.up(['api']))[0].state).toBe('ready');
    await engine.down(['api']);
  });

  it.skipIf(!hasPython)('uses log readiness with a python http.server', async () => {
    const port = await freePort();
    const cfg = config({
      py: { cwd: root, cmd: `python3 -u -m http.server ${port} --bind 127.0.0.1`, port, ready: { log: 'Serving HTTP' } },
    });
    const engine = new Engine(cfg);
    cleanup.push(() => engine.down(['py']));
    expect((await engine.up(['py']))[0].state).toBe('ready');
    await engine.down(['py']);
  });

  it('detects a crash with its error line and blocks dependents', async () => {
    const port = await freePort();
    const cfg = config({
      bad: { cwd: root, cmd: `"${node}" -e "console.log('booting'); console.error('Error: Cannot find module vite'); process.exit(1)"`, port },
      app: { cwd: root, cmd: `"${node}" -e "setInterval(()=>{},1000)"`, depends_on: ['bad'] },
    });
    const out = await new Engine(cfg).up(['app']);
    expect(out.find((o) => o.name === 'bad')).toMatchObject({ state: 'crashed', error: 'Error: Cannot find module vite' });
    expect(out.find((o) => o.name === 'app')).toMatchObject({ state: 'blocked', blocked_by: 'bad' });
    const st = await getStatuses(cfg);
    expect(st[0]).toMatchObject({ state: 'crashed', error: 'Error: Cannot find module vite' });
    await new Engine(cfg).down(['bad']);
    expect((await getStatuses(cfg))[0].state).toBe('stopped');
  });

  it('refuses a port held by another program, and frees it with killPort', async () => {
    const port = await freePort();
    const server = await listen(port); // held by this test process ("node")
    const cfg = config({ svc: { cwd: root, cmd: `"${node}" -e "require('http').createServer().listen(${port})"`, port } });
    const [r] = await new Engine(cfg).up(['svc']);
    expect(r.state).toBe('crashed');
    expect(r.error).toMatch(new RegExp(`^port ${port} in use: node \\d+$`));
    server.close();
  });

  it('marks a service crashed when its process dies after startup, and ignores reused PIDs', async () => {
    const dir = nodeServerProject(root, 'solo');
    const port = await freePort();
    const cfg = config({ solo: { cwd: dir, cmd: `"${node}" server.js`, port } });
    await new Engine(cfg).up(['solo']);
    const pid = readState().procs.solo.pid;
    process.kill(-pid, 'SIGKILL');
    await sleep(200);
    expect((await getStatuses(cfg))[0].state).toBe('crashed');

    // a state entry pointing at a live but unrelated PID (wrong start time) is not "running"
    updateState((s) => {
      delete s.crashed.solo;
      s.procs.solo = { pid: process.pid, pgid: process.pid, startedAt: Date.now(), lstart: 'Mon Jan 1 00:00:00 2001', cmdHash: 'x', logStart: 0 };
    });
    expect((await getStatuses(cfg))[0].state).toBe('crashed');
    expect(readState().procs.solo).toBeUndefined();
  });

  it('starts dependencies first and keeps servers running after the engine is gone', async () => {
    const a = nodeServerProject(root, 'dep-a');
    const b = nodeServerProject(root, 'dep-b');
    const [pa, pb] = [await freePort(), await freePort()];
    const cfg = config({
      'dep-a': { cwd: a, cmd: `"${node}" server.js`, port: pa },
      'dep-b': { cwd: b, cmd: `"${node}" server.js`, port: pb, depends_on: ['dep-a'] },
    });
    const order: string[] = [];
    const engine = new Engine(cfg);
    engine.on('change', (n, p) => p.state === 'ready' && order.push(n));
    await engine.up(['dep-b']);
    expect(order).toEqual(['dep-a', 'dep-b']);
    // a separate CLI process sees both as ready
    const st = await getStatuses(cfg);
    expect(st.map((s) => s.state)).toEqual(['ready', 'ready']);
    const down = await new Engine(cfg).down(['dep-a', 'dep-b']);
    expect(down.map((d) => d.name)).toEqual(['dep-a', 'dep-b']);
  });
});
