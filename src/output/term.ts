/**
 * Terminal text helpers: color mode detection, hex → ANSI, width-aware padding and truncation.
 */
import { dark, light, type Palette } from '../ui/theme.js';

export type ColorMode = 'none' | '256' | 'truecolor';

let mode: ColorMode = 'truecolor';
let palette: Palette = dark;

export function detectColorMode(opts: { noColor?: boolean; stream?: NodeJS.WriteStream } = {}): ColorMode {
  const stream = opts.stream ?? process.stdout;
  if (opts.noColor || 'NO_COLOR' in process.env || process.env.TERM === 'dumb') return 'none';
  if (process.env.FORCE_COLOR === '0') return 'none';
  if (!stream.isTTY && !process.env.FORCE_COLOR) return 'none';
  const ct = process.env.COLORTERM ?? '';
  if (/truecolor|24bit/i.test(ct)) return 'truecolor';
  if (process.env.TERM_PROGRAM === 'iTerm.app' || process.env.TERM_PROGRAM === 'WezTerm' || process.env.TERM_PROGRAM === 'vscode') return 'truecolor';
  return '256';
}

export function setColorMode(m: ColorMode): void {
  mode = m;
}
export function colorMode(): ColorMode {
  return mode;
}
export function setPalette(p: Palette): void {
  palette = p;
}
export function pal(): Palette {
  return palette;
}

/** Light/dark from COLORFGBG ("15;0" = light fg on dark bg) or SERVERSTART_THEME. */
export function envTheme(): 'light' | 'dark' | null {
  const t = process.env.SERVERSTART_THEME;
  if (t === 'light' || t === 'dark') return t;
  const fgbg = process.env.COLORFGBG;
  if (fgbg) {
    const bg = Number(fgbg.split(';').pop());
    if (!Number.isNaN(bg)) return bg === 7 || bg === 15 ? 'light' : 'dark';
  }
  return null;
}

/**
 * Ask the terminal for its background color (OSC 11). Resolves null if it doesn't answer in time.
 * Only call before Ink takes over stdin.
 */
export function queryBackground(timeoutMs = 120): Promise<'light' | 'dark' | null> {
  const stdin = process.stdin;
  if (!stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    let buf = '';
    const wasRaw = stdin.isRaw;
    const finish = (v: 'light' | 'dark' | null) => {
      clearTimeout(timer);
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      resolve(v);
    };
    const onData = (d: Buffer) => {
      buf += d.toString('latin1');
      const m = /rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i.exec(buf);
      if (m) {
        const [r, g, b] = m.slice(1).map((h) => parseInt(h.slice(0, 2), 16));
        finish((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5 ? 'light' : 'dark');
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    process.stdout.write('\u001b]11;?\u0007');
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

export function applyTheme(t: 'light' | 'dark' | null): void {
  palette = t === 'light' ? light : dark;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbTo256([r, g, b]: [number, number, number]): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const c = (v: number) => Math.round((v / 255) * 5);
  return 16 + 36 * c(r) + 6 * c(g) + c(b);
}

function fgCode(hex: string): string {
  const rgb = hexToRgb(hex);
  return mode === 'truecolor' ? `38;2;${rgb.join(';')}` : `38;5;${rgbTo256(rgb)}`;
}
function bgCode(hex: string): string {
  const rgb = hexToRgb(hex);
  return mode === 'truecolor' ? `48;2;${rgb.join(';')}` : `48;5;${rgbTo256(rgb)}`;
}

/** Raw background escape for a hex color ('' when colors are off). */
export function bgSeq(hex: string): string {
  return mode === 'none' ? '' : `\u001b[${bgCode(hex)}m`;
}

/** Color text with a hex color (no-op when colors are off). */
export function c(hex: string, s: string | number, opts: { bold?: boolean; bg?: string } = {}): string {
  const text = String(s);
  if (mode === 'none' || !text) return text;
  const codes = [fgCode(hex)];
  if (opts.bold) codes.unshift('1');
  if (opts.bg) codes.push(bgCode(opts.bg));
  const close = '\u001b[39m' + (opts.bold ? '\u001b[22m' : '') + (opts.bg ? '\u001b[49m' : '');
  return `\u001b[${codes.join(';')}m${text}${close}`;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

export function visibleLength(s: string): number {
  return [...s.replace(ANSI, '')].length;
}

/** Truncate plain text to `width` columns with an ellipsis. */
export function trunc(s: string, width: number): string {
  const chars = [...s];
  if (chars.length <= width) return s;
  if (width <= 1) return chars.slice(0, width).join('');
  return chars.slice(0, width - 1).join('') + '…';
}

/** Pad (possibly colored) text to a visible width. */
export function pad(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  const gap = Math.max(0, width - visibleLength(s));
  return align === 'left' ? s + ' '.repeat(gap) : ' '.repeat(gap) + s;
}

export function duration(ms: number): string {
  return ms < 10000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

export function uptime(s: number | null | undefined): string {
  if (s === null || s === undefined) return '';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
