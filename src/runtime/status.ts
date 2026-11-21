import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config, Service, Settings } from '../config/load.js';
import { impliedDefaults } from '../graph.js';
import { logPath } from '../paths.js';
import { composePs, dockerVersion, parseUpSeconds, type ComposeContainer } from './docker.js';
import { nodeVersion, prefixLines, venvPath } from './env.js';
import { errorSince } from './logs.js';
import { listeners, portOpen } from './ports.js';
import { psInfo } from './proc.js';
import { checkReady } from './ready.js';
import { readState, updateState, type StateFile } from './state.js';
import type { ServiceStatus } from './types.js';

export function serviceUrl(svc: Service): string | null {
  return svc.url ?? (svc.port ? `http://localhost:${svc.port}` : null);
}

const shortVersion = (v: string) => v.replace(/^v/, '').split('.').slice(0, 2).join('.');

/** Runtime label from config alone, used until a real version has been seen. */
export function configRuntime(svc: Service): string {
  if (svc.kind === 'docker') return 'docker';
  if (svc.kind === 'node') {
    const v = nodeVersion(svc);
    return v && /^v?\d/.test(v) ? `node ${shortVersion(v)}` : 'node';
  }
  if (svc.kind === 'python') return 'python';
  return (svc.cmd ?? '').split(/\s+/)[0] || 'other';
}

