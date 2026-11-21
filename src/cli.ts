import { Command, Option } from 'commander';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { stringify as yamlStringify } from 'yaml';
import { loadConfig, type Config } from './config/load.js';
import { SETTING_KEYS, jsonSchema, type RawService } from './config/schema.js';
import { addService, atomicWrite, editConfig, readDocument, removeService, setServiceField, setSetting } from './config/write.js';
import { detect } from './detect/index.js';
import { EXIT, SSError, didYouMean } from './errors.js';
import { impliedDefaults, resolveTargets, withDependencies } from './graph.js';
import { renderError, renderLs, renderStatus, upLine, upSummary, downLine, downSummary } from './output/format.js';
import { applyTheme, c, detectColorMode, envTheme, pal, setColorMode } from './output/term.js';
import { configPath, logPath, resolvePath, tildify } from './paths.js';
import { Engine, type UpOutcome } from './runtime/engine.js';
import { composeLogsArgs } from './runtime/docker.js';
import { redactedEnvKeys } from './runtime/env.js';
import { follow, tail, SEPARATOR_RE, stripAnsi } from './runtime/logs.js';
import { nextFreePort } from './runtime/ports.js';
import { getStatuses, serviceUrl } from './runtime/status.js';

const VERSION = '0.1.0';

interface Globals {
  json?: boolean;
  color?: boolean;
  config?: string;
  quiet?: boolean;
  verbose?: boolean;
}

let globals: Globals = {};

/** Interactive = a real terminal, no --json, not CI (PRD §7.1). */
function interactive(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY && !globals.json && !process.env.CI);
}

function out(s: string): void {
  process.stdout.write(s + '\n');
}

function printJson(v: unknown): void {
  process.stdout.write(JSON.stringify(v, null, 2) + '\n');
}

function cfg(): Config {
  return loadConfig(globals.config);
}

function requireService(config: Config, name: string) {
  if (config.services[name]) return config.services[name];
  const guess = didYouMean(name, config.order);
  throw new SSError('NOT_FOUND', `unknown service "${name}"`, { hint: guess ? `did you mean "${guess}"?` : 'serverstart ls' });
}

async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
  const p = pal();
  const choices = defaultYes ? `${c(p.accent, 'Y')} ${c(p.faint, '/')} ${c(p.accent, 'n')}` : `${c(p.accent, 'y')} ${c(p.faint, '/')} ${c(p.accent, 'N')}`;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer: string = await new Promise((r) => rl.question(`  ${c(p.text, question)}   ${choices}  `, r));
  rl.close();
  const a = answer.trim().toLowerCase();
  if (!a) return defaultYes;
  return a === 'y' || a === 'yes';
}

function openUrl(url: string): void {
  spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
}

// ── up / down / restart ────────────────────────────────────────────────────────

async function cmdUp(targets: string[], opts: { killPort?: boolean; dash?: boolean }): Promise<number> {
  const config = cfg();
  const names = resolveTargets(config, targets);
  if (interactive() && !globals.quiet && opts.dash !== false) {
    const { runDashboard } = await import('./ui/run.js');
    await runDashboard({ config, configOverride: globals.config, up: names, killPort: opts.killPort });
    return EXIT.OK;
  }
  if (!names.length) {
    if (globals.json) printJson({ services: [], ok: true });
    else if (!globals.quiet) out(interactive() ? '  ' + c(pal().muted, '0 services in the default set') : '0 services in the default set');
    return EXIT.OK;
  }
  const engine = new Engine(config);
  let outcomes: UpOutcome[];
  if (interactive()) {
    const { runProgress } = await import('./ui/run.js');
    outcomes = (await runProgress({ engine, kind: 'up', names: withDependencies(config, names), run: () => engine.up(names, { killPort: opts.killPort }) })) as UpOutcome[];
    out('');
    out(upSummary(outcomes));
  } else {
    if (!globals.json && !globals.quiet) out(`serverstart up ${targets.join(' ') || '(default set)'}   ${withDependencies(config, names).length} services`);
    engine.on('docker', (s) => {
      if (s === 0 && !globals.json && !globals.quiet) out('starting Docker Desktop');
    });
    outcomes = await engine.up(names, { killPort: opts.killPort });
    if (globals.json) printJson({ services: outcomes, ok: outcomes.every((o) => o.state === 'ready') });
    else {
      const nw = Math.max(17, ...outcomes.map((o) => o.name.length + 2));
      for (const o of outcomes) if (!globals.quiet || o.state !== 'ready') out(upLine(o, nw));
      out(upSummary(outcomes));
    }
  }
  return outcomes.every((o) => o.state === 'ready') ? EXIT.OK : EXIT.FAILED;
}

