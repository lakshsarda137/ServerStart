import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import type { Service } from '../config/load.js';
import { stateCell } from '../output/format.js';
import { bgSeq, c, pal, trunc } from '../output/term.js';
import { logPath, tildify } from '../paths.js';
import { composeLogsArgs } from '../runtime/docker.js';
import { follow, SEPARATOR_RE, stripAnsi, tail } from '../runtime/logs.js';
import type { ServiceStatus } from '../runtime/types.js';
import { hintsLine, Lines } from './components.js';

const MAX_LINES = 5000;

function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function colorLine(line: string, isError: boolean, query: string): string {
  const p = pal();
  let base: string;
  if (SEPARATOR_RE.test(line)) return c(p.line, line);
  if (isError) base = p.err;
  else if (/\b[A-Z]\w*(Error|Exception)\b|Traceback|^\s*Error:|\bERROR\b|\bERR!/.test(line)) base = p.err;
  else if (/\bWARN(ING)?\b/.test(line)) base = p.warn;
  else if (/^\s*(INFO|DEBUG)\b/.test(line)) {
    const i = line.indexOf(':') + 1 || 5;
    return c(p.logInfo, line.slice(0, i)) + highlight(line.slice(i), p.text, query);
  } else base = p.text;
  return highlight(line, base, query);
}

function highlight(text: string, color: string, query: string): string {
  const p = pal();
  if (!query) return c(color, text);
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let out = '';
  let i = 0;
  for (let j = lower.indexOf(q); j !== -1; j = lower.indexOf(q, i)) {
    out += c(color, text.slice(i, j));
    const seq = bgSeq(p.match);
    out += seq ? seq + c('#0B1220', text.slice(j, j + q.length)) : `[${text.slice(j, j + q.length)}]`;
    i = j + q.length;
  }
  return out + c(color, text.slice(i));
}

