import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import type { Config, Service } from './config/load.js';
import { EXIT } from './errors.js';
import { loginStatus } from './login.js';
import { c, pad, pal } from './output/term.js';
import { home, tildify } from './paths.js';
import { dockerInstalled, dockerVersion } from './runtime/docker.js';
import { prefixLines, venvPath } from './runtime/env.js';
import { listeners, portOpen } from './runtime/ports.js';
import { getStatuses } from './runtime/status.js';
import { skillStatus } from './skill.js';

type Level = 'pass' | 'warn' | 'fail';

interface Check {
  section: 'ENVIRONMENT' | 'SERVICES' | 'LOGIN AND SKILL';
  name: string;
  status: Level;
  detail: string;
  fix?: string;
}

function hasDependencies(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies?: object; devDependencies?: object };
    return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0;
  } catch {
    return false;
  }
}

function firstWord(cmd: string): string {
  const words = cmd.trim().split(/\s+/);
  let i = 0;
  while (i < words.length && /^[A-Z_][A-Z0-9_]*=/.test(words[i])) i++; // skip VAR=value
  return words[i] ?? '';
}

async function serviceChecks(svc: Service, config: Config, held: Map<number, { pid: number; command: string }>): Promise<Check> {
  const name = svc.name;
  const ok = (detail: string): Check => ({ section: 'SERVICES', name, status: 'pass', detail });
  const bad = (status: Level, detail: string, fix?: string): Check => ({ section: 'SERVICES', name, status, detail, fix });
  if (svc.docker) {
    if (!existsSync(svc.docker.compose)) return bad('fail', `compose file missing   ${tildify(svc.docker.compose)}`, 'serverstart edit');
    const h = svc.port ? held.get(svc.port) : undefined;
    if (h) return bad('warn', `port ${svc.port} in use   ${h.command} ${h.pid}`, `serverstart up ${name} --kill-port`);
    return ok('compose file found');
  }
  if (!existsSync(svc.cwd)) return bad('fail', `cwd missing   ${tildify(svc.cwd)}`, 'serverstart edit');
  const venv = venvPath(svc);
  if (venv && !existsSync(venv)) return bad('fail', `${svc.python!.venv} missing   ${tildify(venv)}`, `cd ${tildify(svc.cwd)} && python3 -m venv ${svc.python!.venv}`);
  if (svc.kind === 'node' && hasDependencies(svc.cwd) && !existsSync(join(svc.cwd, 'node_modules'))) {
    const pm = existsSync(join(svc.cwd, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(svc.cwd, 'yarn.lock')) ? 'yarn' : existsSync(join(svc.cwd, 'bun.lockb')) ? 'bun' : 'npm';
    return bad('fail', 'node_modules missing', `cd ${tildify(svc.cwd)} && ${pm} install`);
  }
  const word = svc.python?.uv ? 'uv' : svc.python?.conda ? 'conda' : firstWord(svc.cmd ?? '');
  if (word && !word.includes('/')) {
    const script = [...prefixLines(svc), `command -v ${word}`].join('\n');
    const r = await execa(config.settings.shell, ['-lc', script], { cwd: svc.cwd, reject: false, timeout: 10000 });
    if (r.exitCode !== 0) return bad('fail', `${word} not found on PATH`, venv ? `${tildify(venv)}/bin/pip install ${word}` : `install ${word}`);
  }
  const h = svc.port ? held.get(svc.port) : undefined;
  if (h) return bad('warn', `port ${svc.port} in use   ${h.command} ${h.pid}`, `serverstart up ${name} --kill-port`);
  return ok([venv ? `${svc.python!.venv} found` : '', word ? `${word} found` : ''].filter(Boolean).join('   ') || 'ok');
}

export async function collectChecks(config: Config): Promise<Check[]> {
  const checks: Check[] = [];
  const env = (name: string, status: Level, detail: string, fix?: string) => checks.push({ section: 'ENVIRONMENT', name, status, detail, fix });

  const usesDocker = config.order.some((n) => config.services[n].docker);
  const dv = await dockerVersion();
  if (dv) env('Docker Desktop', 'pass', `running   v${dv}`);
  else if (await dockerInstalled()) env('Docker Desktop', usesDocker ? 'warn' : 'pass', 'not running', usesDocker ? 'open -a Docker' : undefined);
  else env('Docker Desktop', usesDocker ? 'fail' : 'pass', 'not installed', usesDocker ? 'brew install --cask docker' : undefined);

  const shell = await execa('/bin/sh', ['-c', `command -v ${config.settings.shell}`], { reject: false });
  env('Login shell', shell.exitCode === 0 ? 'pass' : 'fail', config.settings.shell, shell.exitCode === 0 ? undefined : 'serverstart settings set shell zsh');

  const nvmDir = process.env.NVM_DIR ?? join(home(), '.nvm');
  const hasNvm = existsSync(join(nvmDir, 'nvm.sh'));
  const fnm = (await execa(config.settings.shell, ['-lc', 'command -v fnm'], { reject: false, timeout: 8000 })).exitCode === 0;
  const needsManager = config.order.some((n) => config.services[n].node?.version);
  if (hasNvm || fnm) env('Node manager', 'pass', hasNvm ? 'nvm' : 'fnm');
  else env('Node manager', needsManager ? 'warn' : 'pass', needsManager ? 'none   node.version is ignored' : 'none', needsManager ? 'brew install fnm' : undefined);
  env('Config', 'pass', `valid   ${config.order.length} services`);

  // who holds configured ports but isn't ours
  const statuses = await getStatuses(config);
  const held = new Map<number, { pid: number; command: string }>();
  for (const s of statuses) {
    if (s.state === 'external' && s.port && s.external) held.set(s.port, s.external);
    else if (s.state === 'stopped' && s.port && (await portOpen(s.port, 200))) {
      const l = (await listeners(s.port))[0];
      if (l) held.set(s.port, l);
    }
  }
  checks.push(...(await Promise.all(config.order.map((n) => serviceChecks(config.services[n], config, held)))));

  const login = loginStatus(config);
  checks.push({ section: 'LOGIN AND SKILL', name: 'LaunchAgent', status: login.matches ? 'pass' : 'warn', detail: login.detail, fix: login.matches ? undefined : `serverstart settings set start_on_login ${login.enabled}` });
  const skill = skillStatus();
  if (!skill.installed) checks.push({ section: 'LOGIN AND SKILL', name: 'Claude Code skill', status: 'warn', detail: 'not installed', fix: 'serverstart install-skill' });
  else if (skill.installedVersion < skill.bundledVersion)
    checks.push({ section: 'LOGIN AND SKILL', name: 'Claude Code skill', status: 'warn', detail: `v${skill.installedVersion} installed   v${skill.bundledVersion} bundled`, fix: 'serverstart install-skill --force' });
  else checks.push({ section: 'LOGIN AND SKILL', name: 'Claude Code skill', status: 'pass', detail: `v${skill.installedVersion} installed` });
  return checks;
}

export async function runDoctor(config: Config, opts: { json: boolean }): Promise<number> {
  const checks = await collectChecks(config);
  const count = (l: Level) => checks.filter((x) => x.status === l).length;
  const code = count('fail') ? EXIT.ENV : EXIT.OK;
  if (opts.json) {
    process.stdout.write(JSON.stringify({ checks, passed: count('pass'), warnings: count('warn'), failed: count('fail') }, null, 2) + '\n');
    return code;
  }
  const p = pal();
  const plain = !process.stdout.isTTY;
  const glyph = { pass: c(p.ok, '✓'), warn: c(p.warn, '!'), fail: c(p.err, '✕') };
  const lines: string[] = [];
  let section = '';
  for (const ch of checks) {
    if (ch.section !== section) {
      if (section) lines.push('');
      section = ch.section;
      lines.push(plain ? section : '  ' + c(p.label, section, { bold: true }));
    }
    if (plain) {
      lines.push(`${ch.status.padEnd(5)} ${ch.name.padEnd(22)} ${ch.detail}${ch.fix ? `   fix: ${ch.fix}` : ''}`);
      continue;
    }
    const detailColor = ch.status === 'fail' ? p.err : ch.status === 'warn' ? p.warn : p.muted;
    lines.push('  ' + glyph[ch.status] + ' ' + pad(c(p.text, ch.name), 24) + c(detailColor, ch.detail));
    if (ch.fix) lines.push('  ' + ' '.repeat(26) + c(p.accent, '→ ') + c(p.cmd, ch.fix));
  }
  lines.push('');
  lines.push(
    plain
      ? `${count('pass')} passed   ${count('warn')} warnings   ${count('fail')} failed`
      : '  ' + c(p.ok, `✓ ${count('pass')} passed`) + '   ' + c(p.warn, `! ${count('warn')} warnings`) + '   ' + c(p.err, `✕ ${count('fail')} failed`),
  );
  process.stdout.write(lines.join('\n') + '\n');
  return code;
}