async function cmdDown(targets: string[]): Promise<number> {
  const config = cfg();
  const names = resolveTargets(config, targets, { emptyMeansAll: true });
  const engine = new Engine(config);
  const before = await getStatuses(config);
  const wasUp = new Set(before.filter((s) => ['ready', 'starting', 'crashed'].includes(s.state)).map((s) => s.name));
  const toStop = names.filter((n) => wasUp.has(n) || config.services[n].docker);
  if (!toStop.length) {
    if (globals.json) printJson({ services: [], ok: true });
    else if (!globals.quiet) out(interactive() ? '  ' + c(pal().muted, '0 running') : '0 running');
    return EXIT.OK;
  }
  const outcomes = interactive()
    ? ((await (await import('./ui/run.js')).runProgress({ engine, kind: 'down', names: toStop, run: () => engine.down(toStop) })) as Awaited<ReturnType<Engine['down']>>)
    : await engine.down(toStop);
  const wasRunning = new Set(before.filter((s) => s.state === 'ready' || s.state === 'starting').map((s) => s.name));
  const ports = outcomes.filter((o) => o.state === 'stopped' && wasRunning.has(o.name)).map((o) => config.services[o.name].port).filter((p): p is number => !!p);
  if (globals.json) printJson({ services: outcomes, ok: outcomes.every((o) => o.state !== 'failed') });
  else {
    const nw = Math.max(17, ...outcomes.map((o) => o.name.length + 2));
    if (!interactive()) for (const o of outcomes) if (!globals.quiet || o.state === 'failed') out(downLine(o, nw));
    if (interactive()) out('');
    out(downSummary(outcomes, ports));
  }
  return outcomes.some((o) => o.state === 'failed') ? EXIT.FAILED : EXIT.OK;
}

async function cmdRestart(targets: string[], opts: { killPort?: boolean }): Promise<number> {
  const config = cfg();
  const names = resolveTargets(config, targets);
  const engine = new Engine(config);
  if (interactive() && !globals.quiet) {
    const { runProgress } = await import('./ui/run.js');
    const outcomes = (await runProgress({ engine, kind: 'up', names: withDependencies(config, names), run: () => engine.restart(names, { killPort: opts.killPort }) })) as UpOutcome[];
    out('');
    out(upSummary(outcomes));
    return outcomes.every((o) => o.state === 'ready') ? EXIT.OK : EXIT.FAILED;
  }
  const outcomes = await engine.restart(names, { killPort: opts.killPort });
  if (globals.json) printJson({ services: outcomes, ok: outcomes.every((o) => o.state === 'ready') });
  else {
    const nw = Math.max(17, ...outcomes.map((o) => o.name.length + 2));
    for (const o of outcomes) out(upLine(o, nw));
    out(upSummary(outcomes));
  }
  return outcomes.every((o) => o.state === 'ready') ? EXIT.OK : EXIT.FAILED;
}

// ── status / ls / logs / open ─────────────────────────────────────────────────

async function cmdStatus(): Promise<number> {
  const config = cfg();
  const statuses = await getStatuses(config);
  if (globals.json) printJson({ services: statuses });
  else out(renderStatus(statuses));
  return EXIT.OK;
}

