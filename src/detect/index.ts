import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { RawService } from '../config/schema.js';

export interface Detection {
  kind: 'node' | 'python' | 'docker' | null;
  /** Detected stack labels for display, e.g. ["vite", "react", "pnpm", "node 20.11"]. */
  stack: string[];
  /** Proposed service fields (cwd not included). */
  service: Partial<RawService>;
  name: string;
  /** Where each value came from, e.g. { cmd: "package.json", port: "vite" }. */
  sources: Record<string, string>;
  /** How to make the app itself listen on another port. */
  portHint?: (port: number) => string;
}

export function kebab(s: string): string {
  return (
    s
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'app'
  );
}

const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

function portFromScript(script: string): number | undefined {
  const m = /(?:--port[ =]|-p\s+|PORT=)(\d{2,5})\b/.exec(script);
  return m ? Number(m[1]) : undefined;
}

function detectNode(dir: string, d: Detection): boolean {
  const pkgText = read(join(dir, 'package.json'));
  if (!pkgText) return false;
  let pkg: { name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(pkgText);
  } catch {
    return false;
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const has = (n: string) => n in deps;
  const pm = existsSync(join(dir, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : existsSync(join(dir, 'yarn.lock'))
      ? 'yarn'
      : existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))
        ? 'bun'
        : 'npm';
  const scripts = pkg.scripts ?? {};
  const script = scripts.dev ? 'dev' : scripts.start ? 'start' : undefined;
  const pythonMarkers = ['pyproject.toml', 'requirements.txt', 'manage.py'].some((f) => existsSync(join(dir, f)));
  if (!script && pythonMarkers) return false; // e.g. a package.json that only runs JS tests
  d.kind = 'node';
  if (script) {
    d.service.cmd = `${pm} run ${script}`;
    d.sources.cmd = 'package.json';
  }

  let framework: string | undefined;
  let port: number | undefined;
  let portSource: string | undefined;
  if (has('next')) [framework, port] = ['next', 3000];
  else if (has('astro')) [framework, port] = ['astro', 4321];
  else if (has('@remix-run/dev') || has('@remix-run/react')) [framework, port] = ['remix', has('vite') ? 5173 : 3000];
  else if (has('nuxt')) [framework, port] = ['nuxt', 3000];
  else if (has('@sveltejs/kit')) [framework, port] = ['sveltekit', 5173];
  else if (has('vite')) [framework, port] = ['vite', 5173];
  else if (has('react-scripts')) [framework, port] = ['cra', 3000];
  if (framework) portSource = framework;

  const viteConfig = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts'].find((f) => existsSync(join(dir, f)));
  if (viteConfig) {
    const m = /server\s*:\s*\{[^}]*?port\s*:\s*(\d{2,5})/s.exec(read(join(dir, viteConfig)));
    if (m) [port, portSource] = [Number(m[1]), viteConfig];
  }
  const fromScript = script ? portFromScript(scripts[script]) : undefined;
  if (fromScript) [port, portSource] = [fromScript, 'package.json'];
  if (port) {
    d.service.port = port;
    d.sources.port = portSource!;
  }

  for (const f of ['.nvmrc', '.node-version']) {
    if (existsSync(join(dir, f))) {
      d.service.node = { version: f };
      d.sources['node.version'] = f;
      const v = read(join(dir, f)).trim().replace(/^v/, '');
      d.stack.push(...stackLabels(framework, deps), pm, /^\d/.test(v) ? `node ${v.split('.').slice(0, 2).join('.')}` : 'node');
      break;
    }
  }
  if (!d.service.node) d.stack.push(...stackLabels(framework, deps), pm);

  d.portHint = (p) => {
    if (viteConfig || framework === 'vite' || framework === 'sveltekit') return `set server.port = ${p} in ${viteConfig ?? 'vite.config.ts'}`;
    if (framework === 'next') return `use "next dev -p ${p}" in package.json`;
    if (framework === 'astro') return `set server.port = ${p} in astro.config.mjs`;
    return `set PORT=${p} for the dev script`;
  };
  if (pkg.name) {
    d.name = kebab(pkg.name.replace(/^@[^/]+\//, ''));
    d.sources.name = 'package.json';
  }
  return true;
}

function stackLabels(framework: string | undefined, deps: Record<string, string>): string[] {
  const out: string[] = [];
  if (framework) out.push(framework);
  for (const lib of ['react', 'vue', 'svelte', 'solid-js']) if (lib in deps) out.push(lib.replace('-js', ''));
  return out;
}

function findFile(dir: string, candidates: string[], contains?: RegExp): string | undefined {
  for (const c of candidates) {
    const p = join(dir, c);
    if (existsSync(p) && (!contains || contains.test(read(p)))) return c;
  }
  return undefined;
}

function detectPython(dir: string, d: Detection): boolean {
  const pyproject = read(join(dir, 'pyproject.toml'));
  const reqs = read(join(dir, 'requirements.txt'));
  const hasManage = existsSync(join(dir, 'manage.py'));
  if (!pyproject && !reqs && !hasManage) return false;
  const deps = `${pyproject}\n${reqs}`.toLowerCase();
  const dep = (n: string) => new RegExp(`(^|[\\s"'\\[,])${n}([\\s"'<>=~!\\],;\\[]|$)`, 'm').test(deps);
  d.kind = 'python';
  const src = pyproject ? 'pyproject.toml' : 'requirements.txt';

  if (hasManage || dep('django')) {
    d.service.cmd = 'python manage.py runserver 8000';
    d.service.port = 8000;
    d.stack.push('django');
    d.sources.cmd = hasManage ? 'manage.py' : src;
    d.portHint = (p) => `run "python manage.py runserver ${p}"`;
  } else if (dep('fastapi') || dep('uvicorn')) {
    const subdirs = listDir(dir).filter((f) => !f.startsWith('.') && !['node_modules', 'venv', 'tests', 'test', 'dist', 'build'].includes(f) && existsSync(join(dir, f, '__init__.py')));
    const candidates = ['main.py', 'app.py', 'api.py', 'server.py', ...subdirs.flatMap((sd) => ['main.py', 'app.py', 'api.py', 'server.py'].map((f) => `${sd}/${f}`)), 'src/main.py'];
    const file = findFile(dir, candidates, /FastAPI\(|Starlette\(/) ?? 'main.py';
    const mod = file.replace(/\.py$/, '').replace(/\//g, '.');
    d.service.cmd = `uvicorn ${mod}:app --reload --port 8000`;
    d.service.port = 8000;
    d.stack.push('fastapi');
    d.sources.cmd = src;
    d.portHint = (p) => `pass --port ${p} to uvicorn`;
  } else if (dep('flask')) {
    d.service.cmd = 'flask run --port 5000';
    d.service.port = 5000;
    d.stack.push('flask');
    d.sources.cmd = src;
    d.portHint = (p) => `pass --port ${p} to flask run`;
  } else if (dep('streamlit')) {
    const file = findFile(dir, ['streamlit_app.py', 'app.py', 'main.py'], /import streamlit|from streamlit/) ?? 'app.py';
    d.service.cmd = `streamlit run ${file} --server.port 8501`;
    d.service.port = 8501;
    d.stack.push('streamlit');
    d.sources.cmd = src;
    d.portHint = (p) => `pass --server.port ${p} to streamlit`;
  }
  if (d.service.port) d.sources.port = d.stack[0];

  if (existsSync(join(dir, 'uv.lock'))) {
    d.service.python = { uv: true };
    d.sources.python = 'uv.lock';
    d.stack.push('uv');
  } else {
    const venv = ['.venv', 'venv'].find((v) => existsSync(join(dir, v, 'bin')));
    if (venv) {
      d.service.python = { venv };
      d.sources.python = venv;
    }
  }
  const pyv = read(join(dir, '.python-version')).trim();
  d.stack.push(pyv ? `python ${pyv.split('.').slice(0, 2).join('.')}` : 'python');
  return true;
}

export const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];

export function composeServices(file: string): { name: string; port?: number }[] {
  try {
    const doc = parseYaml(read(file)) as { services?: Record<string, { ports?: (string | number | { published?: string | number })[] }> };
    return Object.entries(doc?.services ?? {}).map(([name, s]) => {
      let port: number | undefined;
      for (const p of s?.ports ?? []) {
        if (typeof p === 'object' && p.published) port = Number(p.published);
        else if (typeof p === 'string' || typeof p === 'number') {
          const parts = String(p).split(':');
          if (parts.length >= 2) port = Number(parts[parts.length - 2].split('-')[0]);
        }
        if (port) break;
      }
      return { name, port: port && !Number.isNaN(port) ? port : undefined };
    });
  } catch {
    return [];
  }
}

function detectDocker(dir: string, d: Detection, composeFile?: string): boolean {
  const file = composeFile ?? COMPOSE_FILES.map((f) => join(dir, f)).find((f) => existsSync(f));
  if (!file) return false;
  const services = composeServices(file);
  d.kind = 'docker';
  d.service.docker = { compose: file };
  d.sources.docker = basename(file);
  const withPort = services.find((s) => s.port);
  if (services.length > 1 && withPort) d.service.docker.service = withPort.name;
  if (withPort?.port) {
    d.service.port = withPort.port;
    d.sources.port = basename(file);
  }
  d.stack.push('docker', ...(withPort ? [withPort.name] : []));
  d.portHint = (p) => `publish "${p}:<container port>" in ${basename(file)}`;
  return true;
}

/** Inspect a project folder and propose a service entry (PRD §7.4). */
export function detect(dir: string, opts: { preferDocker?: boolean; composeFile?: string } = {}): Detection {
  const d: Detection = { kind: null, stack: [], service: {}, name: kebab(basename(dir)), sources: { name: 'folder' } };
  if (!existsSync(dir)) return d;
  if (opts.preferDocker || opts.composeFile) {
    detectDocker(dir, d, opts.composeFile);
    return d;
  }
  if (detectNode(dir, d)) return d;
  if (detectPython(dir, d)) return d;
  detectDocker(dir, d);
  return d;
}

export function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
