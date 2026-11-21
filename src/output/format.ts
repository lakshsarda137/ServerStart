/**
 * One-shot command output for TTY (glyphs + colors) and plain mode (aligned words, no glyphs).
 * Text rules (UI.md §0): values in columns, no dot separators, no filler phrases.
 */
import type { Config } from '../config/load.js';
import type { ConfigIssue, SSError } from '../errors.js';
import { tildify } from '../paths.js';
import type { DownOutcome, UpOutcome } from '../runtime/engine.js';
import type { ServiceState, ServiceStatus } from '../runtime/types.js';
import { GLYPH, runtimeColor } from '../ui/theme.js';
import { c, colorMode, duration, pad, pal, trunc, uptime } from './term.js';

export const COL = { gutter: 2, star: 3, name: 17, state: 13, port: 7, pid: 8, runtime: 14, uptime: 6 };

/** Widen the name column to fit the longest name (17–24), when the terminal has room. */
export function fitNameColumn(names: string[], width = 80): void {
  const want = Math.min(24, Math.max(17, ...names.map((n) => n.length + 2)));
  COL.name = width >= 80 ? want : 17;
}

const plain = () => colorMode() === 'none';

export function stateCell(state: ServiceState, frame = 0): string {
  const p = pal();
  const spin = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const g = state === 'starting' || state === 'stopping' ? spin[frame % spin.length] : GLYPH[state];
  return c(p.states[state], `${g} ${state}`);
}

export interface Columns {
  pid: boolean;
  runtime: boolean;
  uptime: boolean;
  stateWord: boolean;
  url: boolean;
}

/** Which columns fit (UI.md §9): runtime goes first, then PID, then uptime. */
export function columnPlan(width = 80): Columns {
  return { url: width >= 100, runtime: width >= 72, pid: width >= 58, uptime: width >= 50, stateWord: width >= 46 };
}

export function statusHeader(width = 80): string {
  const p = pal();
  const k = columnPlan(width);
  const h = (s: string, w: number, align: 'left' | 'right' = 'left') => c(p.faint, pad(s, w, align));
  return (
    ' '.repeat(COL.gutter + COL.star) +
    h('NAME', COL.name) +
    h('STATE', k.stateWord ? COL.state : 3) +
    h('PORT', COL.port) +
    (k.pid ? h('PID', COL.pid) : '') +
    (k.runtime ? h('RUNTIME', COL.runtime) : '') +
    (k.uptime ? h('UPTIME', COL.uptime, 'right') : '') +
    (k.url ? '   ' + h('URL', 0) : '')
  );
}

export function statusRow(s: ServiceStatus, opts: { frame?: number; cursor?: boolean; width?: number } = {}): string[] {
  const p = pal();
  const k = columnPlan(opts.width);
  const dash = c(p.faint, '–');
  const gutter = opts.cursor ? c(p.accent, '❯') + ' ' : '  ';
  const star = s.default ? c(p.star, '★') + '  ' : '   ';
  const timeVal = s.state === 'starting' || s.state === 'stopping' ? (s.elapsed_s ?? null) : s.state === 'ready' ? s.uptime_s : null;
  const time = timeVal === null || timeVal === undefined ? '' : c(s.state === 'ready' ? p.muted : p.states[s.state], uptime(timeVal));
  const state = k.stateWord ? pad(stateCell(s.state, opts.frame), COL.state) : pad(stateCell(s.state, opts.frame).split(' ')[0], 3);
  const line =
    gutter +
    star +
    pad(c(p.text, trunc(s.name, COL.name - 1), { bold: opts.cursor }), COL.name) +
    state +
    pad(s.port ? c(p.port, s.port) : dash, COL.port) +
    (k.pid ? pad(s.pid ? c(p.muted, s.pid) : dash, COL.pid) : '') +
    (k.runtime ? pad(c(runtimeColor(p, s.runtime), trunc(s.runtime, COL.runtime - 1)), COL.runtime) : '') +
    (k.uptime ? pad(time, COL.uptime, 'right') : '') +
    (k.url && s.url && (s.state === 'ready' || s.state === 'starting') ? '   ' + c(p.path, s.url) : '');
  const out = [line];
  const sub = subRow(s, opts.width ?? 80);
  if (sub) out.push(sub);
  return out;
}

export function subRow(s: ServiceStatus, width = 74): string | null {
  const p = pal();
  const indent = ' '.repeat(COL.gutter + COL.star);
  if (s.state === 'crashed' && s.error) return indent + c(p.line, '└ ') + c(p.err, trunc(s.error, width - indent.length - 2));
  if (s.state === 'blocked' && s.blocked_by) return indent + c(p.line, '└ ') + c(p.text, s.blocked_by) + ' ' + c(p.states.crashed, GLYPH.crashed);
  return null;
}

