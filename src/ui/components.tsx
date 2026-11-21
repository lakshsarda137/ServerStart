import React, { useEffect, useState } from 'react';
import { Text, useStdout } from 'ink';
import { bgSeq, c, pal, visibleLength } from '../output/term.js';

/** Terminal size, updated on resize. */
export function useSize(): { cols: number; rows: number } {
  const { stdout } = useStdout();
  const get = () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
  const [size, setSize] = useState(get);
  useEffect(() => {
    const on = () => setSize(get());
    stdout.on('resize', on);
    return () => {
      stdout.off('resize', on);
    };
  }, [stdout]);
  return size;
}

/** Re-render every `ms` while `active`; returns a frame counter for spinners. */
export function useTicker(active: boolean, ms = 80): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setFrame((f) => f + 1), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return frame;
}

/** Content width: terminal width capped at 100 (UI.md §0 layout rules). */
export function contentWidth(cols: number): number {
  return Math.min(cols, 100);
}

function fit(s: string, width: number): string {
  const len = visibleLength(s);
  return len >= width ? s : s + ' '.repeat(width - len);
}

/**
 * Rounded header box with a title in the top border and an optional right-aligned path.
 * `lines` are [left, right] pairs of pre-colored strings.
 */
export function boxLines(opts: { title: string; right?: string; lines: [string, string?][]; width: number; border?: string }): string[] {
  const p = pal();
  const w = Math.max(20, opts.width);
  const b = opts.border ?? p.line;
  const inner = w - 2;
  const titleTxt = `─ ${opts.title} `;
  const rightTxt = opts.right ? ` ${opts.right} ─` : '';
  const fill = Math.max(1, inner - [...titleTxt].length - [...rightTxt].length);
  const top =
    c(b, '╭─ ') +
    c(p.accent, opts.title, { bold: true }) +
    c(b, ' ' + '─'.repeat(fill)) +
    (opts.right ? ' ' + c(p.path, opts.right) + c(b, ' ─') : '') +
    c(b, '╮');
  const body = opts.lines.map(([left, right]) => {
    const space = inner - 2 - visibleLength(left) - (right ? visibleLength(right) + 2 : 0);
    const content = '  ' + left + ' '.repeat(Math.max(1, space)) + (right ? right + '  ' : '');
    return c(b, '│') + fit(content, inner) + c(b, '│');
  });
  const bottom = c(b, '╰' + '─'.repeat(inner) + '╯');
  return [top, ...body, bottom];
}

export function Lines({ lines }: { lines: string[] }) {
  return (
    <>
      {lines.map((l, i) => (
        <Text key={i} wrap="truncate-end">
          {l || ' '}
        </Text>
      ))}
    </>
  );
}

export interface Hint {
  key: string;
  label: string;
}

/** Footer key hints: keys in accent, labels in muted, 3 spaces apart. Drops trailing hints to fit. */
export function hintsLine(hints: Hint[], width: number): string {
  const p = pal();
  const parts = hints.map((h) => c(p.accent, h.key) + ' ' + c(p.muted, h.label));
  let line = '';
  for (let i = 0; i < parts.length; i++) {
    const next = line ? line + '   ' + parts[i] : parts[i];
    if (visibleLength('  ' + next) > width) {
      const help = c(p.accent, '?') + ' ' + c(p.muted, 'keys');
      return '  ' + (visibleLength('  ' + line + '   ' + help) <= width ? line + '   ' + help : help);
    }
    line = next;
  }
  return '  ' + line;
}

/** Paint a whole line with a background color, keeping inner colors. */
export function withBg(line: string, hex: string, width: number): string {
  const seq = bgSeq(hex);
  const padded = line + ' '.repeat(Math.max(0, width - visibleLength(line)));
  if (!seq) return padded;
  return seq + padded.replace(/\u001b\[0m/g, '\u001b[0m' + seq) + '\u001b[0m';
}