function cmdLs(): number {
  const config = cfg();
  if (globals.json) {
    const implied = impliedDefaults(config);
    printJson({
      config: config.path,
      services: config.order.map((n) => {
        const s = config.services[n];
        return {
          name: n,
          kind: s.kind,
          port: s.port ?? null,
          url: serviceUrl(s),
          cwd: s.cwd,
          cmd: s.cmd ?? null,
          docker: s.docker ?? null,
          group: s.groups,
          depends_on: s.dependsOn,
          default: s.isDefault,
          implied_by: implied.get(n) ?? null,
          ready: s.ready.kind === 'log' ? { kind: 'log', pattern: s.ready.source } : s.ready,
          env_keys: redactedEnvKeys(s),
          log: logPath(n),
        };
      }),
    });
  } else out(renderLs(config));
  return EXIT.OK;
}

function colorLogLine(line: string): string {
  const p = pal();
  const plainLine = stripAnsi(line);
  if (SEPARATOR_RE.test(plainLine)) return c(p.line, plainLine);
  if (/\b[A-Z]\w*(Error|Exception)\b|Traceback|^\s*Error:|\bERROR\b|\bERR!|EADDRINUSE/.test(plainLine)) return c(p.err, plainLine);
  if (/\bWARN(ING)?\b/.test(plainLine)) return c(p.warn, plainLine);
  if (/^\s*(INFO|DEBUG)\b/.test(plainLine)) return c(p.logInfo, plainLine.slice(0, plainLine.indexOf(':') + 1 || 5)) + c(p.text, plainLine.slice(plainLine.indexOf(':') + 1 || 5));
  return c(p.text, plainLine);
}

async function cmdLogs(name: string, opts: { follow?: boolean; lines: string }): Promise<number> {
  const config = cfg();
  const svc = requireService(config, name);
  const n = Number(opts.lines) || 100;
  if (svc.docker) {
    const r = spawnSync('docker', composeLogsArgs(svc.docker.compose, svc.docker.service, !!opts.follow, n), { stdio: 'inherit' });
    return r.status === 0 ? EXIT.OK : EXIT.ENV;
  }
  const path = logPath(name);
  const tty = process.stdout.isTTY && !globals.json;
  const fmt = (l: string) => (tty ? colorLogLine(l) : stripAnsi(l));
  if (!existsSync(path)) {
    if (!opts.follow) {
      out(tty ? '  ' + c(pal().muted, `no log yet   ${tildify(path)}`) : `no log yet: ${path}`);
      return EXIT.OK;
    }
  }
  for (const l of tail(path, n)) out(fmt(l));
  if (!opts.follow) return EXIT.OK;
  const p = pal();
  const pin = tty ? c(p.ok, 'FOLLOWING', { bold: true }) + ' ' + c(p.text, name) + '   ' + c(p.accent, 'ctrl-c') + ' ' + c(p.muted, 'stop') : '';
  if (tty) process.stdout.write(pin);
  let partial = '';
  const { statSync } = await import('node:fs');
  const start = existsSync(path) ? statSync(path).size : 0;
  follow(path, start, (text) => {
    const lines = (partial + text).split('\n');
    partial = lines.pop() ?? '';
    if (tty) process.stdout.write('\r\u001b[2K');
    for (const l of lines) out(fmt(l));
    if (tty) process.stdout.write(pin);
  });
  await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
  if (tty) process.stdout.write('\r\u001b[2K');
  return EXIT.OK;
}

async function cmdOpen(name: string, opts: { yes?: boolean }): Promise<number> {
  const config = cfg();
  const svc = requireService(config, name);
  const url = serviceUrl(svc);
  if (!url) throw new SSError('USAGE', `${name} has no port or url`, { hint: `serverstart edit` });
  const st = (await getStatuses(config)).find((s) => s.name === name)!;
  if (!['ready', 'starting', 'external'].includes(st.state)) {
    const start = opts.yes || (interactive() ? await confirm(`${name} is ${st.state}. Start it?`, true) : false);
    if (start) {
      const code = await cmdUp([name], { dash: false });
      if (code !== EXIT.OK) return code;
    }
  }
  openUrl(url);
  if (globals.json) printJson({ name, url });
  else out(interactive() ? '  ' + c(pal().path, '↗ ' + url) : url);
  return EXIT.OK;
}

