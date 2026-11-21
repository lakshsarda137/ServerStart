import { existsSync, readFileSync } from 'node:fs';
import { statePath } from '../paths.js';
import { atomicWrite } from '../config/write.js';

export interface ProcEntry {
  pid: number;
  pgid: number;
  startedAt: number;
  /** `ps -o lstart` of the PID when started; detects PID reuse. */
  lstart?: string;
  cmdHash: string;
  port?: number;
  /** Byte offset in the log file where this run's output starts. */
  logStart: number;
  readyAt?: number;
}

export interface CrashEntry {
  at: number;
  error: string | null;
}

export interface StateFile {
  version: 1;
  procs: Record<string, ProcEntry>;
  crashed: Record<string, CrashEntry>;
  /** Last known runtime label per service, e.g. "node 20.11". */
  runtimes: Record<string, string>;
  /** Number of starts per service (for the log separator). */
  starts: Record<string, number>;
}

const empty = (): StateFile => ({ version: 1, procs: {}, crashed: {}, runtimes: {}, starts: {} });

export function readState(): StateFile {
  const p = statePath();
  if (!existsSync(p)) return empty();
  try {
    const s = JSON.parse(readFileSync(p, 'utf8')) as Partial<StateFile>;
    return { ...empty(), ...s, version: 1 };
  } catch {
    return empty();
  }
}

/** Read-modify-write. Kept short so concurrent ServerStart processes rarely collide. */
export function updateState(fn: (s: StateFile) => void): StateFile {
  const s = readState();
  fn(s);
  atomicWrite(statePath(), JSON.stringify(s, null, 2));
  return s;
}
