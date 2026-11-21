import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { spawn } from 'node:child_process';
import { loadConfig, type Config } from '../config/load.js';
import { editConfig, setServiceField } from '../config/write.js';
import { displayGroups } from '../graph.js';
import { countsLine, fitNameColumn, statusHeader, statusRow } from '../output/format.js';
import { c, pal, trunc, visibleLength } from '../output/term.js';
import { tildify } from '../paths.js';
import { Engine, type Patch, type UpOptions } from '../runtime/engine.js';
import type { Listener } from '../runtime/ports.js';
import { getStatuses } from '../runtime/status.js';
import type { ServiceStatus } from '../runtime/types.js';
import { SPINNER } from './theme.js';
import { boxLines, contentWidth, hintsLine, Lines, useSize, useTicker, withBg, type Hint } from './components.js';
import { LogPane } from './LogPane.js';
import { Settings } from './Settings.js';

interface Overlay {
  patch: Patch;
  at: number;
}

interface Prompt {
  service: string;
  port: number;
  holder: Listener;
  resolve: (kill: boolean) => void;
}

const FINAL = new Set(['ready', 'crashed', 'stopped', 'blocked']);

export interface DashboardResult {
  running: number;
}

export function Dashboard(props: { config: Config; configOverride?: string; up?: string[]; killPort?: boolean; onExit: (r: DashboardResult) => void }) {
  const { exit } = useApp();
  const p = pal();
  const { cols, rows } = useSize();
  const width = contentWidth(cols);

  const [config, setConfig] = useState(props.config);
  const engine = useMemo(() => new Engine(props.config), []);
  const [polled, setPolled] = useState<{ at: number; list: ServiceStatus[] }>({ at: 0, list: [] });
  const overlay = useRef(new Map<string, Overlay>());
  const [, bump] = useState(0);
  const [docker, setDocker] = useState<number | null>(null);
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<'list' | 'logs' | 'settings' | 'help'>('list');
  const [message, setMessage] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [startTotal, setStartTotal] = useState<number>(0);
  const messageTimer = useRef<NodeJS.Timeout>();

  const flash = useCallback((m: string) => {
    setMessage(m);
    clearTimeout(messageTimer.current);
    messageTimer.current = setTimeout(() => setMessage(null), 3000);
  }, []);

  // poll real state every second
  useEffect(() => {
    let stopped = false;
    let inflight = false;
    const poll = async () => {
      if (inflight || stopped) return;
      inflight = true;
      const at = Date.now();
      try {
        const list = await getStatuses(engine.config);
        if (!stopped) setPolled({ at, list });
      } catch {
        /* config may be mid-edit */
      }
      inflight = false;
    };
    void poll();
    const t = setInterval(poll, 1000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [engine]);

  // engine events → overlay
  useEffect(() => {
    const onChange = (name: string, patch: Patch) => {
      overlay.current.set(name, { patch: { ...(overlay.current.get(name)?.patch ?? {}), ...patch }, at: Date.now() });
      bump((x) => x + 1);
    };
    const onDocker = (s: number | null) => setDocker(s);
    engine.on('change', onChange);
    engine.on('docker', onDocker);
    return () => {
      engine.off('change', onChange);
      engine.off('docker', onDocker);
    };
  }, [engine]);

  const confirmKill: UpOptions['confirmKill'] = (service, port, holder) =>
    new Promise<boolean>((resolve) => setPrompt({ service, port, holder, resolve }));

  // initial `up`
  useEffect(() => {
    if (!props.up?.length) return;
    setStartTotal(props.up.length);
    void engine.up(props.up, { killPort: props.killPort, confirmKill });
  }, []);

  // merge polled + overlay
  const statuses = useMemo(() => {
    return polled.list.map((s) => {
      const o = overlay.current.get(s.name);
      if (!o) return s;
      const final = FINAL.has(o.patch.state);
      const keepBlocked = o.patch.state === 'blocked' && s.state === 'stopped';
      if (!final || o.at >= polled.at || keepBlocked) return { ...s, ...o.patch };
      overlay.current.delete(s.name);
      return s;
    });
  }, [polled, overlay.current.size, bump]);
  const byName = new Map(statuses.map((s) => [s.name, s]));

  const groups = useMemo(() => displayGroups(config), [config]);
  const ordered = groups.flatMap((g) => g.names).filter((n) => byName.has(n));
  const selName = ordered[Math.min(cursor, ordered.length - 1)];
  const sel = selName ? byName.get(selName) : undefined;

  const spinning = statuses.some((s) => s.state === 'starting' || s.state === 'stopping') || docker !== null;
  const frame = useTicker(spinning, 80);

  const reload = (next?: Config) => {
    const c2 = next ?? loadConfig(props.configOverride);
    engine.config = c2;
    setConfig(c2);
  };

  // actions
  const act = {
    start: (n: string) => void engine.up([n], { confirmKill }).then((o) => {
      const r = o.find((x) => x.name === n);
      if (r) flash(r.state === 'ready' ? `${c(p.ok, '✓')} ${c(p.text, n)}   ${c(p.muted, 'ready')}` : `${c(p.err, '✕')} ${c(p.text, n)}   ${c(p.err, trunc(r.error ?? r.state, 50))}`);
    }),
    stop: (n: string) => void engine.down([n]).then(() => flash(`${c(p.states.stopped, '–')} ${c(p.text, n)}   ${c(p.muted, 'stopped')}`)),
    restart: (n: string) => {
      flash(`${c(p.accent, SPINNER[2])} ${c(p.text, n)}   ${c(p.muted, 'restarting')}`);
      void engine.restart([n], { confirmKill }).then((o) => {
        const r = o.find((x) => x.name === n);
        if (r) flash(r.state === 'ready' ? `${c(p.ok, '✓')} ${c(p.text, n)}   ${c(p.muted, 'restarted')}` : `${c(p.err, '✕')} ${c(p.text, n)}   ${c(p.err, trunc(r.error ?? r.state, 50))}`);
      });
    },
    open: (s: ServiceStatus) => {
      if (!s.url) return flash(`${c(p.warn, '!')} ${c(p.text, s.name)}   ${c(p.muted, 'no port configured')}`);
      spawn('open', [s.url], { stdio: 'ignore', detached: true }).unref();
      flash(`${c(p.path, '↗')} ${c(p.path, s.url)}`);
    },
    toggleDefault: (n: string) => {
      try {
        const next = editConfig(props.configOverride, (doc) => setServiceField(doc, n, 'start_by_default', !config.services[n].isDefault));
        reload(next);
        flash(
          next.services[n].isDefault
            ? `${c(p.star, '★')} ${c(p.text, n)}   ${c(p.muted, 'added to default set')}`
            : `${c(p.faint, '–')} ${c(p.text, n)}   ${c(p.muted, 'removed from default set')}`,
        );
      } catch (e) {
        flash(`${c(p.err, '✕')} ${c(p.err, (e as Error).message)}`);
      }
    },
  };

  const quit = () => {
    props.onExit({ running: statuses.filter((s) => s.state === 'ready' || s.state === 'starting').length });
    exit();
  };

  useInput(
    (input, key) => {
      if (prompt) {
        if (input === 'y' || input === 'Y') prompt.resolve(true);
        else if (input === 'n' || input === 'N' || key.return || key.escape) prompt.resolve(false);
        else return;
        setPrompt(null);
        return;
      }
      if (mode === 'help') {
        setMode('list');
        return;
      }
      if (key.upArrow || input === 'k') setCursor((x) => Math.max(0, x - 1));
      else if (key.downArrow || input === 'j') setCursor((x) => Math.min(ordered.length - 1, x + 1));
      else if (input === 'q' || (key.ctrl && input === 'c')) quit();
      else if (input === ',') setMode('settings');
      else if (input === '?') setMode('help');
      else if (!sel) return;
      else if (key.return) setMode('logs');
      else if (input === 'r' && sel.state !== 'external') act.restart(sel.name);
      else if (input === 's') {
        if (sel.state === 'ready' || sel.state === 'starting') act.stop(sel.name);
        else if (sel.state !== 'stopping') act.start(sel.name);
      } else if (input === 'o') act.open(sel);
      else if (input === 'd') act.toggleDefault(sel.name);
    },
    { isActive: mode === 'list' || mode === 'help' || !!prompt },
  );

  // ── render ──
  if (mode === 'logs' && sel) {
    return (
      <LogPane
        svc={config.services[sel.name]}
        status={sel}
        width={width}
        height={rows - 1}
        frame={frame}
        active={!prompt}
        onClose={() => setMode('list')}
        onRestart={() => act.restart(sel.name)}
      />
    );
  }
  if (mode === 'settings') {
    return (
      <Settings
        config={config}
        configOverride={props.configOverride}
        width={width}
        height={rows - 1}
        active
        onClose={(next) => {
          reload(next);
          setMode('list');
        }}
      />
    );
  }

  // header
  const handled = [...overlay.current.values()];
  const starting = statuses.some((s) => s.state === 'queued' || s.state === 'starting');
  let headerLines: [string, string?][];
  if (docker !== null) {
    const readyCount = statuses.filter((s) => s.state === 'ready').length;
    headerLines = [[c(p.accent, SPINNER[frame % SPINNER.length]) + ' ' + c(p.text, 'Docker Desktop') + '   ' + c(p.muted, `${docker}s`), c(p.text, `${readyCount}/${startTotal || handled.length} ready`)]];
  } else if (starting && handled.length) {
    const total = Math.max(startTotal, handled.length);
    const readyN = statuses.filter((s) => overlay.current.has(s.name) && s.state === 'ready').length;
    headerLines = [[countsLine(statuses, ['ready', 'starting', 'queued', 'crashed', 'blocked']), c(p.text, `${readyN}/${total} ready`)]];
  } else {
    headerLines = [[statuses.length ? countsLine(statuses) : c(p.muted, '0 services'), c(p.text, `${statuses.length} services`)]];
  }
  const header = boxLines({ title: 'ServerStart', right: tildify(config.path), lines: headerLines, width: width - 2 });

  // body
  type Row = { text: string; owner?: string };
  const body: Row[] = [];
  fitNameColumn(statuses.map((s) => s.name), width);
  if (!statuses.length && polled.at) {
    body.push({ text: '' });
    body.push({ text: '  ' + c(p.cmd, 'serverstart add') + '             ' + c(p.muted, 'register the project in the current directory') });
    body.push({ text: '  ' + c(p.cmd, 'serverstart install-skill') + '   ' + c(p.muted, 'let Claude Code register projects') });
  } else if (statuses.length) {
    body.push({ text: statusHeader(width) });
    groups.forEach((g, gi) => {
      if (gi > 0) body.push({ text: '' });
      body.push({ text: '  ' + c(p.label, g.group ? g.group.toUpperCase() : 'UNGROUPED', { bold: true }) });
      for (const n of g.names) {
        const s = byName.get(n);
        if (!s) continue;
        const isSel = n === selName;
        const lines = statusRow(s, { frame, cursor: isSel, width });
        body.push({ text: isSel ? withBg(lines[0], p.select, width) : lines[0], owner: n });
        for (const l of lines.slice(1)) body.push({ text: l, owner: n });
        if (prompt && prompt.service === n) {
          const pw = Math.min(width - 6, 70);
          const box = boxLines({
            title: `Port ${prompt.port} in use`,
            lines: [
              [c(p.muted, 'PID ') + c(p.text, prompt.holder.pid) + '   ' + c(p.text, prompt.holder.command)],
              [''],
              [c(p.text, `Kill ${prompt.holder.pid} and start ${n}?`) + '   ' + c(p.accent, 'y') + c(p.faint, ' / ') + c(p.accent, 'N')],
            ],
            width: pw,
            border: p.warn,
          });
          for (const l of box) body.push({ text: '     ' + l, owner: n });
        }
      }
    });
  }

  // help overlay
  if (mode === 'help') {
    const keys: [string, string][] = [
      ['↑↓ j k', 'move'],
      ['⏎', 'logs'],
      ['r', 'restart'],
      ['s', 'start or stop'],
      ['o', 'open in browser'],
      ['d', 'toggle default set'],
      [',', 'settings'],
      ['q', 'quit (servers keep running)'],
    ];
    body.splice(0, body.length, { text: '' }, ...keys.map(([k, l]) => ({ text: '  ' + c(p.accent, k.padEnd(10)) + c(p.muted, l) })), { text: '' }, { text: '  ' + c(p.muted, 'any key closes') });
  }

  // scroll window so the cursor (and its prompt) stay visible
  const avail = Math.max(4, rows - header.length - 3);
  let start = 0;
  if (body.length > avail) {
    const first = body.findIndex((r) => r.owner === selName);
    let last = first;
    while (last + 1 < body.length && body[last + 1].owner === selName) last++;
    start = Math.max(0, Math.min(first - 2, body.length - avail));
    if (last >= start + avail) start = last - avail + 1;
  }
  let visible = body.slice(start, start + avail).map((r) => r.text);
  if (body.length > avail) {
    if (start > 0) visible[0] = '  ' + c(p.faint, `↑ ${start}`);
    const below = body.length - (start + avail);
    if (below > 0) visible[visible.length - 1] = '  ' + c(p.faint, `↓ ${below}`);
  }

  // footer
  let footer: string;
  if (message) footer = '  ' + message;
  else if (prompt) footer = hintsLine([{ key: 'y', label: 'kill and start' }, { key: 'N', label: 'leave it' }], width);
  else {
    const hints: Hint[] = [{ key: '↑↓', label: 'move' }];
    if (sel) {
      hints.push({ key: '⏎', label: sel.state === 'crashed' ? 'error log' : 'logs' });
      if (sel.state !== 'external') hints.push({ key: 'r', label: 'restart' });
      if (sel.state !== 'stopping') hints.push({ key: 's', label: sel.state === 'ready' || sel.state === 'starting' ? 'stop' : 'start' });
      if (sel.url) hints.push({ key: 'o', label: 'open' });
      hints.push({ key: 'd', label: 'default' });
    }
    hints.push({ key: ',', label: 'settings' }, { key: 'q', label: 'quit' });
    footer = hintsLine(visibleLength(hintsLine(hints, 1000)) > width ? hints.slice(1) : hints, width);
  }

  return (
    <Box flexDirection="column">
      <Lines lines={[...header, ...visible, '']} />
      <Text wrap="truncate-end">{footer}</Text>
    </Box>
  );
}