// ── add / remove / edit ───────────────────────────────────────────────────────

interface AddFlags {
  name?: string;
  cwd?: string;
  cmd?: string;
  port?: string;
  group: string[];
  dependsOn: string[];
  pythonVenv?: string;
  conda?: string;
  uv?: boolean;
  nodeVersion?: string;
  readyHttp?: string;
  readyLog?: string;
  env: string[];
  envFile?: string;
  default?: boolean;
  dockerCompose?: string;
  dockerService?: string;
  detect?: boolean;
  dryRun?: boolean;
  force?: boolean;
}

const ADD_USAGE =
  'serverstart add --name <kebab> --cwd <abs path> --cmd "<cmd>" --port <n> [--group <g>] [--depends-on <svc>] [--python-venv <dir> | --conda <env> | --uv] [--node-version <v|.nvmrc>] [--ready-http <url> | --ready-log <regex>] [--env KEY=VAL] [--env-file <path>] [--no-default] [--docker-compose <file> [--docker-service <svc>]] [--detect] [--dry-run] [--force]';

async function cmdAdd(flags: AddFlags, rawArgs: string[]): Promise<number> {
  const config = cfg();
  const noFlags = rawArgs.filter((a) => a.startsWith('--') && !['--json', '--no-color', '--quiet', '--verbose'].includes(a) && !a.startsWith('--config')).length === 0;
  if (noFlags && interactive()) {
    const { runAddWizard } = await import('./ui/run.js');
    return runAddWizard({ config, configOverride: globals.config });
  }

  const cwd = flags.cwd ? resolvePath(flags.cwd) : flags.detect || flags.dockerCompose ? process.cwd() : undefined;
  const det = flags.detect && cwd ? detect(cwd, { composeFile: flags.dockerCompose ? resolvePath(flags.dockerCompose) : undefined }) : undefined;
  const name = flags.name ?? det?.name;
  const missing: string[] = [];
  if (!name) missing.push('--name');
  const isDocker = Boolean(flags.dockerCompose || (det?.kind === 'docker' && !flags.cmd));
  if (!isDocker) {
    if (!cwd) missing.push('--cwd');
    if (!flags.cmd && !det?.service.cmd) missing.push('--cmd');
  }
  if (missing.length) {
    throw new SSError('USAGE', `missing ${missing.join(', ')}`, { hint: ADD_USAGE });
  }

  const svc: RawService = {};
  if (isDocker) {
    const compose = flags.dockerCompose ? resolvePath(flags.dockerCompose) : det!.service.docker!.compose;
    svc.docker = { compose: tildify(compose), ...((flags.dockerService ?? det?.service.docker?.service) ? { service: flags.dockerService ?? det?.service.docker?.service } : {}) };
  } else {
    svc.cwd = tildify(cwd!);
    svc.cmd = flags.cmd ?? det!.service.cmd;
  }
  const port = flags.port ? Number(flags.port) : det?.service.port;
  if (flags.port && (!Number.isInteger(port) || port! < 1 || port! > 65535)) throw new SSError('USAGE', `invalid --port "${flags.port}"`);
  if (port) svc.port = port;
  if (flags.readyHttp) svc.ready = { http: flags.readyHttp };
  else if (flags.readyLog) svc.ready = { log: flags.readyLog };
  if (flags.dependsOn.length) svc.depends_on = flags.dependsOn;
  if (flags.group.length) svc.group = flags.group.length === 1 ? flags.group[0] : flags.group;
  if (flags.pythonVenv) svc.python = { venv: flags.pythonVenv };
  else if (flags.conda) svc.python = { conda: flags.conda };
  else if (flags.uv) svc.python = { uv: true };
  else if (det?.service.python && !isDocker) svc.python = det.service.python;
  if (flags.nodeVersion) svc.node = { version: flags.nodeVersion };
  else if (det?.service.node && !isDocker) svc.node = det.service.node;
  if (flags.env.length) {
    svc.env = {};
    for (const kv of flags.env) {
      const i = kv.indexOf('=');
      if (i < 1) throw new SSError('USAGE', `invalid --env "${kv}" (expected KEY=VAL)`);
      svc.env[kv.slice(0, i)] = kv.slice(i + 1);
    }
  }
  if (flags.envFile) svc.env_file = flags.envFile;
  svc.start_by_default = flags.default === false ? false : config.settings.newServicesDefault;

  // Conflicts
  const exists = name! in config.services;
  if (exists && !flags.force) throw new SSError('NAME_EXISTS', `service "${name}" already exists`, { hint: 'use --force to replace it, or pick another --name' });
  let portConflict: { with: string; suggested_port: number; app_hint: string | null } | null = null;
  if (port) {
    const other = config.order.find((n) => n !== name && config.services[n].port === port);
    if (other) {
      const taken = config.order.filter((n) => n !== name).map((n) => config.services[n].port!).filter(Boolean);
      const suggested = await nextFreePort(port + 1, taken);
      portConflict = { with: other, suggested_port: suggested, app_hint: det?.portHint?.(suggested) ?? null };
      if (!flags.dryRun) {
        throw new SSError('PORT_CONFLICT', `port ${port} is used by ${other}`, {
          hint: `next free port: ${suggested}${portConflict.app_hint ? `; then ${portConflict.app_hint}` : ''}`,
          details: { conflict_with: other, suggested_port: suggested, app_hint: portConflict.app_hint },
        });
      }
    }
  }

  const result = {
    name: name!,
    service: svc,
    written: false,
    dry_run: !!flags.dryRun,
    config: configPath(globals.config),
    detected: det ? { kind: det.kind, stack: det.stack, sources: det.sources } : null,
    port_conflict: portConflict,
  };
  if (!flags.dryRun) {
    editConfig(globals.config, (doc) => {
      if (exists) removeService(doc, name!);
      addService(doc, name!, svc);
    });
    result.written = true;
  }
  if (globals.json) printJson(result);
  else if (!interactive()) out(flags.dryRun ? yamlStringify({ [name!]: svc }).trimEnd() : `added ${name}   ${result.config}`);
  else {
    const p = pal();
    if (flags.dryRun) {
      out('  ' + c(p.accent, '+ ') + c(p.text, name!) + '   ' + c(p.muted, 'dry run'));
      out(
        yamlStringify({ [name!]: svc })
          .trimEnd()
          .split('\n')
          .map((l) => '    ' + l)
          .join('\n'),
      );
      if (portConflict) out('  ' + c(p.warn, '!') + ' ' + c(p.text, `${port} taken by ${portConflict.with}`) + '   ' + c(p.muted, 'free: ') + c(p.port, portConflict.suggested_port));
    } else out('  ' + c(p.ok, '✓') + ' ' + c(p.text, name!) + '   ' + c(p.muted, 'added') + '   ' + c(p.path, tildify(result.config)));
  }
  return EXIT.OK;
}

