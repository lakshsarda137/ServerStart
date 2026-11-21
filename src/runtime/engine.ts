import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import type { Config, Service } from '../config/load.js';
import { topoOrder, waves, withDependencies } from '../graph.js';
import { tildify } from '../paths.js';
import { composePs, composeStop, composeUp, dockerVersion, ensureDocker } from './docker.js';
import { buildLaunch, cmdHash, venvPath } from './env.js';
import { closeFd, errorSince, openLogForStart } from './logs.js';
import { listeners, portOpen, type Listener } from './ports.js';
import { groupAlive, isAlive, processStart, signalGroup, sleep } from './proc.js';
import { checkReady } from './ready.js';
import { getStatuses, invalidateDockerCache, probeRuntime } from './status.js';
import { readState, updateState, type ProcEntry } from './state.js';
import type { ServiceState, ServiceStatus } from './types.js';

export interface UpOutcome {
  name: string;
  state: 'ready' | 'crashed' | 'blocked';
  error: string | null;
  blocked_by: string | null;
  duration_ms: number;
  already_running: boolean;
  port: number | null;
  url: string | null;
}

export interface DownOutcome {
  name: string;
  state: 'stopped' | 'failed' | 'skipped';
  error: string | null;
  duration_ms: number;
  killed: boolean;
}

export interface UpOptions {
  /** Kill whatever holds a service's port without asking. */
  killPort?: boolean;
  /** Ask before killing a port holder (dashboard). Resolves true to kill. */
  confirmKill?: (service: string, port: number, holder: Listener) => Promise<boolean>;
}

export type Patch = Partial<ServiceStatus> & { state: ServiceState };

export interface EngineEvents {
  /** Live state change for one service. */
  change: [name: string, patch: Patch];
  /** Docker Desktop is being launched; `elapsed_s` ticks while waiting. `null` when done. */
  docker: [elapsed_s: number | null];
}

const POLL_MS = 250;
const STOP_GRACE_MS = 10000;

export class Engine extends EventEmitter<EngineEvents> {
  /** Live overlay of services this engine is currently handling. */
  readonly live = new Map<string, Patch>();

  constructor(public config: Config) {
    super();
  }

  private set(name: string, patch: Patch): void {
    this.live.set(name, patch);
    this.emit('change', name, patch);
  }

  /** Start targets plus their dependencies, each once its dependencies are ready (PRD §6.3). */
  async up(targets: string[], opts: UpOptions = {}): Promise<UpOutcome[]> {
    const { config } = this;
    const names = topoOrder(config, withDependencies(config, targets));
    const current = new Map((await getStatuses(config)).map((s) => [s.name, s]));
    for (const n of names) {
      const cur = current.get(n)!;
      if (cur.state !== 'ready') this.set(n, { state: 'queued' });
    }

    // Docker Desktop, if any docker service needs starting.
    let dockerOk = true;
    const needDocker = names.some((n) => config.services[n].docker && current.get(n)!.state !== 'ready');
    if (needDocker && !(await dockerVersion())) {
      for (const n of names) if (config.services[n].docker) this.set(n, { state: 'starting', elapsed_s: 0 });
      this.emit('docker', 0);
      dockerOk = await ensureDocker((s) => this.emit('docker', s));
      this.emit('docker', null);
      invalidateDockerCache();
    }

    const results = new Map<string, Promise<UpOutcome>>();
    const run = async (n: string): Promise<UpOutcome> => {
      const svc = config.services[n];
      const deps = await Promise.all(svc.dependsOn.map((d) => results.get(d)!));
      const failed = deps.find((d) => d.state !== 'ready');
      const t0 = Date.now();
      if (failed) {
        this.set(n, { state: 'blocked', blocked_by: failed.name, error: null });
        return this.outcome(svc, 'blocked', null, t0, false, failed.name);
      }
      const cur = current.get(n)!;
      if (cur.state === 'ready') {
        this.set(n, { state: 'ready', pid: cur.pid, uptime_s: cur.uptime_s });
        return this.outcome(svc, 'ready', null, t0, true);
      }
      if (svc.docker) return this.startDocker(svc, dockerOk, t0);
      const entry = readState().procs[n];
      if (cur.state === 'starting' && entry) return this.waitReady(svc, entry, t0, undefined);
      return this.startProcess(svc, cur, opts, t0);
    };
    for (const n of names) results.set(n, run(n));
    const out = await Promise.all(names.map((n) => results.get(n)!));
    return out;
  }

  private outcome(
    svc: Service,
    state: UpOutcome['state'],
    error: string | null,
    t0: number,
    already: boolean,
    blockedBy: string | null = null,
  ): UpOutcome {
    return {
      name: svc.name,
      state,
      error,
      blocked_by: blockedBy,
      duration_ms: Date.now() - t0,
      already_running: already,
      port: svc.port ?? null,
      url: svc.url ?? (svc.port ? `http://localhost:${svc.port}` : null),
    };
  }