/** Ask the service's own environment for its runtime version, e.g. "node 20.11". Best effort. */
export async function probeRuntime(svc: Service, settings: Settings): Promise<string | null> {
  try {
    if (svc.kind === 'node') {
      const script = [...prefixLines(svc), 'node -v'].join('\n');
      const r = await execa(settings.shell, ['-lc', script], { cwd: svc.cwd, reject: false, timeout: 8000 });
      const m = /v?(\d+\.\d+)/.exec(r.stdout);
      return m ? `node ${m[1]}` : null;
    }
    if (svc.kind === 'python') {
      const venv = venvPath(svc);
      if (venv && existsSync(join(venv, 'bin', 'python'))) {
        const r = await execa(join(venv, 'bin', 'python'), ['--version'], { reject: false, timeout: 5000 });
        const m = /(\d+\.\d+)/.exec(r.stdout || r.stderr);
        return m ? `python ${m[1]}` : null;
      }
      if (svc.python?.conda || svc.python?.uv) return 'python';
      const r = await execa(settings.shell, ['-lc', 'python3 --version'], { cwd: svc.cwd, reject: false, timeout: 8000 });
      const m = /(\d+\.\d+)/.exec(r.stdout || r.stderr);
      return m ? `python ${m[1]}` : null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function baseStatus(config: Config, svc: Service, state: StateFile, implied: Map<string, string>): ServiceStatus {
  return {
    name: svc.name,
    state: 'stopped',
    port: svc.port ?? null,
    pid: null,
    group: svc.groups,
    uptime_s: null,
    url: serviceUrl(svc),
    log: logPath(svc.name),
    error: null,
    runtime: state.runtimes[svc.name] ?? configRuntime(svc),
    kind: svc.kind,
    default: svc.isDefault,
    implied_by: implied.get(svc.name) ?? null,
    blocked_by: null,
    external: null,
    depends_on: svc.dependsOn,
  };
}

// docker ps is slow-ish; cache per compose file briefly
const composeCache = new Map<string, { at: number; data: ComposeContainer[] | null }>();
let dockerUpCache: { at: number; up: boolean } | undefined;

async function dockerUp(): Promise<boolean> {
  if (dockerUpCache && Date.now() - dockerUpCache.at < 5000) return dockerUpCache.up;
  const up = (await dockerVersion()) !== null;
  dockerUpCache = { at: Date.now(), up };
  return up;
}

async function composeCached(file: string, maxAgeMs: number): Promise<ComposeContainer[] | null> {
  const c = composeCache.get(file);
  if (c && Date.now() - c.at < maxAgeMs) return c.data;
  const data = await composePs(file);
  composeCache.set(file, { at: Date.now(), data });
  return data;
}

export function invalidateDockerCache(): void {
  composeCache.clear();
  dockerUpCache = undefined;
}

async function dockerStatus(svc: Service, st: ServiceStatus, maxAgeMs: number): Promise<void> {
  if (!svc.docker || !existsSync(svc.docker.compose) || !(await dockerUp())) return;
  const containers = await composeCached(svc.docker.compose, maxAgeMs);
  if (!containers) return;
  const mine = containers.filter((c) => !svc.docker!.service || c.Service === svc.docker!.service);
  if (!mine.length) return;
  const running = mine.filter((c) => c.State === 'running');
  if (running.length) {
    st.uptime_s = Math.min(...running.map((c) => parseUpSeconds(c.Status) ?? 0));
    const healthy = running.every((c) => !c.Health || c.Health === 'healthy');
    const portOk = svc.port ? await portOpen(svc.port) : true;
    st.state = healthy && portOk ? 'ready' : 'starting';
    return;
  }
  const failed = mine.find((c) => c.State === 'exited' && (c.ExitCode ?? 0) !== 0);
  if (failed) {
    st.state = 'crashed';
    st.error = failed.Status ?? `exited with code ${failed.ExitCode}`;
  } else if (mine.some((c) => c.State === 'restarting')) {
    st.state = 'starting';
  }
}

/**
 * Reconcile state.json with reality and return every service's status (PRD §6.1).
 * Dead processes become `crashed` (with their last error line); PID reuse is detected via start time.
 */
export async function getStatuses(config: Config, opts: { dockerMaxAgeMs?: number } = {}): Promise<ServiceStatus[]> {
  const state = readState();
  const implied = impliedDefaults(config);
  const pids = Object.values(state.procs).map((p) => p.pid);
  const ps = await psInfo(pids);
  const deadNow: Record<string, string | null> = {};
  const readyNow: Record<string, number> = {};
  const staleCrashes: string[] = [];

  const results = await Promise.all(
    config.order.map(async (name) => {
      const svc = config.services[name];
      const st = baseStatus(config, svc, state, implied);
      if (svc.docker) {
        await dockerStatus(svc, st, opts.dockerMaxAgeMs ?? 2500);
        return st;
      }
      const entry = state.procs[name];
      if (entry) {
        const info = ps.get(entry.pid);
        const same = info && (!entry.lstart || info.lstart === entry.lstart);
        if (same) {
          st.pid = entry.pid;
          st.uptime_s = Math.round((Date.now() - entry.startedAt) / 1000);
          if (entry.readyAt) st.state = 'ready';
          else if (await checkReady(svc.ready, { service: name, logStart: entry.logStart, startedAt: entry.startedAt })) {
            st.state = 'ready';
            readyNow[name] = Date.now();
          } else {
            st.state = 'starting';
            st.elapsed_s = st.uptime_s;
          }
          return st;
        }
        // Process is gone (or the PID was reused by something else).
        const err = errorSince(name, entry.logStart);
        deadNow[name] = err;
        st.state = 'crashed';
        st.error = err;
        return st;
      }
      const crash = state.crashed[name];
      const held = svc.port ? await portOpen(svc.port, 250) : false;
      if (crash && !held) {
        st.state = 'crashed';
        st.error = crash.error;
        return st;
      }
      if (crash) staleCrashes.push(name); // something now serves the port; the old crash is stale
      if (held && svc.port) {
        const l = (await listeners(svc.port))[0];
        st.state = 'external';
        st.external = l ? { pid: l.pid, command: l.command } : null;
        st.pid = l?.pid ?? null;
        if (l) st.runtime = l.command;
      }
      return st;
    }),
  );

  if (Object.keys(deadNow).length || Object.keys(readyNow).length || staleCrashes.length) {
    updateState((s) => {
      for (const name of staleCrashes) delete s.crashed[name];
      for (const [name, error] of Object.entries(deadNow)) {
        delete s.procs[name];
        s.crashed[name] = { at: Date.now(), error };
      }
      for (const [name, at] of Object.entries(readyNow)) if (s.procs[name]) s.procs[name].readyAt = at;
    });
  }

  // blocked is only meaningful during `up`; elsewhere a crashed dependency is visible on its own row.
  return results;
}

export function summarize(statuses: ServiceStatus[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of statuses) counts[s.state] = (counts[s.state] ?? 0) + 1;
  return counts;
}