async function cmdRemove(name: string, opts: { yes?: boolean }): Promise<number> {
  const config = cfg();
  requireService(config, name);
  const st = (await getStatuses(config)).find((s) => s.name === name)!;
  const running = ['ready', 'starting'].includes(st.state);
  if (running && interactive() && !opts.yes) {
    const ok = await confirm(`Stop and remove ${name} (running, port ${st.port ?? '–'})?`, false);
    if (!ok) return EXIT.OK;
  }
  if (running || st.state === 'crashed') await new Engine(config).down([name]);
  editConfig(globals.config, (doc) => removeService(doc, name));
  if (globals.json) printJson({ name, removed: true, stopped: running });
  else out(interactive() ? '  ' + c(pal().ok, '✓') + ' ' + c(pal().text, name) + '   ' + c(pal().muted, 'removed') : `removed ${name}`);
  return EXIT.OK;
}

async function cmdEdit(): Promise<number> {
  const path = configPath(globals.config);
  if (!existsSync(path)) atomicWrite(path, readDocument(path).toString());
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
  while (true) {
    spawnSync(`${editor} ${JSON.stringify(path)}`, { stdio: 'inherit', shell: true });
    try {
      const config = loadConfig(globals.config);
      const p = pal();
      out(interactive() ? '  ' + c(p.ok, '✓ config valid') + '   ' + c(p.text, `${config.order.length} services`) : `config valid: ${config.order.length} services`);
      return EXIT.OK;
    } catch (e) {
      if (!(e instanceof SSError) || !interactive()) throw e;
      process.stderr.write(renderError(e, { showHint: false }) + '\n\n');
      if (!(await confirm('Reopen in $EDITOR?', true))) return e.exitCode;
    }
  }
}