export function LogPane(props: {
  svc: Service;
  status: ServiceStatus;
  width: number;
  height: number;
  frame: number;
  active: boolean;
  onClose: () => void;
  onRestart: () => void;
}) {
  const { svc, status, width, height } = props;
  const p = pal();
  const [lines, setLines] = useState<string[]>([]);
  const [offset, setOffset] = useState(0); // lines from the bottom; 0 = following
  const [newWhilePaused, setNewWhilePaused] = useState(0);
  const [search, setSearch] = useState<{ editing: boolean; query: string }>({ editing: false, query: '' });
  const offsetRef = useRef(0);
  offsetRef.current = offset;
  const path = logPath(svc.name);
  const [bytes, setBytes] = useState(0);

  useEffect(() => {
    const push = (text: string) => {
      const incoming = stripAnsi(text).split('\n');
      setLines((prev) => {
        const merged = [...prev];
        if (merged.length && incoming.length) merged[merged.length - 1] += incoming.shift();
        merged.push(...incoming);
        return merged.slice(-MAX_LINES);
      });
      if (offsetRef.current > 0) setNewWhilePaused((n) => n + (text.match(/\n/g)?.length ?? 0));
      if (existsSync(path)) setBytes(statSync(path).size);
    };
    if (svc.docker) {
      const child = spawn('docker', composeLogsArgs(svc.docker.compose, svc.docker.service, true, 500), { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (d: Buffer) => push(d.toString()));
      child.stderr.on('data', (d: Buffer) => push(d.toString()));
      return () => {
        child.kill();
      };
    }
    setLines([...tail(path, 2000).map(stripAnsi), '']);
    const start = existsSync(path) ? statSync(path).size : 0;
    setBytes(start);
    return follow(path, start, push);
  }, [svc.name]);

  const errorLine = status.state === 'crashed' ? status.error : null;
  const bodyHeight = Math.max(3, height - 4);
  const visible = useMemo(() => {
    const all = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
    const end = Math.max(0, all.length - offset);
    return { rows: all.slice(Math.max(0, end - bodyHeight), end), total: all.length };
  }, [lines, offset, bodyHeight]);

  const maxOffset = Math.max(0, visible.total - bodyHeight);
  const scroll = (d: number) => {
    setOffset((o) => {
      const n = Math.min(maxOffset, Math.max(0, o + d));
      if (n === 0) setNewWhilePaused(0);
      return n;
    });
  };

  const findNext = (dir: 1 | -1) => {
    const q = search.query.toLowerCase();
    if (!q) return;
    const all = lines;
    const currentBottom = all.length - 1 - offset;
    for (let k = 1; k <= all.length; k++) {
      const idx = (((currentBottom - dir * k) % all.length) + all.length) % all.length;
      if (all[idx]?.toLowerCase().includes(q)) {
        setOffset(Math.min(maxOffset, Math.max(0, all.length - 1 - idx - Math.floor(bodyHeight / 2))));
        return;
      }
    }
  };

  useInput(
    (input, key) => {
      if (search.editing) {
        if (key.return) {
          setSearch((s) => ({ ...s, editing: false }));
          findNext(1);
        } else if (key.escape) setSearch({ editing: false, query: '' });
        else if (key.backspace || key.delete) setSearch((s) => ({ ...s, query: s.query.slice(0, -1) }));
        else if (input && !key.ctrl && !key.meta) setSearch((s) => ({ ...s, query: s.query + input }));
        return;
      }
      if (key.escape || input === 'q') props.onClose();
      else if (key.upArrow || input === 'k') scroll(1);
      else if (key.downArrow || input === 'j') scroll(-1);
      else if (key.pageUp) scroll(bodyHeight - 1);
      else if (key.pageDown) scroll(-(bodyHeight - 1));
      else if (input === 'g') setOffset(maxOffset);
      else if (input === 'G') {
        setOffset(0);
        setNewWhilePaused(0);
      } else if (input === 'f') {
        setOffset((o) => (o === 0 ? Math.min(maxOffset, 1) : 0));
        setNewWhilePaused(0);
      } else if (input === '/') setSearch({ editing: true, query: '' });
      else if (input === 'n') findNext(1);
      else if (input === 'N') findNext(-1);
      else if (input === 'r') props.onRestart();
    },
    { isActive: props.active },
  );

  const rule = '  ' + c(p.line, '─'.repeat(Math.max(10, width - 4)));
  const left =
    '  ' + c(p.text, svc.name, { bold: true }) + '   ' + stateCell(status.state, props.frame) + (status.port ? '   ' + c(p.port, status.port) : '');
  const right = svc.docker ? c(p.docker, 'docker compose logs') : c(p.path, trunc(tildify(path).replace(/^.*\/(logs\/)/, '$1'), 40)) + '   ' + c(p.muted, size(bytes));
  const gap = Math.max(2, width - 2 - stripAnsi(left).length - stripAnsi(right).length);
  const header = left + ' '.repeat(gap) + right;

  const rows = visible.rows.map((l) => {
    const isErr = !!errorLine && l.trim() === errorLine;
    const text = trunc(l, width - 4);
    return (isErr ? c(p.err, '▌') + ' ' : '  ') + colorLine(text, isErr, search.query);
  });
  while (rows.length < bodyHeight) rows.push('');

  const followTag = offset === 0 ? c(p.ok, 'FOLLOWING', { bold: true }) : c(p.warn, `PAUSED${newWhilePaused ? ` +${newWhilePaused}` : ''}`, { bold: true });
  const footer = search.editing
    ? '  ' + c(p.accent, '/') + c(p.text, search.query) + c(p.accent, '▏') + '   ' + c(p.accent, '⏎') + ' ' + c(p.muted, 'find') + '   ' + c(p.accent, 'esc') + ' ' + c(p.muted, 'cancel')
    : '  ' +
      followTag +
      hintsLine(
        [
          { key: 'esc', label: 'back' },
          { key: 'f', label: 'follow' },
          { key: '↑↓', label: 'scroll' },
          { key: 'g G', label: 'top end' },
          { key: '/', label: search.query ? `find "${search.query}"` : 'find' },
          ...(search.query ? [{ key: 'n N', label: 'next prev' }] : []),
          { key: 'r', label: 'restart' },
        ],
        width - 12,
      ).replace(/^ {2}/, '   ');

  return (
    <Box flexDirection="column">
      <Lines lines={[header, rule, ...rows, rule]} />
      <Text wrap="truncate-end">{footer}</Text>
    </Box>
  );
}