/** "✓ 4 ready   ✕ 1 crashed" — only non-zero counts, each in its state's color. */
export function countsLine(statuses: ServiceStatus[], order: ServiceState[] = ['ready', 'starting', 'queued', 'stopping', 'crashed', 'blocked', 'stopped', 'external']): string {
  const p = pal();
  const counts = new Map<ServiceState, number>();
  for (const s of statuses) counts.set(s.state, (counts.get(s.state) ?? 0) + 1);
  return order
    .filter((st) => counts.get(st))
    .map((st) => c(p.states[st], `${GLYPH[st]} ${counts.get(st)} ${st}`))
    .join('   ');
}

export function renderStatus(statuses: ServiceStatus[]): string {
  if (plain()) {
    const nw = Math.max(18, ...statuses.map((s) => s.name.length + 2));
    const rows = statuses.map((s) =>
      [
        pad(s.name, nw),
        pad(s.state, 10),
        pad(s.port ? String(s.port) : '-', 7),
        pad(s.pid ? String(s.pid) : '-', 8),
        pad(s.runtime, 14),
        pad(s.state === 'ready' ? uptime(s.uptime_s) : '-', 6),
        s.error ?? (s.blocked_by ? `blocked by ${s.blocked_by}` : ''),
      ]
        .join('')
        .trimEnd(),
    );
    return [pad('NAME', nw) + pad('STATE', 10) + pad('PORT', 7) + pad('PID', 8) + pad('RUNTIME', 14) + 'UPTIME', ...rows].join('\n');
  }
  const p = pal();
  const width = Math.min(process.stdout.columns ?? 80, 100);
  fitNameColumn(statuses.map((s) => s.name), width);
  const lines = [statusHeader(width), ...statuses.flatMap((s) => statusRow(s, { width }))];
  const crashed = statuses.find((s) => s.state === 'crashed');
  const footer = countsLine(statuses) + (crashed ? '        ' + c(p.cmd, `serverstart logs ${crashed.name}`) : '');
  if (statuses.length) lines.push('', '  ' + footer);
  else lines.splice(0, lines.length, '  ' + c(p.muted, '0 services'));
  return lines.join('\n');
}

export function renderLs(config: Config): string {
  const rows = config.order.map((n) => {
    const s = config.services[n];
    const dir = tildify(s.docker ? s.cwd : s.cwd);
    const cmd = s.docker ? `compose: ${s.docker.service ?? 'all'}` : (s.cmd ?? '');
    return { s, dir, cmd };
  });
  if (plain()) {
    const nw = Math.max(18, ...rows.map(({ s }) => s.name.length + 2));
    return [
      pad('NAME', nw) + pad('KIND', 9) + pad('PORT', 7) + pad('DEFAULT', 9) + pad('DIRECTORY', 32) + 'COMMAND',
      ...rows.map(({ s, dir, cmd }) => (pad(s.name, nw) + pad(s.kind, 9) + pad(s.port ? String(s.port) : '-', 7) + pad(s.isDefault ? 'yes' : 'no', 9) + pad(dir, 32) + cmd).trimEnd()),
    ].join('\n');
  }
  const p = pal();
  if (!rows.length) return '  ' + c(p.muted, '0 services');
  const width = process.stdout.columns ?? 80;
  const dirW = 23;
  const cmdW = Math.max(12, Math.min(40, width - 5 - 17 - 9 - 7 - dirW - 1));
  const head =
    '     ' + c(p.faint, pad('NAME', 17)) + c(p.faint, pad('KIND', 9)) + c(p.faint, pad('PORT', 7)) + c(p.faint, pad('DIRECTORY', dirW)) + c(p.faint, 'COMMAND');
  return [
    head,
    ...rows.map(
      ({ s, dir, cmd }) =>
        '  ' +
        (s.isDefault ? c(p.star, '★') + '  ' : '   ') +
        pad(c(p.text, trunc(s.name, 16)), 17) +
        pad(c(runtimeColor(p, s.kind), s.kind), 9) +
        pad(s.port ? c(p.port, s.port) : c(p.faint, '–'), 7) +
        pad(c(p.path, trunc(dir, dirW - 1)), dirW) +
        c(p.cmd, trunc(cmd, cmdW)),
    ),
  ].join('\n');
}

export function upLine(o: UpOutcome, nw = 17): string {
  const p = pal();
  if (o.external) {
    if (plain()) return (pad(o.name, nw) + pad('external', 10) + pad(o.port ? String(o.port) : '-', 7) + pad('-', 7) + `already running outside serverstart, pid ${o.external.pid}`).trimEnd();
    return '  ' + c(p.states.external, GLYPH.external) + ' ' + pad(c(p.text, o.name), nw) + pad(c(p.states.external, 'external'), 11) + pad(o.port ? c(p.port, o.port) : c(p.faint, '–'), 7) + c(p.muted, 'PID ') + c(p.text, o.external.pid);
  }
  if (plain()) {
    const detail = o.state === 'blocked' ? `blocked by ${o.blocked_by}` : (o.error ?? (o.already_running ? 'already running' : ''));
    return (pad(o.name, nw) + pad(o.state, 10) + pad(o.port ? String(o.port) : '-', 7) + pad(duration(o.duration_ms), 7) + detail).trimEnd();
  }
  const state = o.state === 'ready' ? 'ready' : o.state;
  const detail =
    o.state === 'ready'
      ? o.already_running
        ? c(p.muted, 'already running')
        : c(p.muted, duration(o.duration_ms))
      : o.state === 'blocked'
        ? c(p.text, o.blocked_by ?? '') + ' ' + c(p.states.crashed, GLYPH.crashed)
        : c(p.err, trunc(o.error ?? '', 40));
  return '  ' + c(p.states[state], GLYPH[state]) + ' ' + pad(c(p.text, o.name), nw) + pad(c(p.states[state], state), 11) + pad(o.port ? c(p.port, o.port) : c(p.faint, '–'), 7) + detail;
}

