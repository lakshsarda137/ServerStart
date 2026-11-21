import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { loadConfig, type Config } from '../config/load.js';
import { editConfig, setServiceField, setSetting } from '../config/write.js';
import { displayGroups, impliedDefaults } from '../graph.js';
import { applyLoginSetting } from '../login.js';
import { c, pal, pad, trunc } from '../output/term.js';
import { tildify } from '../paths.js';
import { boxLines, hintsLine, Lines } from './components.js';

const TIMEOUTS = ['15s', '30s', '60s', '90s', '120s', '180s', '300s'];
const SHELLS = ['zsh', 'bash', 'sh', 'fish'];

type Item =
  | { kind: 'group'; label: string }
  | { kind: 'blank' }
  | { kind: 'heading'; label: string }
  | { kind: 'service'; name: string }
  | { kind: 'bool'; key: 'start_on_login' | 'open_dashboard_on_login' | 'new_services_default'; label: string; indent?: boolean }
  | { kind: 'choice'; key: 'ready_timeout' | 'shell'; label: string; options: string[] };

export function Settings(props: { config: Config; configOverride?: string; width: number; height: number; active: boolean; onClose: (config: Config) => void }) {
  const p = pal();
  const [config, setConfig] = useState(props.config);
  const [cursor, setCursor] = useState(0);
  const [loginMsg, setLoginMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [{ kind: 'heading', label: 'DEFAULT SET' }];
    const groups = displayGroups(config);
    groups.forEach((g, i) => {
      if (i > 0) out.push({ kind: 'blank' });
      out.push({ kind: 'group', label: g.group ? g.group.toUpperCase() : 'UNGROUPED' });
      for (const n of g.names) out.push({ kind: 'service', name: n });
    });
    if (!groups.length) out.push({ kind: 'group', label: '0 services' });
    out.push(
      { kind: 'blank' },
      { kind: 'heading', label: 'GENERAL' },
      { kind: 'bool', key: 'start_on_login', label: 'Start on login' },
      { kind: 'bool', key: 'open_dashboard_on_login', label: 'Open dashboard on login', indent: true },
      { kind: 'bool', key: 'new_services_default', label: 'New services join default set' },
      { kind: 'choice', key: 'ready_timeout', label: 'Ready timeout', options: TIMEOUTS },
      { kind: 'choice', key: 'shell', label: 'Shell', options: SHELLS },
    );
    return out;
  }, [config]);

  const selectable = items.map((it, i) => (it.kind === 'service' || it.kind === 'bool' || it.kind === 'choice' ? i : -1)).filter((i) => i >= 0);
  const sel = selectable[Math.min(cursor, selectable.length - 1)];
  const implied = impliedDefaults(config);

  const write = (fn: Parameters<typeof editConfig>[1]) => {
    try {
      const next = editConfig(props.configOverride, fn);
      setConfig(next);
      setError(null);
      return next;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  };

  const toggle = async (item: Item) => {
    if (item.kind === 'service') {
      write((doc) => setServiceField(doc, item.name, 'start_by_default', !config.services[item.name].isDefault));
    } else if (item.kind === 'bool') {
      if (item.key === 'open_dashboard_on_login' && !config.settings.startOnLogin) return;
      const next = write((doc) => setSetting(doc, item.key, !config.settings.raw[item.key]));
      if (next && (item.key === 'start_on_login' || item.key === 'open_dashboard_on_login')) {
        setBusy(true);
        setLoginMsg(null);
        const r = await applyLoginSetting(next);
        setBusy(false);
        setLoginMsg({ ok: r.ok, text: r.message });
      }
    }
  };

  const adjust = (item: Item, dir: 1 | -1) => {
    if (item.kind !== 'choice') return;
    const cur = String(config.settings.raw[item.key]);
    const idx = item.options.indexOf(cur);
    const next = item.options[(Math.max(0, idx) + dir + item.options.length) % item.options.length];
    write((doc) => setSetting(doc, item.key, next));
  };

  const setAll = (value: boolean) => write((doc) => config.order.forEach((n) => setServiceField(doc, n, 'start_by_default', value)));

  useInput(
    (input, key) => {
      if (key.escape || input === 'q' || input === ',') props.onClose(loadConfig(props.configOverride));
      else if (key.upArrow || input === 'k') setCursor((x) => Math.max(0, x - 1));
      else if (key.downArrow || input === 'j') setCursor((x) => Math.min(selectable.length - 1, x + 1));
      else if (input === ' ' || key.return) void toggle(items[sel]);
      else if (key.leftArrow || input === 'h') adjust(items[sel], -1);
      else if (key.rightArrow || input === 'l') adjust(items[sel], 1);
      else if (input === 'a') setAll(true);
      else if (input === 'n') setAll(false);
    },
    { isActive: props.active && !busy },
  );

  const box = (on: boolean | 'implied', disabled = false) =>
    disabled ? c(p.faint, on ? '[✓]' : '[ ]') : on === 'implied' ? c(p.states.blocked, '[+]') : on ? c(p.ok, '[✓]') : c(p.faint, '[ ]');

  const lines = items.map((it, i) => {
    const cur = i === sel;
    const g = cur ? c(p.accent, '❯') + ' ' : '  ';
    switch (it.kind) {
      case 'heading':
        return '  ' + c(p.label, it.label, { bold: true });
      case 'group':
        return '  ' + c(p.label, it.label);
      case 'blank':
        return '';
      case 'service': {
        const s = config.services[it.name];
        const by = implied.get(it.name);
        const mark = s.isDefault ? true : by ? 'implied' : false;
        return (
          g +
          box(mark) +
          ' ' +
          pad(c(p.text, trunc(it.name, 17), { bold: cur }), 18) +
          pad(s.port ? c(p.port, s.port) : c(p.faint, '–'), 7) +
          (by && !s.isDefault ? c(p.muted, '← ') + c(p.text, by) : '')
        );
      }
      case 'bool': {
        const disabled = it.key === 'open_dashboard_on_login' && !config.settings.startOnLogin;
        const label = c(disabled ? p.faint : p.text, it.label, { bold: cur && !disabled });
        const extra =
          it.key === 'start_on_login' && (busy || loginMsg)
            ? '   ' + (busy ? c(p.accent, '⠹ LaunchAgent') : c(loginMsg!.ok ? p.ok : p.err, (loginMsg!.ok ? '✓ ' : '✕ ') + loginMsg!.text))
            : '';
        return g + box(Boolean(config.settings.raw[it.key]), disabled) + ' ' + label + extra;
      }
      case 'choice':
        return g + '    ' + pad(c(p.text, it.label, { bold: cur }), 25) + c(p.accent, '‹ ') + c(p.text, String(config.settings.raw[it.key])) + c(p.accent, ' ›');
    }
  });

  const header = boxLines({ title: 'Settings', right: tildify(config.path), lines: [], width: props.width - 2 }).filter((_, i, a) => i === 0 || i === a.length - 1);
  // keep the selected line visible
  const avail = Math.max(5, props.height - header.length - 2);
  const selLine = sel ?? 0;
  const start = Math.max(0, Math.min(selLine - Math.floor(avail / 2), lines.length - avail));
  const shown = lines.slice(start, start + avail);
  const footer = error
    ? '  ' + c(p.err, '✕ ' + error)
    : hintsLine(
        [
          { key: '↑↓', label: 'move' },
          { key: 'space', label: 'toggle' },
          { key: '←→', label: 'adjust' },
          { key: 'a', label: 'all' },
          { key: 'n', label: 'none' },
          { key: 'esc', label: 'back' },
        ],
        props.width,
      );

  return (
    <Box flexDirection="column">
      <Lines lines={[...header, ...shown, '']} />
      <Text wrap="truncate-end">{footer}</Text>
    </Box>
  );
}
