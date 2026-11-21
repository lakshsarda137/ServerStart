import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ZodIssue } from 'zod';
import { configPath, resolvePath } from '../paths.js';
import { SSError, didYouMean, type ConfigIssue } from '../errors.js';
import { configSchema, NAME_RE, parseDuration, type RawService, type RawSettings } from './schema.js';

export interface Settings {
  shell: string;
  readyTimeoutMs: number;
  newServicesDefault: boolean;
  startOnLogin: boolean;
  openDashboardOnLogin: boolean;
  raw: RawSettings;
}

export type ReadyCheck =
  | { kind: 'port'; port: number }
  | { kind: 'http'; url: string }
  | { kind: 'log'; pattern: RegExp; source: string }
  | { kind: 'alive'; ms: number };

export interface Service {
  name: string;
  /** Absolute cwd. For docker services, the compose file's directory. */
  cwd: string;
  cmd?: string;
  docker?: { compose: string; service?: string };
  port?: number;
  ready: ReadyCheck;
  dependsOn: string[];
  groups: string[];
  env: Record<string, string>;
  envFile?: string;
  python?: { venv?: string; conda?: string; uv?: boolean };
  node?: { version?: string };
  isDefault: boolean;
  url?: string;
  kind: 'docker' | 'node' | 'python' | 'other';
  raw: RawService;
}

export interface Config {
  path: string;
  exists: boolean;
  settings: Settings;
  services: Record<string, Service>;
  /** Service names in file order. */
  order: string[];
}

function formatZodIssue(issue: ZodIssue): ConfigIssue {
  const parts = issue.path.filter((p) => p !== 'services');
  const path = parts.length ? parts.join('.') : '(root)';
  let message = issue.message;
  if (issue.code === 'unrecognized_keys') message = `unknown field ${issue.keys.map((k) => `"${k}"`).join(', ')}`;
  if (issue.code === 'invalid_type') message = `expected ${issue.expected}, got ${issue.received}`;
  return { path, message };
}

function detectKind(s: RawService, cwd?: string): Service['kind'] {
  if (s.docker) return 'docker';
  if (s.python) return 'python';
  if (s.node) return 'node';
  const cmd = s.cmd ?? '';
  if (/\b(npm|pnpm|yarn|bun|npx|node|next|vite|nuxt|astro|remix)\b/.test(cmd)) return 'node';
  if (/\b(python3?|uvicorn|flask|django|gunicorn|streamlit|uv|poetry|hypercorn|fastapi)\b/.test(cmd)) return 'python';
  // a wrapper script: look at the project itself
  if (cwd) {
    if (['pyproject.toml', 'requirements.txt', 'manage.py'].some((f) => existsSync(join(cwd, f)))) return 'python';
    if (existsSync(join(cwd, 'package.json'))) return 'node';
  }
  return 'other';
}

export function normalizeService(name: string, s: RawService, settings: Settings): Service {
  const docker = s.docker ? { compose: resolvePath(s.docker.compose), service: s.docker.service } : undefined;
  const cwd = s.cwd ? resolvePath(s.cwd) : docker ? dirname(docker.compose) : process.cwd();
  let ready: ReadyCheck;
  if (s.ready?.http) ready = { kind: 'http', url: s.ready.http };
  else if (s.ready?.log) ready = { kind: 'log', pattern: new RegExp(s.ready.log), source: s.ready.log };
  else if (s.port && s.ready?.port !== false) ready = { kind: 'port', port: s.port };
  else ready = { kind: 'alive', ms: 3000 };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(s.env ?? {})) env[k] = String(v);
  return {
    name,
    cwd,
    cmd: s.cmd,
    docker,
    port: s.port,
    ready,
    dependsOn: s.depends_on ?? [],
    groups: s.group === undefined ? [] : Array.isArray(s.group) ? s.group : [s.group],
    env,
    envFile: s.env_file ? resolvePath(s.env_file, cwd) : undefined,
    python: s.python,
    node: s.node,
    isDefault: s.start_by_default ?? settings.newServicesDefault,
    url: s.url,
    kind: detectKind(s, cwd),
    raw: s,
  };
}

