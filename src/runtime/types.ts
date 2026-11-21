export type ServiceState = 'stopped' | 'queued' | 'starting' | 'ready' | 'crashed' | 'blocked' | 'stopping' | 'external';

export const STATES: ServiceState[] = ['ready', 'starting', 'queued', 'stopping', 'crashed', 'blocked', 'stopped', 'external'];

/** One service's status. Same shape for `--json`, the dashboards and the web API (PRD §7.2). */
export interface ServiceStatus {
  name: string;
  state: ServiceState;
  port: number | null;
  pid: number | null;
  group: string[];
  uptime_s: number | null;
  url: string | null;
  log: string;
  error: string | null;
  runtime: string;
  kind: 'docker' | 'node' | 'python' | 'other';
  default: boolean;
  /** Set when the service isn't in the default set but a default service depends on it. */
  implied_by: string | null;
  /** For `blocked`: the dependency that failed. */
  blocked_by: string | null;
  /**
   * For `external`: the process that holds the port. `same_project` is true when it runs from
   * this service's own folder, i.e. the same app started by hand (starting it is a no-op).
   */
  external: { pid: number; command: string; same_project?: boolean } | null;
  depends_on: string[];
  /** Seconds since the current start began (starting/stopping). */
  elapsed_s?: number | null;
}
