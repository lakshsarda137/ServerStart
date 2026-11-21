/** Exit codes, PRD §7.3. */
export const EXIT = {
  OK: 0,
  FAILED: 1,
  USAGE: 2,
  CONFIG: 3,
  CONFLICT: 4,
  ENV: 5,
} as const;

export type ErrorCode =
  | 'USAGE'
  | 'NOT_FOUND'
  | 'CONFIG_INVALID'
  | 'NAME_EXISTS'
  | 'PORT_IN_USE'
  | 'PORT_CONFLICT'
  | 'DOCKER_UNAVAILABLE'
  | 'CWD_MISSING'
  | 'ENV'
  | 'START_FAILED'
  | 'STOP_FAILED'
  | 'NOT_A_TTY';

const exitFor: Record<ErrorCode, number> = {
  USAGE: EXIT.USAGE,
  NOT_FOUND: EXIT.USAGE,
  CONFIG_INVALID: EXIT.CONFIG,
  NAME_EXISTS: EXIT.CONFLICT,
  PORT_IN_USE: EXIT.CONFLICT,
  PORT_CONFLICT: EXIT.CONFLICT,
  DOCKER_UNAVAILABLE: EXIT.ENV,
  CWD_MISSING: EXIT.ENV,
  ENV: EXIT.ENV,
  START_FAILED: EXIT.FAILED,
  STOP_FAILED: EXIT.FAILED,
  NOT_A_TTY: EXIT.USAGE,
};

export interface ConfigIssue {
  /** e.g. `checkmate-web.depends_on` */
  path: string;
  message: string;
  hint?: string;
}

export class SSError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly exitCode: number;
  readonly issues?: ConfigIssue[];
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { hint?: string; issues?: ConfigIssue[]; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.code = code;
    this.hint = opts.hint;
    this.issues = opts.issues;
    this.details = opts.details;
    this.exitCode = exitFor[code];
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        hint: this.hint ?? null,
        ...(this.issues ? { issues: this.issues } : {}),
        ...(this.details ?? {}),
      },
    };
  }
}

/** Levenshtein distance, for "did you mean" suggestions. */
export function distance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[n];
}

export function didYouMean(input: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const dd = distance(input, c);
    if (dd < bestD) {
      bestD = dd;
      best = c;
    }
  }
  if (best && bestD <= Math.max(2, Math.floor(input.length / 3))) return best;
  return undefined;
}
