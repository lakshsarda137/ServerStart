import { createConnection } from 'node:net';
import { execa } from 'execa';

function probeHost(port: number, host: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host });
    const done = (ok: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** True if something accepts TCP connections on the port (IPv4 or IPv6 loopback). */
export async function portOpen(port: number, timeoutMs = 400): Promise<boolean> {
  const [v4, v6] = await Promise.all([probeHost(port, '127.0.0.1', timeoutMs), probeHost(port, '::1', timeoutMs)]);
  return v4 || v6;
}

export interface Listener {
  pid: number;
  command: string;
}

/** Processes listening on a TCP port, via lsof. */
export async function listeners(port: number): Promise<Listener[]> {
  const r = await execa('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { reject: false });
  const out: Listener[] = [];
  let cur: Partial<Listener> = {};
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('p')) {
      if (cur.pid) out.push(cur as Listener);
      cur = { pid: Number(line.slice(1)) };
    } else if (line.startsWith('c')) cur.command = line.slice(1);
  }
  if (cur.pid) out.push({ pid: cur.pid, command: cur.command ?? '?' });
  return out;
}

/** Working directory of a process (lsof), or null. */
export async function processCwd(pid: number): Promise<string | null> {
  const r = await execa('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { reject: false });
  const line = r.stdout.split('\n').find((l) => l.startsWith('n'));
  return line ? line.slice(1) : null;
}

/** Next port at or above `start` that no configured service uses and nothing is listening on. */
export async function nextFreePort(start: number, taken: Iterable<number>): Promise<number> {
  const t = new Set(taken);
  for (let p = start; p < 65535; p++) {
    if (t.has(p)) continue;
    if (!(await portOpen(p, 200))) return p;
  }
  return start;
}