  private fail(svc: Service, error: string, t0: number): UpOutcome {
    updateState((s) => {
      delete s.procs[svc.name];
      s.crashed[svc.name] = { at: Date.now(), error };
    });
    this.set(svc.name, { state: 'crashed', error, pid: null });
    return this.outcome(svc, 'crashed', error, t0, false);
  }

  private async preflight(svc: Service): Promise<string | null> {
    if (svc.docker) return existsSync(svc.docker.compose) ? null : `compose file missing: ${tildify(svc.docker.compose)}`;
    if (!existsSync(svc.cwd)) return `cwd missing: ${tildify(svc.cwd)}`;
    const venv = venvPath(svc);
    if (venv && !existsSync(venv)) return `venv missing: ${tildify(venv)}`;
    return null;
  }

  /** Free a port held by another process, if allowed. Returns an error string if it stays busy. */
  private async clearPort(svc: Service, opts: UpOptions): Promise<string | null> {
    const port = svc.port!;
    if (!(await portOpen(port))) return null;
    const holders = await listeners(port);
    const holder = holders[0];
    const busy = holder ? `port ${port} in use: ${holder.command} ${holder.pid}` : `port ${port} in use`;
    if (!holder) return busy;
    this.set(svc.name, { state: 'crashed', error: busy, external: holder, pid: holder.pid });
    const allowed = opts.killPort || (opts.confirmKill ? await opts.confirmKill(svc.name, port, holder) : false);
    if (!allowed) return busy;
    this.set(svc.name, { state: 'starting', error: null, external: null, pid: null, elapsed_s: 0 });
    for (const h of holders) await killPid(h.pid);
    for (let i = 0; i < 20 && (await portOpen(port)); i++) await sleep(250);
    return (await portOpen(port)) ? busy : null;
  }