export function upSummary(out: UpOutcome[]): string {
  const external = out.filter((o) => o.external).length;
  const ready = out.filter((o) => o.state === 'ready').length - external;
  const failed = out.filter((o) => o.state !== 'ready').length;
  if (plain()) return `${ready} ready${external ? `   ${external} external` : ''}${failed ? `   ${failed} failed` : ''}`;
  const p = pal();
  return '  ' + c(p.ok, `✓ ${ready} ready`) + (external ? '   ' + c(p.states.external, `◇ ${external} external`) : '') + (failed ? '   ' + c(p.err, `✕ ${failed} failed`) : '');
}

export function downLine(o: DownOutcome, nw = 17): string {
  const p = pal();
  if (plain()) return (pad(o.name, nw) + pad(o.killed ? 'killed' : o.state, 10) + pad(duration(o.duration_ms), 7) + (o.killed ? 'SIGKILL after 10s' : (o.error ?? ''))).trimEnd();
  if (o.killed) return '  ' + c(p.warn, '!') + ' ' + pad(c(p.text, o.name), nw) + pad(c(p.warn, 'killed'), 11) + c(p.muted, 'SIGKILL after 10s');
  if (o.state === 'failed') return '  ' + c(p.err, '✕') + ' ' + pad(c(p.text, o.name), nw) + pad(c(p.err, 'failed'), 11) + c(p.err, o.error ?? '');
  if (o.state === 'skipped') return '  ' + c(p.faint, '–') + ' ' + pad(c(p.text, o.name), nw) + pad(c(p.faint, 'not running'), 11);
  return '  ' + c(p.ok, '✓') + ' ' + pad(c(p.text, o.name), nw) + pad(c(p.states.stopped, 'stopped'), 11) + c(p.muted, duration(o.duration_ms));
}

export function downSummary(out: DownOutcome[], ports: number[]): string {
  const stopped = out.filter((o) => o.state === 'stopped').length;
  const failed = out.filter((o) => o.state === 'failed').length;
  if (plain()) return `${stopped} stopped${failed ? `   ${failed} failed` : ''}${ports.length ? `   ports ${ports.join(' ')} free` : ''}`;
  const p = pal();
  return (
    '  ' +
    c(p.ok, `✓ ${stopped} stopped`) +
    (failed ? '   ' + c(p.err, `✕ ${failed} failed`) : '') +
    (ports.length ? '   ' + c(p.muted, 'ports ') + ports.map((x) => c(p.port, x)).join(' ') + c(p.muted, ' free') : '')
  );
}

function issueLines(issues: ConfigIssue[]): string[] {
  const p = pal();
  const w = Math.max(...issues.map((i) => i.path.length)) + 3;
  return issues.flatMap((i) => {
    const out = ['    ' + pad(c(p.text, i.path), w) + c(p.err, i.message)];
    if (i.hint) out.push('    ' + ' '.repeat(w) + c(p.muted, i.hint));
    return out;
  });
}

/** Human error output (stderr). */
export function renderError(e: SSError, opts: { showHint?: boolean } = {}): string {
  const p = pal();
  if (plain()) {
    const lines = [`error: ${e.message}`];
    for (const i of e.issues ?? []) lines.push(`  ${i.path}: ${i.message}${i.hint ? ` (${i.hint})` : ''}`);
    if (e.hint && opts.showHint !== false) lines.push(`hint: ${e.hint}`);
    return lines.join('\n');
  }
  if (e.code === 'CONFIG_INVALID') {
    const path = (e.details?.path as string | undefined) ?? '';
    const lines = ['  ' + c(p.err, '✕ config invalid') + '   ' + c(p.path, tildify(path)), '', ...issueLines(e.issues ?? [])];
    if (opts.showHint !== false) lines.push('', '  ' + c(p.accent, '→ ') + c(p.cmd, 'serverstart edit'));
    return lines.join('\n');
  }
  const lines = ['  ' + c(p.err, '✕ ' + e.message)];
  if (e.hint && opts.showHint !== false) lines.push('  ' + c(p.accent, '→ ') + c(/^(serverstart|cd |python|npm|pnpm)/.test(e.hint) ? p.cmd : p.muted, e.hint));
  return lines.join('\n');
}