// ── settings / default ────────────────────────────────────────────────────────

function parseSettingValue(key: string, value: string): unknown {
  if (['new_services_default', 'start_on_login', 'open_dashboard_on_login'].includes(key)) {
    if (!['true', 'false', 'on', 'off', 'yes', 'no'].includes(value)) throw new SSError('USAGE', `${key} expects true or false`);
    return ['true', 'on', 'yes'].includes(value);
  }
  return value;
}

async function cmdSettingsSet(key: string, value: string): Promise<number> {
  if (!SETTING_KEYS.includes(key as never)) throw new SSError('USAGE', `unknown setting "${key}"`, { hint: `one of: ${SETTING_KEYS.join(', ')}` });
  const config = editConfig(globals.config, (doc) => setSetting(doc, key, parseSettingValue(key, value)));
  let login: { ok: boolean; message: string } | null = null;
  if (key === 'start_on_login' || key === 'open_dashboard_on_login') {
    const { applyLoginSetting } = await import('./login.js');
    login = await applyLoginSetting(config);
  }
  if (globals.json) printJson({ settings: config.settings.raw, login });
  else {
    const p = pal();
    out(interactive() ? '  ' + c(p.ok, '✓') + ' ' + c(p.text, key) + '   ' + c(p.accent, value) : `${key} = ${value}`);
    if (login) out(interactive() ? '  ' + c(login.ok ? p.ok : p.err, (login.ok ? '✓ ' : '✕ ') + login.message) : login.message);
  }
  return login && !login.ok ? EXIT.ENV : EXIT.OK;
}

async function cmdSettings(): Promise<number> {
  const config = cfg();
  if (interactive()) {
    const { runSettings } = await import('./ui/run.js');
    await runSettings({ config, configOverride: globals.config });
    return EXIT.OK;
  }
  const implied = impliedDefaults(config);
  const data = {
    config: config.path,
    settings: config.settings.raw,
    default_set: config.order.filter((n) => config.services[n].isDefault),
    implied: Object.fromEntries(implied),
  };
  if (globals.json) printJson(data);
  else {
    for (const [k, v] of Object.entries(config.settings.raw)) out(`${k}: ${v}`);
    out(`default set: ${data.default_set.join(' ') || '-'}`);
  }
  return EXIT.OK;
}

