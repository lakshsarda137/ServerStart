import { closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync, writeSync, watch } from 'node:fs';
import { logPath, logsDir } from '../paths.js';

export const ROTATE_BYTES = 10 * 1024 * 1024;
const KEEP = 2;

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g, '');
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export const SEPARATOR_RE = /^── (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)   start (\d+) ─+$/;

export function rotate(path: string): void {
  if (!existsSync(path) || statSync(path).size < ROTATE_BYTES) return;
  const oldest = `${path}.${KEEP}`;
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let i = KEEP - 1; i >= 1; i--) if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
  renameSync(path, `${path}.1`);
}

/** Rotate if needed, append a start separator, and return an fd for the child plus this run's start offset. */
export function openLogForStart(service: string, startNo: number): { fd: number; offset: number; path: string } {
  mkdirSync(logsDir(), { recursive: true });
  const path = logPath(service);
  rotate(path);
  const fd = openSync(path, 'a');
  const line = `── ${stamp()}   start ${startNo} `;
  writeSync(fd, `${line}${'─'.repeat(Math.max(4, 72 - line.length))}\n`);
  const offset = statSync(path).size;
  return { fd, offset, path };
}

export function closeFd(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    /* already closed */
  }
}

export function logSize(service: string): number {
  const p = logPath(service);
  return existsSync(p) ? statSync(p).size : 0;
}

/** Read bytes [from, to) of a file as UTF-8. */
export function readRange(path: string, from: number, to?: number): string {
  if (!existsSync(path)) return '';
  const size = statSync(path).size;
  const end = Math.min(to ?? size, size);
  if (from >= end) return '';
  const buf = Buffer.alloc(end - from);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, buf.length, from);
  } finally {
    closeSync(fd);
  }
  return buf.toString('utf8');
}

/** Last `n` lines of a log file. */
export function tail(path: string, n: number): string[] {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  let from = Math.max(0, size - 64 * 1024);
  let text = readRange(path, from);
  while (text.split('\n').length <= n + 1 && from > 0) {
    from = Math.max(0, from - 256 * 1024);
    text = readRange(path, from);
  }
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (from > 0) lines.shift(); // partial first line
  return lines.slice(-n);
}

const STRONG = /\b[A-Z]\w*(?:Error|Exception)\b|^Error:|\bError: |Traceback \(most recent call last\)|\bERR!|EADDRINUSE|command not found|panic:/;
const WEAK = /\berror\b|\bfailed\b|\bfatal\b|\bnot found\b|\bcannot\b|\bunable to\b/i;

/** The most meaningful error line in some log text (PRD §6.3 step 5). */
export function extractError(text: string): string | null {
  const lines = stripAnsi(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !SEPARATOR_RE.test(l));
  if (!lines.length) return null;
  const strong = lines.filter((l) => STRONG.test(l) && !/^Traceback/.test(l));
  if (strong.length) return strong[strong.length - 1];
  const weak = lines.filter((l) => WEAK.test(l));
  if (weak.length) return weak[weak.length - 1];
  return lines[lines.length - 1];
}

export function errorSince(service: string, offset: number): string | null {
  const path = logPath(service);
  const size = existsSync(path) ? statSync(path).size : 0;
  const from = Math.max(offset, size - 64 * 1024);
  return extractError(readRange(path, from));
}

/** Follow a file: calls `onData` with new text. Returns a stop function. */
export function follow(path: string, fromOffset: number, onData: (text: string) => void): () => void {
  let pos = fromOffset;
  let stopped = false;
  const check = () => {
    if (stopped || !existsSync(path)) return;
    const size = statSync(path).size;
    if (size < pos) pos = 0; // rotated or truncated
    if (size > pos) {
      const text = readRange(path, pos, size);
      pos = size;
      onData(text);
    }
  };
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(path, () => check());
  } catch {
    /* file may not exist yet; the interval covers it */
  }
  const timer = setInterval(check, 500);
  check();
  return () => {
    stopped = true;
    clearInterval(timer);
    watcher?.close();
  };
}
