import { execa } from 'execa';

export interface ProcInfo {
  pid: number;
  pgid: number;
  /** `ps -o lstart` string; used to detect PID reuse. */
  lstart: string;
  command: string;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

/** One `ps` call for many PIDs. Missing PIDs are absent from the map. */
export async function psInfo(pids: number[]): Promise<Map<number, ProcInfo>> {
  const out = new Map<number, ProcInfo>();
  const list = [...new Set(pids.filter((p) => p > 0))];
  if (!list.length) return out;
  const r = await execa('ps', ['-o', 'pid=,pgid=,lstart=,comm=', '-p', list.join(',')], { reject: false });
  for (const line of r.stdout.split('\n')) {
    // "  4121  4121 Sat Nov 21 10:18:13 2026     /usr/local/bin/node"
    const m = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
    if (!m) continue;
    const command = m[4].trim().split('/').pop() ?? m[4].trim();
    out.set(Number(m[1]), { pid: Number(m[1]), pgid: Number(m[2]), lstart: m[3].replace(/\s+/g, ' '), command });
  }
  return out;
}

export async function processStart(pid: number): Promise<string | undefined> {
  return (await psInfo([pid])).get(pid)?.lstart;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