/** Find dependency cycles. Returns the first cycle path found, e.g. [a, b, a]. */
export function findCycle(deps: Record<string, string[]>): string[] | undefined {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (n: string): string[] | undefined => {
    if (state.get(n) === 'done') return undefined;
    if (state.get(n) === 'visiting') return [...stack.slice(stack.indexOf(n)), n];
    state.set(n, 'visiting');
    stack.push(n);
    for (const d of deps[n] ?? []) {
      if (!(d in deps)) continue;
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(n, 'done');
    return undefined;
  };
  for (const n of Object.keys(deps)) {
    const c = visit(n);
    if (c) return c;
  }
  return undefined;
}

/** Validate and normalize a parsed YAML document. Throws SSError(CONFIG_INVALID). */
export function buildConfig(data: unknown, path: string, exists: boolean): Config {
  const parsed = configSchema.safeParse(data ?? {});
  if (!parsed.success) {
    throw new SSError('CONFIG_INVALID', `Config invalid: ${path}`, {
      issues: parsed.error.issues.map(formatZodIssue),
      hint: 'serverstart edit',
      details: { path },
    });
  }
  const raw = parsed.data;
  const rs = raw.settings;
  const settings: Settings = {
    shell: rs.shell,
    readyTimeoutMs: parseDuration(rs.ready_timeout),
    newServicesDefault: rs.new_services_default,
    startOnLogin: rs.start_on_login,
    openDashboardOnLogin: rs.open_dashboard_on_login,
    raw: rs,
  };
  const rawServices = raw.services ?? {};
  const names = Object.keys(rawServices);
  const issues: ConfigIssue[] = [];
  for (const name of names) {
    const s = rawServices[name];
    if (!NAME_RE.test(name)) issues.push({ path: name, message: 'name must be kebab-case (a-z, 0-9, -)' });
    if (!s.docker && !s.cmd) issues.push({ path: `${name}.cmd`, message: 'required (or use docker.compose)' });
    if (!s.docker && !s.cwd) issues.push({ path: `${name}.cwd`, message: 'required (or use docker.compose)' });
    if (s.docker && s.cmd) issues.push({ path: `${name}.cmd`, message: 'not allowed together with docker' });
    for (const dep of s.depends_on ?? []) {
      if (!(dep in rawServices)) {
        const guess = didYouMean(dep, names);
        issues.push({
          path: `${name}.depends_on`,
          message: `unknown service "${dep}"`,
          hint: guess ? `did you mean "${guess}"?` : undefined,
        });
      } else if (dep === name) {
        issues.push({ path: `${name}.depends_on`, message: 'a service cannot depend on itself' });
      }
    }
    if (s.ready?.log) {
      try {
        new RegExp(s.ready.log);
      } catch {
        issues.push({ path: `${name}.ready.log`, message: 'invalid regular expression' });
      }
    }
  }
  if (!issues.length) {
    const cycle = findCycle(Object.fromEntries(names.map((n) => [n, rawServices[n].depends_on ?? []])));
    if (cycle) issues.push({ path: `${cycle[0]}.depends_on`, message: `dependency cycle: ${cycle.join(' → ')}` });
  }
  if (issues.length) {
    throw new SSError('CONFIG_INVALID', `Config invalid: ${path}`, { issues, hint: 'serverstart edit', details: { path } });
  }
  const services: Record<string, Service> = {};
  for (const name of names) services[name] = normalizeService(name, rawServices[name], settings);
  return { path, exists, settings, services, order: names };
}

export function loadConfig(override?: string): Config {
  const path = configPath(override);
  if (!existsSync(path)) return buildConfig({}, path, false);
  let data: unknown;
  try {
    data = parseYaml(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new SSError('CONFIG_INVALID', `Config invalid: ${path}`, {
      issues: [{ path: '(yaml)', message: (e as Error).message.split('\n')[0] }],
      hint: 'serverstart edit',
      details: { path },
    });
  }
  return buildConfig(data, path, true);
}
