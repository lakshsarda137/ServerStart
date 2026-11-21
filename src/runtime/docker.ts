import { execa } from 'execa';
import { sleep } from './proc.js';

export async function dockerVersion(): Promise<string | null> {
  const r = await execa('docker', ['info', '--format', '{{.ServerVersion}}'], { reject: false, timeout: 8000 });
  return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

export async function dockerInstalled(): Promise<boolean> {
  const r = await execa('docker', ['--version'], { reject: false });
  return r.exitCode === 0;
}

/** Launch Docker Desktop and wait until the daemon answers (PRD §6.3 step 3). */
export async function ensureDocker(onTick?: (elapsedS: number) => void, timeoutMs = 90000): Promise<boolean> {
  if (await dockerVersion()) return true;
  if (!(await dockerInstalled())) return false;
  await execa('open', ['-a', 'Docker'], { reject: false });
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    onTick?.(Math.round((Date.now() - start) / 1000));
    await sleep(2000);
    if (await dockerVersion()) return true;
  }
  return false;
}

export interface ComposeContainer {
  Service: string;
  State: string; // running | exited | restarting | created | paused
  Health?: string;
  ExitCode?: number;
  Status?: string; // "Up 12 minutes"
  Name?: string;
}

export async function composePs(file: string): Promise<ComposeContainer[] | null> {
  const r = await execa('docker', ['compose', '-f', file, 'ps', '-a', '--format', 'json'], { reject: false, timeout: 10000 });
  if (r.exitCode !== 0) return null;
  const text = r.stdout.trim();
  if (!text) return [];
  try {
    if (text.startsWith('[')) return JSON.parse(text) as ComposeContainer[];
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ComposeContainer);
  } catch {
    return null;
  }
}

export async function composeUp(file: string, service?: string): Promise<{ ok: boolean; error?: string }> {
  const r = await execa('docker', ['compose', '-f', file, 'up', '-d', ...(service ? [service] : [])], {
    reject: false,
    timeout: 300000,
  });
  return r.exitCode === 0 ? { ok: true } : { ok: false, error: lastLine(r.stderr || r.stdout) };
}

export async function composeStop(file: string, service?: string): Promise<{ ok: boolean; error?: string }> {
  const r = await execa('docker', ['compose', '-f', file, 'stop', ...(service ? [service] : [])], {
    reject: false,
    timeout: 120000,
  });
  return r.exitCode === 0 ? { ok: true } : { ok: false, error: lastLine(r.stderr || r.stdout) };
}

export function composeLogsArgs(file: string, service: string | undefined, followLogs: boolean, n = 200): string[] {
  return ['compose', '-f', file, 'logs', '--no-color', '--tail', String(n), ...(followLogs ? ['-f'] : []), ...(service ? [service] : [])];
}

/** "Up 12 minutes" → seconds (approximate). */
export function parseUpSeconds(status?: string): number | null {
  if (!status) return null;
  const m = /Up (?:(About an?|\d+) )?(second|minute|hour|day|week)s?/i.exec(status);
  if (!m) return /Up Less than a second/i.test(status) ? 0 : null;
  const n = !m[1] || /about/i.test(m[1]) ? 1 : Number(m[1]);
  const unit = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800 }[m[2].toLowerCase() as 'second'];
  return n * unit;
}

function lastLine(s: string): string {
  const lines = s.trim().split('\n').filter(Boolean);
  return lines[lines.length - 1] ?? 'docker compose failed';
}