function cmdDefault(action: string, targets: string[]): number {
  const config = cfg();
  if (action === 'ls') {
    const implied = impliedDefaults(config);
    const defaults = config.order.filter((n) => config.services[n].isDefault);
    if (globals.json) printJson({ default: defaults, implied: Object.fromEntries(implied) });
    else if (interactive()) {
      const p = pal();
      for (const n of defaults) out('  ' + c(p.star, '★') + '  ' + c(p.text, n));
      for (const [n, by] of implied) out('  ' + c(p.states.blocked, '+') + '  ' + c(p.text, n) + '   ' + c(p.muted, '← ' + by));
      if (!defaults.length) out('  ' + c(p.muted, '0 services in the default set'));
    } else {
      for (const n of defaults) out(n);
      for (const [n, by] of implied) out(`${n} (needed by ${by})`);
    }
    return EXIT.OK;
  }
  if (action !== 'add' && action !== 'remove') throw new SSError('USAGE', `unknown action "${action}"`, { hint: 'serverstart default add|remove|ls' });
  if (!targets.length) throw new SSError('USAGE', 'no services given', { hint: `serverstart default ${action} <svc|group>...` });
  const names = resolveTargets(config, targets);
  editConfig(globals.config, (doc) => names.forEach((n) => setServiceField(doc, n, 'start_by_default', action === 'add')));
  if (globals.json) printJson({ [action === 'add' ? 'added' : 'removed']: names });
  else {
    const p = pal();
    for (const n of names)
      out(interactive() ? '  ' + (action === 'add' ? c(p.star, '★') : c(p.faint, '–')) + ' ' + c(p.text, n) + '   ' + c(p.muted, action === 'add' ? 'in default set' : 'removed from default set') : `${n} ${action === 'add' ? 'added to' : 'removed from'} default set`);
  }
  return EXIT.OK;
}

// ── program ───────────────────────────────────────────────────────────────────

const collect = (v: string, prev: string[]) => [...prev, v];