  private async startProcess(svc: Service, cur: ServiceStatus, opts: UpOptions, t0: number): Promise<UpOutcome> {
    const { config } = this;
    this.set(svc.name, { state: 'starting', elapsed_s: 0, error: null });
    const pre = await this.preflight(svc);
    if (pre) return this.fail(svc, pre, t0);
    if (svc.port && (cur.state === 'external' || (await portOpen(svc.port)))) {
      const err = await this.clearPort(svc, opts);
      if (err) return this.fail(svc, err, t0);
    }

    const launch = buildLaunch(svc, config.settings);
    const startNo = (readState().starts[svc.name] ?? 0) + 1;
    const log = openLogForStart(svc.name, startNo);
    let exited = false;
    let spawnError: string | null = null;
    const child = spawn(launch.file, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
    });
    closeFd(log.fd);
    child.on('error', (e) => {
      spawnError = e.message;
      exited = true;
    });
    child.on('exit', () => {
      exited = true;
    });
    child.unref();
    if (!child.pid) {
      await sleep(50);
      return this.fail(svc, spawnError ?? `could not start ${launch.file}`, t0);
    }
    const entry: ProcEntry = {
      pid: child.pid,
      pgid: child.pid,
      startedAt: Date.now(),
      lstart: await processStart(child.pid),
      cmdHash: cmdHash(svc),
      port: svc.port,
      logStart: log.offset,
    };
    updateState((s) => {
      s.procs[svc.name] = entry;
      s.starts[svc.name] = startNo;
      delete s.crashed[svc.name];
    });
    this.set(svc.name, { state: 'starting', pid: child.pid, elapsed_s: 0, error: null });
    void probeRuntime(svc, config.settings).then((rt) => {
      if (rt) updateState((s) => void (s.runtimes[svc.name] = rt));
      if (rt) this.emit('change', svc.name, { ...(this.live.get(svc.name) ?? { state: 'starting' }), runtime: rt });
    });
    return this.waitReady(svc, entry, t0, () => exited);
  }

  private async waitReady(svc: Service, entry: ProcEntry, t0: number, hasExited?: () => boolean): Promise<UpOutcome> {
    const timeout = this.config.settings.readyTimeoutMs;
    let lastTick = 0;
    while (true) {
      const dead = hasExited ? hasExited() : !isAlive(entry.pid);
      if (dead) {
        await sleep(100); // let the last output reach the log
        const err = errorSince(svc.name, entry.logStart) ?? 'exited';
        return this.fail(svc, err, t0);
      }
      if (await checkReady(svc.ready, { service: svc.name, logStart: entry.logStart, startedAt: entry.startedAt })) {
        // the process may have died between checks (e.g. port taken by someone else)
        if (hasExited?.()) continue;
        updateState((s) => {
          if (s.procs[svc.name]) s.procs[svc.name].readyAt = Date.now();
        });
        this.set(svc.name, { state: 'ready', pid: entry.pid, uptime_s: Math.round((Date.now() - entry.startedAt) / 1000) });
        return this.outcome(svc, 'ready', null, t0, false);
      }
      const elapsed = Date.now() - entry.startedAt;
      if (elapsed > timeout) {
        const err = `not ready after ${Math.round(timeout / 1000)}s`;
        this.set(svc.name, { state: 'crashed', error: err, pid: entry.pid });
        return this.outcome(svc, 'crashed', err, t0, false);
      }
      if (Date.now() - lastTick >= 1000) {
        lastTick = Date.now();
        this.set(svc.name, { state: 'starting', pid: entry.pid, elapsed_s: Math.round(elapsed / 1000) });
      }
      await sleep(POLL_MS);
    }
  }

  private async startDocker(svc: Service, dockerOk: boolean, t0: number): Promise<UpOutcome> {
    if (!dockerOk) return this.fail(svc, 'Docker not running', t0);
    this.set(svc.name, { state: 'starting', elapsed_s: 0, error: null });
    const pre = await this.preflight(svc);
    if (pre) return this.fail(svc, pre, t0);
    const up = await composeUp(svc.docker!.compose, svc.docker!.service);
    if (!up.ok) return this.fail(svc, up.error ?? 'docker compose up failed', t0);
    updateState((s) => void delete s.crashed[svc.name]);
    invalidateDockerCache();
    const timeout = this.config.settings.readyTimeoutMs;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const ok = svc.port ? await portOpen(svc.port) : await composeRunning(svc);
      if (ok) {
        this.set(svc.name, { state: 'ready', uptime_s: 0 });
        return this.outcome(svc, 'ready', null, t0, false);
      }
      this.set(svc.name, { state: 'starting', elapsed_s: Math.round((Date.now() - start) / 1000) });
      await sleep(500);
    }
    const err = `not ready after ${Math.round(timeout / 1000)}s`;
    this.set(svc.name, { state: 'crashed', error: err });
    return this.outcome(svc, 'crashed', err, t0, false);
  }

  /** Stop services, dependents before their dependencies (PRD §6.4). */
  async down(names: string[]): Promise<DownOutcome[]> {
    const { config } = this;
    const current = new Map((await getStatuses(config)).map((s) => [s.name, s]));
    const out: DownOutcome[] = [];
    for (const wave of waves(config, names).reverse()) {
      out.push(...(await Promise.all(wave.map((n) => this.stopOne(config.services[n], current.get(n)!)))));
    }
    invalidateDockerCache();
    return names.map((n) => out.find((o) => o.name === n)!);
  }

  private async stopOne(svc: Service, cur: ServiceStatus): Promise<DownOutcome> {
    const t0 = Date.now();
    const done = (state: DownOutcome['state'], error: string | null = null, killed = false): DownOutcome => ({
      name: svc.name,
      state,
      error,
      duration_ms: Date.now() - t0,
      killed,
    });
    if (cur.state === 'external') return done('skipped', 'not started by ServerStart');
    if (svc.docker) {
      if (cur.state === 'stopped') return done('skipped');
      this.set(svc.name, { state: 'stopping', elapsed_s: 0 });
      const r = await composeStop(svc.docker.compose, svc.docker.service);
      updateState((s) => void delete s.crashed[svc.name]);
      if (!r.ok) {
        this.set(svc.name, { state: 'crashed', error: r.error ?? 'docker compose stop failed' });
        return done('failed', r.error ?? 'docker compose stop failed');
      }
      this.set(svc.name, { state: 'stopped' });
      return done('stopped');
    }
    const entry = readState().procs[svc.name];
    if (!entry) {
      updateState((s) => void delete s.crashed[svc.name]);
      this.set(svc.name, { state: 'stopped' });
      return done(cur.state === 'crashed' ? 'stopped' : 'skipped');
    }
    this.set(svc.name, { state: 'stopping', pid: entry.pid, elapsed_s: 0 });
    const killed = await stopGroup(entry.pgid, (s) => this.set(svc.name, { state: 'stopping', pid: entry.pid, elapsed_s: s }));
    updateState((s) => {
      delete s.procs[svc.name];
      delete s.crashed[svc.name];
    });
    this.set(svc.name, { state: 'stopped', pid: null, uptime_s: null, error: null });
    return done('stopped', null, killed);
  }

  async restart(names: string[], opts: UpOptions = {}): Promise<UpOutcome[]> {
    await this.down(names);
    return this.up(names, opts);
  }
}

/** SIGTERM the whole process group, wait up to 10s, then SIGKILL. Returns true if SIGKILL was needed. */
export async function stopGroup(pgid: number, onTick?: (elapsed_s: number) => void): Promise<boolean> {
  if (!signalGroup(pgid, 'SIGTERM')) return false;
  const start = Date.now();
  while (Date.now() - start < STOP_GRACE_MS) {
    await sleep(100);
    if (!groupAlive(pgid)) return false;
    onTick?.(Math.round((Date.now() - start) / 1000));
  }
  signalGroup(pgid, 'SIGKILL');
  for (let i = 0; i < 20 && groupAlive(pgid); i++) await sleep(100);
  return true;
}

export async function killPid(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    if (!isAlive(pid)) return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* gone */
  }
}

async function composeRunning(svc: Service): Promise<boolean> {
  const ps = await composePs(svc.docker!.compose);
  const mine = (ps ?? []).filter((c) => !svc.docker!.service || c.Service === svc.docker!.service);
  return mine.length > 0 && mine.every((c) => c.State === 'running' && (!c.Health || c.Health === 'healthy'));
}
