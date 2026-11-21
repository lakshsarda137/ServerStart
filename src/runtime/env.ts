import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Service, Settings } from '../config/load.js';
import { resolvePath } from '../paths.js';

/** Parse a dotenv file. Supports comments, `export`, and single/double quotes. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      const dq = v.startsWith('"');
      v = v.slice(1, -1);
      if (dq) v = v.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      v = v.replace(/\s+#.*$/, '');
    }
    out[m[1]] = v;
  }
  return out;
}

/** Service env: env_file first, then `env` on top. */
export function serviceEnv(svc: Service): Record<string, string> {
  const fromFile = svc.envFile && existsSync(svc.envFile) ? parseDotenv(readFileSync(svc.envFile, 'utf8')) : {};
  return { ...fromFile, ...svc.env };
}

/** Only the keys, never the values (PRD §6.2). */
export function redactedEnvKeys(svc: Service): string[] {
  return Object.keys(serviceEnv(svc)).sort();
}

export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function venvPath(svc: Service): string | undefined {
  return svc.python?.venv ? resolvePath(svc.python.venv, svc.cwd) : undefined;
}

/** Node version requested by the service, resolving `.nvmrc`. */
export function nodeVersion(svc: Service): string | undefined {
  const v = svc.node?.version;
  if (!v) return undefined;
  if (v === '.nvmrc' || v === '.node-version') {
    const f = join(svc.cwd, v);
    return existsSync(f) ? readFileSync(f, 'utf8').trim() : undefined;
  }
  return v;
}

/** The shell lines that run before the command: version managers and venv activation. */
export function prefixLines(svc: Service): string[] {
  const lines: string[] = [];
  if (svc.node?.version) {
    const v = svc.node.version === '.nvmrc' || svc.node.version === '.node-version' ? '' : ` ${shQuote(svc.node.version)}`;
    lines.push(
      `if [ -s "\${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then . "\${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use${v} >/dev/null; ` +
        `elif command -v fnm >/dev/null 2>&1; then eval "$(fnm env)" && fnm use${v} >/dev/null; fi`,
    );
  }
  const venv = venvPath(svc);
  if (venv) lines.push(`export VIRTUAL_ENV=${shQuote(venv)}`, `export PATH="$VIRTUAL_ENV/bin:$PATH"`);
  return lines;
}

/** The final exec line. */
export function execLine(svc: Service): string {
  const cmd = svc.cmd ?? 'true';
  if (svc.python?.conda) return `exec conda run --no-capture-output -n ${shQuote(svc.python.conda)} ${cmd}`;
  if (svc.python?.uv) return `exec uv run ${cmd}`;
  return `exec ${cmd}`;
}

export interface Launch {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  script: string;
}

/** `<shell> -lc '<prefix>; exec <cmd>'` in cwd (PRD §6.2). */
export function buildLaunch(svc: Service, settings: Settings): Launch {
  const script = [...prefixLines(svc), execLine(svc)].join('\n');
  const env: NodeJS.ProcessEnv = { ...process.env, ...serviceEnv(svc) };
  // Don't leak ServerStart's own terminal settings into the service.
  delete env.SERVERSTART_CONFIG;
  if (svc.port && env.PORT === undefined) env.PORT = String(svc.port);
  return { file: settings.shell, args: ['-lc', script], cwd: svc.cwd, env, script };
}

export function cmdHash(svc: Service): string {
  return createHash('sha1')
    .update(JSON.stringify([svc.cwd, svc.cmd, svc.python, svc.node, svc.env, svc.envFile]))
    .digest('hex')
    .slice(0, 12);
}
