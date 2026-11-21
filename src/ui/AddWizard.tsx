import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { stringify as yamlStringify } from 'yaml';
import type { Config } from '../config/load.js';
import { NAME_RE, type RawService } from '../config/schema.js';
import { addService, editConfig } from '../config/write.js';
import { detect, kebab, type Detection } from '../detect/index.js';
import { basename } from 'node:path';
import { c, pad, pal, trunc } from '../output/term.js';
import { resolvePath, tildify } from '../paths.js';
import { Engine, type UpOutcome } from '../runtime/engine.js';
import { nextFreePort } from '../runtime/ports.js';
import { boxLines, contentWidth, hintsLine, Lines, useSize, useTicker } from './components.js';

type FieldKey = 'name' | 'cwd' | 'cmd' | 'compose' | 'composeService' | 'port' | 'runtime' | 'group' | 'depends' | 'ready' | 'default';

interface Values {
  name: string;
  cwd: string;
  cmd: string;
  compose: string;
  composeService: string;
  port: string;
  runtime: string;
  group: string;
  depends: string[];
  ready: 'port' | 'http' | 'log';
  readyValue: string;
  default: boolean;
}

function fromDetection(d: Detection, cwd: string, config: Config): Values {
  const s = d.service;
  return {
    name: d.name,
    cwd: tildify(cwd),
    cmd: s.cmd ?? '',
    compose: s.docker ? tildify(s.docker.compose) : '',
    composeService: s.docker?.service ?? '',
    port: s.port ? String(s.port) : '',
    runtime: s.node?.version ?? s.python?.venv ?? (s.python?.uv ? 'uv' : s.python?.conda ? `conda:${s.python.conda}` : ''),
    group: kebab(basename(cwd)), // every service belongs to a group (its project)
    depends: [],
    ready: 'port',
    readyValue: '',
    default: config.settings.newServicesDefault,
  };
}

