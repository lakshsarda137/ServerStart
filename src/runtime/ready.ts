import type { ReadyCheck } from '../config/load.js';
import { logPath } from '../paths.js';
import { readRange, stripAnsi } from './logs.js';
import { portOpen } from './ports.js';

export async function httpOk(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    await res.body?.cancel();
    return res.status < 500;
  } catch {
    return false;
  }
}

/** One readiness probe (PRD §6.3 step 5). */
export async function checkReady(
  check: ReadyCheck,
  ctx: { service: string; logStart: number; startedAt: number },
): Promise<boolean> {
  switch (check.kind) {
    case 'port':
      return portOpen(check.port);
    case 'http':
      return httpOk(check.url);
    case 'log':
      return check.pattern.test(stripAnsi(readRange(logPath(ctx.service), ctx.logStart)));
    case 'alive':
      return Date.now() - ctx.startedAt >= check.ms;
  }
}

export function describeReady(check: ReadyCheck): string {
  switch (check.kind) {
    case 'port':
      return `port ${check.port}`;
    case 'http':
      return `http ${check.url}`;
    case 'log':
      return `log /${check.source}/`;
    case 'alive':
      return `alive ${check.ms / 1000}s`;
  }
}