function buildProgram(): Command {
  const program = new Command('serverstart')
    .description('Start all your local dev servers with one command.')
    .version(VERSION, '-v, --version')
    .option('--json', 'machine-readable JSON output')
    .option('--no-color', 'disable colors')
    .option('--config <path>', 'config file path')
    .option('--quiet', 'less output; no dashboard')
    .option('--verbose', 'more output')
    .showHelpAfterError()
    .enablePositionalOptions(false);

  const wrap =
    <A extends unknown[]>(fn: (...a: A) => Promise<number> | number) =>
    async (...a: A) => {
      process.exitCode = await fn(...a);
    };

  program
    .command('up', { isDefault: true })
    .description('start services (default set if no target), then open the dashboard')
    .argument('[targets...]', 'service or group names')
    .option('--kill-port', 'kill whatever holds a service port, without asking')
    .action(wrap((targets: string[], o: { killPort?: boolean }) => cmdUp(targets, o)));

  program
    .command('down')
    .description('stop services (all if no target)')
    .argument('[targets...]')
    .action(wrap((t: string[]) => cmdDown(t)));

  program
    .command('restart')
    .description('stop, then start services')
    .argument('<targets...>')
    .option('--kill-port', 'kill whatever holds a service port, without asking')
    .action(wrap((t: string[], o: { killPort?: boolean }) => cmdRestart(t, o)));

  program.command('status').description('state of every service').action(wrap(() => cmdStatus()));
  program.command('ls').description('list configured services').action(wrap(() => cmdLs()));
  program
    .command('dash')
    .description('open the dashboard without starting anything')
    .action(
      wrap(async () => {
        if (!interactive()) throw new SSError('NOT_A_TTY', 'the dashboard needs a terminal', { hint: 'serverstart status --json' });
        const { runDashboard } = await import('./ui/run.js');
        await runDashboard({ config: cfg(), configOverride: globals.config });
        return EXIT.OK;
      }),
    );

  program
    .command('logs')
    .description("print or follow a service's log")
    .argument('<service>')
    .option('-f, --follow', 'follow new output')
    .option('-n, --lines <n>', 'number of lines', '100')
    .action(wrap((s: string, o: { follow?: boolean; lines: string }) => cmdLogs(s, o)));

  program
    .command('open')
    .description('open a service in the browser')
    .argument('<service>')
    .option('-y, --yes', 'start it first without asking')
    .action(wrap((s: string, o: { yes?: boolean }) => cmdOpen(s, o)));

  program
    .command('add')
    .description('register a service (wizard on a terminal with no flags)')
    .option('--name <kebab>')
    .option('--cwd <path>')
    .option('--cmd <cmd>')
    .option('--port <n>')
    .option('--group <g>', 'group (repeatable)', collect, [])
    .option('--depends-on <svc>', 'dependency (repeatable)', collect, [])
    .option('--python-venv <dir>')
    .option('--conda <env>')
    .option('--uv')
    .option('--node-version <v>')
    .option('--ready-http <url>')
    .option('--ready-log <regex>')
    .option('--env <KEY=VAL>', 'environment variable (repeatable)', collect, [])
    .option('--env-file <path>')
    .option('--no-default', "don't add to the default set")
    .option('--docker-compose <file>')
    .option('--docker-service <svc>')
    .option('--detect', 'fill in missing values by inspecting cwd')
    .option('--dry-run', "print the entry, don't write it")
    .option('--force', 'replace an existing service with the same name')
    .action(wrap((o: AddFlags) => cmdAdd(o, process.argv.slice(3))));

  program
    .command('remove')
    .description('remove a service (stops it first)')
    .argument('<service>')
    .option('-y, --yes', "don't ask")
    .action(wrap((s: string, o: { yes?: boolean }) => cmdRemove(s, o)));

  program.command('edit').description('open the config in $EDITOR, then validate it').action(wrap(() => cmdEdit()));

  const settings = program
    .command('settings')
    .description('settings screen (or print settings outside a terminal)')
    .action(wrap(() => cmdSettings()));
  settings
    .command('set')
    .description('set a global setting')
    .argument('<key>')
    .argument('<value>')
    .action(wrap((k: string, v: string) => cmdSettingsSet(k, v)));

  program
    .command('default')
    .description('change the default set: add|remove <svc|group>..., or ls')
    .argument('<action>', 'add | remove | ls')
    .argument('[targets...]')
    .action(wrap((a: string, t: string[]) => cmdDefault(a, t)));

  program
    .command('doctor')
    .description('check the environment and every service')
    .action(
      wrap(async () => {
        const { runDoctor } = await import('./doctor.js');
        return runDoctor(cfg(), { json: !!globals.json });
      }),
    );

  program
    .command('schema')
    .description('print the config JSON Schema')
    .action(wrap(() => (printJson(jsonSchema()), EXIT.OK)));

  program
    .command('install-skill')
    .description('install the bundled Claude Code skill')
    .option('--force', 'overwrite an existing, different skill')
    .action(
      wrap(async (o: { force?: boolean }) => {
        const { installSkill } = await import('./skill.js');
        return installSkill({ force: !!o.force, json: !!globals.json });
      }),
    );

  program
    .command('web')
    .description('serve the web dashboard on 127.0.0.1')
    .addOption(new Option('--port <n>', 'port').default('7777'))
    .option('--no-open', "don't open the browser")
    .action(
      wrap(async (o: { port: string; open: boolean }) => {
        const { runWeb } = await import('./web/server.js');
        return runWeb({ configOverride: globals.config, port: Number(o.port), open: o.open, json: !!globals.json });
      }),
    );

  program.hook('preAction', (_this, action) => {
    globals = action.optsWithGlobals() as Globals;
    setColorMode(detectColorMode({ noColor: globals.color === false || !!globals.json }));
    applyTheme(envTheme());
  });
  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  program.exitOverride((err) => {
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version' || err.code === 'commander.help') process.exit(0);
    process.exit(EXIT.USAGE);
  });
  try {
    await program.parseAsync(process.argv);
  } catch (e) {
    if (e instanceof SSError) {
      if (globals.json) printJson(e.toJSON());
      else process.stderr.write(renderError(e) + '\n');
      process.exitCode = e.exitCode;
    } else {
      const msg = (e as Error)?.stack ?? String(e);
      if (globals.json) printJson({ error: { code: 'INTERNAL', message: (e as Error)?.message ?? String(e), hint: null } });
      else process.stderr.write(globals.verbose ? msg + '\n' : `error: ${(e as Error)?.message ?? e}\n`);
      process.exitCode = EXIT.FAILED;
    }
  }
}

void main();