export function AddWizard(props: { config: Config; configOverride?: string; onDone: (code: number, lines: string[]) => void }) {
  const { exit } = useApp();
  const p = pal();
  const { cols } = useSize();
  const width = contentWidth(cols);
  const { config } = props;

  const [det, setDet] = useState<Detection>(() => detect(process.cwd()));
  const [v, setV] = useState<Values>(() => fromDetection(det, process.cwd(), config));
  const [field, setField] = useState(0);
  const [done, setDone] = useState<Set<FieldKey>>(new Set());
  const [optCursor, setOptCursor] = useState(0);
  const [phase, setPhase] = useState<'form' | 'review' | 'running'>('form');
  const [reviewCursor, setReviewCursor] = useState(0);
  const [suggested, setSuggested] = useState<number | null>(null);
  const [result, setResult] = useState<string[]>([]);
  const frame = useTicker(phase === 'running', 80);

  const isDocker = det.kind === 'docker' && !v.cmd;
  const runtimeLabel = det.kind === 'python' ? 'Python env' : 'Node version';
  const fields: FieldKey[] = isDocker
    ? ['name', 'compose', 'composeService', 'port', 'group', 'depends', 'ready', 'default']
    : ['name', 'cwd', 'cmd', 'port', ...(det.kind === 'node' || det.kind === 'python' ? (['runtime'] as FieldKey[]) : []), 'group', 'depends', 'ready', 'default'];
  const cur = fields[Math.min(field, fields.length - 1)];

  const others = config.order;
  const portNum = Number(v.port);
  const clash = v.port && others.find((n) => n !== v.name && config.services[n].port === portNum);
  useEffect(() => {
    if (!clash) return setSuggested(null);
    const taken = others.map((n) => config.services[n].port).filter((x): x is number => !!x);
    void nextFreePort(portNum + 1, taken).then(setSuggested);
  }, [v.port, clash]);

  const nameError = !NAME_RE.test(v.name) ? 'use a-z, 0-9 and -' : others.includes(v.name) ? `${v.name} already exists` : null;

  const sources = det.sources;
  const sourceFor: Partial<Record<FieldKey, string>> = {
    name: sources.name,
    cwd: 'cwd',
    cmd: sources.cmd,
    compose: sources.docker,
    port: sources.port,
    runtime: sources['node.version'] ?? sources.python,
    default: 'settings',
  };

  const set = <K extends keyof Values>(k: K, val: Values[K]) => setV((old) => ({ ...old, [k]: val }));
  const next = () => {
    setDone((d) => new Set(d).add(cur));
    setOptCursor(0);
    if (field + 1 >= fields.length) setPhase('review');
    else setField(field + 1);
  };
  const back = () => {
    setOptCursor(0);
    setField(Math.max(0, field - 1));
  };

  const submitText = () => {
    if (cur === 'name' && nameError) return;
    if (cur === 'port' && clash && suggested) set('port', String(suggested));
    if (cur === 'cwd') {
      const dir = resolvePath(v.cwd);
      const d = detect(dir);
      setDet(d);
      setV((old) => ({ ...fromDetection(d, dir, config), name: done.has('name') ? old.name : d.name }));
    }
    next();
  };

  const buildService = (): RawService => {
    const s: RawService = {};
    if (isDocker) {
      s.docker = { compose: v.compose, ...(v.composeService ? { service: v.composeService } : {}) };
    } else {
      s.cwd = tildify(resolvePath(v.cwd));
      s.cmd = v.cmd;
    }
    if (v.port) s.port = Number(v.port);
    if (!isDocker && v.runtime) {
      if (det.kind === 'node') s.node = { version: v.runtime };
      else if (v.runtime === 'uv') s.python = { uv: true };
      else if (v.runtime.startsWith('conda:')) s.python = { conda: v.runtime.slice(6) };
      else s.python = { venv: v.runtime };
    }
    if (v.group.trim()) {
      const gs = v.group.split(/[\s,]+/).filter(Boolean);
      s.group = gs.length === 1 ? gs[0] : gs;
    }
    if (v.depends.length) s.depends_on = v.depends;
    if (v.ready === 'http' && v.readyValue) s.ready = { http: v.readyValue };
    if (v.ready === 'log' && v.readyValue) s.ready = { log: v.readyValue };
    s.start_by_default = v.default;
    return s;
  };

  const finish = async (mode: 'start' | 'add') => {
    try {
      const next = editConfig(props.configOverride, (doc) => addService(doc, v.name, buildService()));
      const lines = ['  ' + c(p.ok, '✓') + ' ' + c(p.text, v.name) + '   ' + c(p.muted, 'added')];
      if (mode === 'add') return end(0, lines);
      setPhase('running');
      setResult(lines);
      const out: UpOutcome[] = await new Engine(next).up([v.name]);
      const r = out.find((o) => o.name === v.name)!;
      const url = r.url ? '   ' + c(p.path, r.url) : '';
      lines.push(
        r.state === 'ready'
          ? '  ' + c(p.ok, '✓') + ' ' + c(p.text, v.name) + '   ' + c(p.states.ready, 'ready') + '   ' + (r.port ? c(p.port, r.port) + '   ' : '') + c(p.muted, `${(r.duration_ms / 1000).toFixed(1)}s`) + url
          : '  ' + c(p.err, '✕') + ' ' + c(p.text, v.name) + '   ' + c(p.err, r.state) + '   ' + c(p.err, trunc(r.error ?? '', 50)),
      );
      end(r.state === 'ready' ? 0 : 1, lines);
    } catch (e) {
      end(3, ['  ' + c(p.err, '✕ ' + (e as Error).message)]);
    }
  };

  const [finalLines, setFinalLines] = useState<string[] | null>(null);
  const end = (code: number, lines: string[]) => {
    props.onDone(code, lines);
    setFinalLines(lines); // the last frame is just the result
    setTimeout(() => exit(), 30);
  };

  // option lists for choice fields
  const readyOptions: { key: Values['ready']; label: string; hint: string }[] = [
    { key: 'port', label: 'port', hint: v.port || '–' },
    { key: 'http', label: 'http', hint: v.port ? `http://localhost:${v.port}/` : 'url' },
    { key: 'log', label: 'log', hint: 'regex' },
  ];

  useInput(
    (input, key) => {
      if (key.escape) return end(0, ['  ' + c(p.muted, 'cancelled')]);
      if (phase === 'review') {
        if (key.upArrow) setReviewCursor((x) => Math.max(0, x - 1));
        else if (key.downArrow) setReviewCursor((x) => Math.min(3, x + 1));
        else if (key.return) {
          if (reviewCursor === 0) void finish('start');
          else if (reviewCursor === 1) void finish('add');
          else if (reviewCursor === 2) {
            setPhase('form');
            setField(0);
          } else end(0, ['  ' + c(p.muted, 'cancelled')]);
        }
        return;
      }
      if (key.tab && !key.shift) return setPhase('review');
      if (key.tab && key.shift) return back();
      if (cur === 'depends') {
        if (key.upArrow) setOptCursor((x) => Math.max(0, x - 1));
        else if (key.downArrow) setOptCursor((x) => Math.min(others.length - 1, x + 1));
        else if (input === ' ' && others[optCursor]) {
          const n = others[optCursor];
          set('depends', v.depends.includes(n) ? v.depends.filter((d) => d !== n) : [...v.depends, n]);
        } else if (key.return) next();
        return;
      }
      if (cur === 'ready') {
        if (key.upArrow) setOptCursor((x) => Math.max(0, x - 1));
        else if (key.downArrow) setOptCursor((x) => Math.min(2, x + 1));
        else if (key.return) {
          set('ready', readyOptions[optCursor].key);
          if (readyOptions[optCursor].key === 'http' && !v.readyValue && v.port) set('readyValue', `http://localhost:${v.port}/`);
          next();
        }
        return;
      }
      if (cur === 'default') {
        if (input === ' ' || key.leftArrow || key.rightArrow || input === 'y' || input === 'n') set('default', input === 'y' ? true : input === 'n' ? false : !v.default);
        else if (key.return) next();
        else if (key.upArrow) back();
        return;
      }
      // built-in text field
      const tk = cur as Exclude<FieldKey, 'depends' | 'ready' | 'default'>;
      if (key.upArrow) back();
      else if (key.downArrow || key.return) submitText();
      else if (key.backspace || key.delete) set(tk, (v[tk] as string).slice(0, -1));
      else if (input && !key.ctrl && !key.meta && !key.tab) set(tk, ((v[tk] as string) + input).replace(/[\r\n]/g, ''));
    },
    { isActive: phase !== 'running' },
  );

  // ── render ──
  const stack = det.stack.length ? det.stack.map((s) => c(s.startsWith('python') || ['fastapi', 'flask', 'django', 'streamlit', 'uv'].includes(s) ? p.python : s === 'docker' ? p.docker : p.node, s)).join('   ') : c(p.muted, 'nothing detected');
  const header = boxLines({ title: 'Add service', right: tildify(resolvePath(v.cwd || '.')), lines: [[stack]], width: width - 2 });

  if (finalLines) return <Lines lines={finalLines} />;

  if (phase === 'running') {
    return <Lines lines={[...header, '', ...result, '  ' + c(p.accent, '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[frame % 10]) + ' ' + c(p.text, v.name) + '   ' + c(p.states.starting, 'starting')]} />;
  }

  if (phase === 'review') {
    const yaml = yamlStringify({ [v.name]: buildService() }).trimEnd();
    const colored = yaml.split('\n').map((l) => {
      const m = /^(\s*)(- )?([\w.-]+)(:)(.*)$/.exec(l);
      if (!m) return '    ' + c(p.yamlString, l);
      const val = m[5].trim();
      const valColor = /^\d+$/.test(val) ? p.yamlNumber : /^(true|false)$/.test(val) ? p.yamlBool : p.yamlString;
      return '    ' + m[1] + (m[2] ? c(p.line, m[2]) : '') + c(p.yamlKey, m[3]) + c(p.line, m[4]) + (val ? ' ' + c(valColor, val) : '');
    });
    const opts = ['Add and start', 'Add', 'Edit', 'Cancel'];
    return (
      <Box flexDirection="column">
        <Lines
          lines={[
            ...header,
            '',
            '  ' + c(p.accent, '+ ') + c(p.text, v.name, { bold: true }) + '   ' + c(p.path, 'serverstart.yaml'),
            '',
            ...colored,
            '',
            ...opts.map((o, i) => (i === reviewCursor ? c(p.accent, '❯ ') + c(p.text, o, { bold: true }) : '  ' + c(p.muted, o))),
            '',
          ]}
        />
        <Text>{hintsLine([{ key: '↑↓', label: 'move' }, { key: '⏎', label: 'choose' }, { key: 'esc', label: 'cancel' }], width)}</Text>
      </Box>
    );
  }

  const labels: Record<FieldKey, string> = {
    name: 'Name',
    cwd: 'Directory',
    cmd: 'Command',
    compose: 'Compose file',
    composeService: 'Compose service',
    port: 'Port',
    runtime: runtimeLabel,
    group: 'Group',
    depends: 'Depends on',
    ready: 'Ready check',
    default: 'Start by default',
  };
  const valueText = (k: FieldKey): string => {
    switch (k) {
      case 'depends':
        return v.depends.length ? v.depends.join(' ') : '–';
      case 'ready':
        return v.ready === 'port' ? `port ${v.port || '–'}` : `${v.ready} ${v.readyValue}`;
      case 'default':
        return v.default ? 'yes' : 'no';
      default:
        return (v[k] as string) || '–';
    }
  };

  const rows: React.ReactNode[] = [];
  fields.forEach((k, i) => {
    const active = k === cur;
    const mark = done.has(k) && !active ? c(p.ok, '✓') + ' ' : '  ';
    const gutter = active ? c(p.accent, '❯') : ' ';
    const label = pad(c(active ? p.text : p.label, labels[k], { bold: active }), 18);
    const src = sourceFor[k] ? c(p.muted, sourceFor[k]!) : '';
    const isText = ['name', 'cwd', 'cmd', 'compose', 'composeService', 'port', 'runtime', 'group'].includes(k);
    if (active && isText) {
      const val = v[k as 'name'] as string;
      rows.push(
        <Text key={k} wrap="truncate-end">
          {gutter + ' ' + mark + label + pad(c(p.text, val) + c(p.accent, '▏'), Math.max(10, width - 44)) + '  ' + src}
        </Text>,
      );
    } else {
      const valColor = k === 'port' ? p.port : k === 'cwd' || k === 'compose' ? p.path : k === 'cmd' ? p.cmd : p.text;
      rows.push(
        <Text key={k} wrap="truncate-end">
          {gutter + ' ' + mark + label + pad(c(valueText(k) === '–' ? p.faint : valColor, trunc(valueText(k), Math.max(10, width - 44))), Math.max(10, width - 44)) + '  ' + src}
        </Text>,
      );
    }
    if (active && k === 'name' && nameError) rows.push(<Text key="ne">{'    ' + c(p.warn, '! ' + nameError)}</Text>);
    if (active && k === 'port' && clash) {
      rows.push(<Text key="pc1">{'    ' + c(p.warn, '!') + ' ' + c(p.text, `${v.port} taken by ${clash}`) + '   ' + c(p.muted, 'free: ') + c(p.port, suggested ?? '…')}</Text>);
      if (suggested && det.portHint) rows.push(<Text key="pc2">{'      ' + c(p.muted, det.portHint(suggested))}</Text>);
      rows.push(<Text key="pc3">{'      ' + c(p.accent, '⏎') + ' ' + c(p.muted, `use ${suggested ?? '…'}`) + '   ' + c(p.muted, 'or type a port')}</Text>);
    }
    if (active && k === 'depends') {
      if (!others.length) rows.push(<Text key="dn">{'      ' + c(p.faint, '0 services')}</Text>);
      others.forEach((n, j) => {
        const on = v.depends.includes(n);
        const svc = config.services[n];
        rows.push(
          <Text key={'d' + n}>
            {'    ' + (j === optCursor ? c(p.accent, '❯ ') : '  ') + (on ? c(p.ok, '[✓]') : c(p.faint, '[ ]')) + ' ' + pad(c(p.text, n), 18) + pad(svc.port ? c(p.port, svc.port) : c(p.faint, '–'), 7) + c(p.muted, svc.kind)}
          </Text>,
        );
      });
    }
    if (active && k === 'ready') {
      readyOptions.forEach((o, j) => {
        rows.push(
          <Text key={'r' + o.key}>
            {'    ' + (j === optCursor ? c(p.accent, '❯ ') : '  ') + (v.ready === o.key ? c(p.ok, '✓ ') : '  ') + pad(c(p.text, o.label), 7) + c(p.muted, o.hint)}
          </Text>,
        );
      });
    }
  });

  const hints =
    cur === 'depends'
      ? [{ key: 'space', label: 'toggle' }, { key: '⏎', label: 'done' }, { key: 'shift-tab', label: 'back' }, { key: 'esc', label: 'cancel' }]
      : cur === 'ready'
        ? [{ key: '↑↓', label: 'choose' }, { key: '⏎', label: 'select' }, { key: 'shift-tab', label: 'back' }, { key: 'esc', label: 'cancel' }]
        : cur === 'default'
          ? [{ key: 'space', label: 'toggle' }, { key: '⏎', label: 'accept' }, { key: '↑', label: 'back' }, { key: 'tab', label: 'review' }, { key: 'esc', label: 'cancel' }]
          : [{ key: '⏎', label: 'accept' }, { key: 'type', label: 'to change' }, { key: '↑', label: 'back' }, { key: 'tab', label: 'review' }, { key: 'esc', label: 'cancel' }];

  return (
    <Box flexDirection="column">
      <Lines lines={header} />
      {rows}
      <Text> </Text>
      <Text>{hintsLine(hints, width)}</Text>
    </Box>
  );
}
