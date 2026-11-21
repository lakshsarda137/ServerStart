import { homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';

export function home(): string {
  return process.env.HOME || homedir();
}

/** Expand a leading `~` to the home directory. */
export function expandHome(p: string): string {
  if (p === '~') return home();
  if (p.startsWith('~/')) return join(home(), p.slice(2));
  return p;
}

/** Collapse the home directory back to `~` for display. */
export function tildify(p: string): string {
  const h = home();
  if (p === h) return '~';
  if (p.startsWith(h + '/')) return '~' + p.slice(h.length);
  return p;
}

/** Resolve `p` (which may use `~`) relative to `base` when it isn't absolute. */
export function resolvePath(p: string, base?: string): string {
  const e = expandHome(p);
  if (isAbsolute(e)) return e;
  return resolve(base ?? process.cwd(), e);
}

export function configPath(override?: string): string {
  if (override) return resolvePath(override);
  if (process.env.SERVERSTART_CONFIG) return resolvePath(process.env.SERVERSTART_CONFIG);
  const base = process.env.XDG_CONFIG_HOME ? expandHome(process.env.XDG_CONFIG_HOME) : join(home(), '.config');
  return join(base, 'serverstart', 'serverstart.yaml');
}

export function stateDir(): string {
  const base = process.env.XDG_STATE_HOME ? expandHome(process.env.XDG_STATE_HOME) : join(home(), '.local', 'state');
  return join(base, 'serverstart');
}

export function statePath(): string {
  return join(stateDir(), 'state.json');
}

export function logsDir(): string {
  return join(stateDir(), 'logs');
}

export function logPath(service: string): string {
  return join(logsDir(), `${service}.log`);
}
