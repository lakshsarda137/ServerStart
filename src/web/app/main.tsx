import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { dark, light, GLYPH, SPINNER, type Palette } from '../../ui/theme.js';
import type { ServiceState, ServiceStatus } from '../../runtime/types.js';

interface Snapshot {
  config: string;
  services: ServiceStatus[];
  groups: { group: string | null; names: string[] }[];
  counts: Partial<Record<ServiceState, number>>;
  settings: { shell: string; ready_timeout: string | number; new_services_default: boolean; start_on_login: boolean; open_dashboard_on_login: boolean };
  implied: Record<string, string>;
  docker: number | null;
  prompts: { id: string; service: string; port: number; holder: { pid: number; command: string } }[];
  result: { at: number; text: string; level: 'ok' | 'err' | 'info' } | null;
}

const LABEL: Record<ServiceState, string> = {
  ready: 'Ready',
  starting: 'Starting',
  queued: 'Queued',
  stopping: 'Stopping',
  crashed: 'Crashed',
  blocked: 'Blocked',
  stopped: 'Stopped',
  external: 'External',
};
const TILES: { state: ServiceState; also?: ServiceState[] }[] = [
  { state: 'ready' },
  { state: 'starting', also: ['queued', 'stopping'] },
  { state: 'crashed', also: ['blocked'] },
  { state: 'stopped' },
  { state: 'external' },
];
const TIMEOUTS = ['15s', '30s', '60s', '90s', '120s', '180s', '300s'];
const SHELLS = ['zsh', 'bash', 'sh', 'fish'];

// ── theme ──────────────────────────────────────────────────────────────────────

function usePalette(): Palette {
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const [isLight, setLight] = useState(mq.matches);
  useEffect(() => {
    const on = (e: MediaQueryListEvent) => setLight(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const p = isLight ? light : dark;
  useEffect(() => {
    const root = document.documentElement.style;
    for (const [k, v] of Object.entries(p)) if (typeof v === 'string') root.setProperty(`--${k}`, v);
    for (const [k, v] of Object.entries(p.states)) root.setProperty(`--s-${k}`, v);
    document.documentElement.dataset.theme = isLight ? 'light' : 'dark';
  }, [p]);
  return p;
}

// ── api ────────────────────────────────────────────────────────────────────────

async function post(path: string, body: unknown = {}): Promise<unknown> {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'X-ServerStart': '1' }, body: JSON.stringify(body) });
  return r.json();
}

function useSnapshot(): { snap: Snapshot | null; live: boolean } {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [live, setLive] = useState(false);
  useEffect(() => {
    let es: EventSource | null = null;
    let retry: number | undefined;
    const connect = () => {
      es = new EventSource('/api/events');
      es.addEventListener('status', (e) => {
        setSnap(JSON.parse((e as MessageEvent).data));
        setLive(true);
      });
      es.onerror = () => {
        setLive(false);
        es?.close();
        retry = window.setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      es?.close();
      clearTimeout(retry);
    };
  }, []);
  return { snap, live };
}

function useFrame(active: boolean): number {
  const [f, setF] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setF((x) => x + 1), 80);
    return () => clearInterval(t);
  }, [active]);
  return f;
}

// ── helpers ────────────────────────────────────────────────────────────────────

function uptime(s: number | null | undefined): string {
  if (s === null || s === undefined) return '';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d`;
}

function size(n: number | null): string {
  if (n === null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

const running = (s: ServiceStatus) => s.state === 'ready' || s.state === 'starting';

// ── icons (inline SVG, stroke) ─────────────────────────────────────────────────

const Icon = ({ d, size: sz = 16, fill }: { d: string; size?: number; fill?: boolean }) => (
  <svg width={sz} height={sz} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
const I = {
  play: 'M7 4.5v15l12-7.5z',
  stop: 'M7 7h10v10H7z',
  restart: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5',
  open: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  logs: 'M5 4h14v16H5zM9 9h6M9 13h6M9 17h4',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z',
  x: 'M6 6l12 12M18 6L6 18',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  alert: 'M12 4l9 16H3zM12 10v4M12 17.5v.01',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
};

function StatusPill({ s, frame }: { s: ServiceState; frame: number }) {
  const spin = s === 'starting' || s === 'stopping';
  return (
    <span className={`pill pill-${s}`}>
      <span className="pill-glyph">{spin ? SPINNER[frame % SPINNER.length] : GLYPH[s]}</span>
      {LABEL[s]}
    </span>
  );
}

function IconButton(props: { icon: string; label: string; onClick: () => void; disabled?: boolean }) {
  const solid = props.icon === I.play || props.icon === I.stop;
  return (
    <button
      className="icon-btn"
      title={props.label}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
    >
      <Icon d={props.icon} fill={solid} size={solid ? 13 : 16} />
    </button>
  );
}

function Switch({ on, disabled, onChange, label }: { on: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? 'on' : ''}`} disabled={disabled} onClick={() => onChange(!on)}>
      <span className="knob" />
    </button>
  );
}

// ── log drawer ─────────────────────────────────────────────────────────────────

function lineClass(line: string): string {
  if (/^── \d{4}-\d\d-\d\d .* start \d+ ─+$/.test(line)) return 'sep';
  if (/\b[A-Z]\w*(Error|Exception)\b|Traceback|^\s*Error:|\bERROR\b|\bERR!/.test(line)) return 'err';
  if (/\bWARN(ING)?\b/.test(line)) return 'warn';
  return '';
}

function highlight(text: string, q: string): React.ReactNode {
  if (!q) return text;
  const parts: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  let i = 0;
  let k = 0;
  for (let j = lower.indexOf(ql); j !== -1; j = lower.indexOf(ql, i)) {
    parts.push(text.slice(i, j), <mark key={k++}>{text.slice(j, j + q.length)}</mark>);
    i = j + q.length;
  }
  parts.push(text.slice(i));
  return parts;
}

function LogDrawer(props: { svc: ServiceStatus; frame: number; live: boolean; onClose: () => void; findRef: React.RefObject<HTMLInputElement> }) {
  const { svc } = props;
  const [lines, setLines] = useState<string[]>([]);
  const [meta, setMeta] = useState<{ path: string; size: number | null }>({ path: '', size: null });
  const [following, setFollowing] = useState(true);
  const [pending, setPending] = useState(0);
  const [query, setQuery] = useState('');
  const body = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  followRef.current = following;

  useEffect(() => {
    setLines([]);
    setFollowing(true);
    setPending(0);
    const es = new EventSource(`/api/logs/${svc.name}`);
    es.addEventListener('init', (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      setLines([...d.lines, '']); // trailing '' = the next append starts a new line
      setMeta({ path: d.path, size: d.size });
    });
    es.addEventListener('append', (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      setLines((prev) => {
        const incoming = (d.text as string).split('\n');
        const next = [...prev];
        if (next.length && incoming.length) next.push(next.pop()! + incoming.shift());
        next.push(...incoming);
        return next.slice(-5000);
      });
      if (d.size !== undefined) setMeta((m) => ({ ...m, size: d.size }));
      if (!followRef.current) setPending((n) => n + ((d.text as string).match(/\n/g)?.length ?? 0));
    });
    return () => es.close();
  }, [svc.name]);

  useEffect(() => {
    if (following && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [lines, following]);

  const onScroll = () => {
    const el = body.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    if (atBottom && !following) {
      setFollowing(true);
      setPending(0);
    } else if (!atBottom && following) setFollowing(false);
  };

  const shown = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  const matches = query ? shown.filter((l) => l.toLowerCase().includes(query.toLowerCase())).length : 0;
  const findNext = () => {
    const el = body.current;
    if (!el || !query) return;
    const rows = [...el.querySelectorAll('.log-line')] as HTMLElement[];
    const q = query.toLowerCase();
    const hit = rows.find((r) => r.offsetTop > el.scrollTop + 4 && r.textContent?.toLowerCase().includes(q)) ?? rows.find((r) => r.textContent?.toLowerCase().includes(q));
    if (hit) {
      setFollowing(false);
      el.scrollTop = hit.offsetTop - el.clientHeight / 2;
    }
  };
  const errorLine = svc.state === 'crashed' ? svc.error : null;

  return (
    <aside className="drawer" aria-label={`${svc.name} logs`}>
      <div className="drawer-head">
        <div className="drawer-title">
          <span className="drawer-name">{svc.name}</span>
          <StatusPill s={svc.state} frame={props.frame} />
        </div>
        <div className="drawer-actions">
          {svc.state !== 'external' && <IconButton icon={I.restart} label="Restart" disabled={!props.live} onClick={() => void post(`/api/services/${svc.name}/restart`)} />}
          {svc.url && <IconButton icon={I.open} label="Open in browser" onClick={() => window.open(svc.url!, '_blank')} />}
          <IconButton icon={I.x} label="Close" onClick={props.onClose} />
        </div>
      </div>
      <div className="drawer-meta mono">
        {svc.port && <span>:{svc.port}</span>}
        <span>{meta.path.replace(/^.*\/(logs\/)/, '$1')}</span>
        <span>{size(meta.size)}</span>
      </div>
      <div className="drawer-tools">
        <label className="follow">
          <Switch
            on={following}
            label="Follow"
            onChange={(v) => {
              setFollowing(v);
              if (v) setPending(0);
            }}
          />
          <span>{following ? 'Following' : pending ? `Paused, ${pending} new` : 'Paused'}</span>
        </label>
        <div className="search">
          <Icon d={I.search} size={14} />
          <input
            ref={props.findRef}
            placeholder="Find in log"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') findNext();
              if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
              e.stopPropagation();
            }}
          />
          {query && <span className="count">{matches}</span>}
        </div>
      </div>
      <div className="log mono" ref={body} onScroll={onScroll}>
        {shown.length === 0 && <div className="log-empty">No output yet</div>}
        {shown.map((l, i) => {
          const isErr = !!errorLine && l.trim() === errorLine;
          return (
            <div key={i} className={`log-line ${isErr ? 'error' : lineClass(l)}`}>
              {highlight(l, query)}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

// ── services view ──────────────────────────────────────────────────────────────

function Tiles({ snap }: { snap: Snapshot }) {
  return (
    <section className="tiles">
      {TILES.map(({ state, also }) => {
        const n = [state, ...(also ?? [])].reduce((sum, s) => sum + (snap.counts[s] ?? 0), 0);
        return (
          <div key={state} className={`tile ${n ? '' : 'zero'}`}>
            <div className="tile-value">{n}</div>
            <div className="tile-label">
              <span className="tile-glyph" style={{ color: `var(--s-${state})` }}>
                {GLYPH[state === 'starting' ? 'queued' : state]}
              </span>
              {LABEL[state]}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function ServicesView(props: { snap: Snapshot; frame: number; live: boolean; selected: string | null; cursor: string | null; select: (n: string | null) => void }) {
  const { snap, frame, live } = props;
  const [filter, setFilter] = useState('');
  const byName = new Map(snap.services.map((s) => [s.name, s]));
  const anyRunning = snap.services.some((s) => running(s) || s.state === 'crashed');

  if (!snap.services.length) {
    return (
      <section className="card empty">
        <h2>No services yet</h2>
        <p className="muted">Register a project from its folder, or let Claude Code do it.</p>
        <div className="cmd-row">
          <code>serverstart add</code>
          <span className="muted">detects the command, port and runtime</span>
        </div>
        <div className="cmd-row">
          <code>serverstart install-skill</code>
          <span className="muted">teaches Claude Code to register new apps</span>
        </div>
      </section>
    );
  }

  const q = filter.toLowerCase();
  const visible = (n: string) => !q || n.toLowerCase().includes(q) || (byName.get(n)?.group ?? []).some((g) => g.toLowerCase().includes(q));

  return (
    <>
      <Tiles snap={snap} />
      <section className="card">
        <div className="card-head">
          <h2>Services</h2>
          <div className="search">
            <Icon d={I.search} size={14} />
            <input placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          </div>
          <span className="spacer" />
          <button className="btn" disabled={!live || !anyRunning} onClick={() => void post('/api/down')}>
            <Icon d={I.stop} size={12} fill /> Stop all
          </button>
          <button className="btn primary" disabled={!live} onClick={() => void post('/api/up')}>
            <Icon d={I.play} size={12} fill /> Start default set
          </button>
        </div>
        <table className="services">
          <thead>
            <tr>
              <th className="c-star" />
              <th>Service</th>
              <th>Status</th>
              <th>Port</th>
              <th className="wide">PID</th>
              <th className="wide">Runtime</th>
              <th className="num">Uptime</th>
              <th className="c-actions" />
            </tr>
          </thead>
          <tbody>
            {snap.groups.map((g) => {
              const names = g.names.filter(visible);
              if (!names.length) return null;
              return (
                <React.Fragment key={g.group ?? '__none'}>
                  <tr className="group-row">
                    <td colSpan={8}>{g.group ?? 'Ungrouped'}</td>
                  </tr>
                  {names.map((n) => {
                    const s = byName.get(n);
                    if (!s) return null;
                    const sel = n === props.selected;
                    const focused = !props.selected && n === props.cursor;
                    const time = s.state === 'ready' ? uptime(s.uptime_s) : s.state === 'starting' || s.state === 'stopping' ? uptime(s.elapsed_s ?? null) : '';
                    const implied = snap.implied[n];
                    return (
                      <tr key={n} className={`svc ${sel ? 'sel' : ''} ${focused ? 'focus' : ''}`} onClick={() => props.select(sel ? null : n)}>
                        <td className="c-star">
                          <button
                            className={`star ${s.default ? 'on' : ''}`}
                            title={s.default ? 'In the default set' : implied ? `Starts with ${implied}` : 'Not in the default set'}
                            aria-label="Toggle default set"
                            disabled={!live}
                            onClick={(e) => {
                              e.stopPropagation();
                              void post(`/api/services/${n}/default`, { value: !s.default });
                            }}
                          >
                            <Icon d={I.star} size={15} fill={s.default} />
                          </button>
                        </td>
                        <td>
                          <div className="svc-name">{s.name}</div>
                          {s.state === 'crashed' && s.error && <div className="svc-error mono">{s.error}</div>}
                          {s.state === 'external' && s.external && (
                            <div className="svc-sub">
                              {s.external.same_project ? 'Already running outside ServerStart' : 'Port in use'}
                              <span className="mono faint">PID {s.external.pid}</span>
                            </div>
                          )}
                          {s.state === 'blocked' && s.blocked_by && (
                            <div className="svc-sub">
                              <Icon d={I.link} size={12} /> {s.blocked_by} <span style={{ color: 'var(--s-crashed)' }}>{GLYPH.crashed}</span>
                            </div>
                          )}
                        </td>
                        <td>
                          <StatusPill s={s.state} frame={frame} />
                        </td>
                        <td className="mono">{s.port ?? <span className="faint">–</span>}</td>
                        <td className="mono wide muted">{s.pid ?? <span className="faint">–</span>}</td>
                        <td className="wide muted">{s.runtime}</td>
                        <td className="num muted mono">{time}</td>
                        <td className="c-actions">
                          <div className="row-actions">
                            {running(s) ? (
                              <IconButton icon={I.stop} label="Stop" disabled={!live} onClick={() => void post(`/api/services/${n}/stop`)} />
                            ) : (
                              <IconButton
                                icon={I.play}
                                label={s.state === 'external' && s.external?.same_project ? `Already running (PID ${s.external.pid})` : 'Start'}
                                disabled={!live || s.state === 'stopping'}
                                onClick={() => void post(`/api/services/${n}/start`)}
                              />
                            )}
                            {s.state !== 'external' && <IconButton icon={I.restart} label="Restart" disabled={!live} onClick={() => void post(`/api/services/${n}/restart`)} />}
                            <IconButton icon={I.open} label="Open in browser" disabled={!s.url} onClick={() => window.open(s.url!, '_blank')} />
                            <IconButton icon={I.logs} label="Logs" onClick={() => props.select(n)} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </section>
    </>
  );
}

// ── settings view ──────────────────────────────────────────────────────────────

function SettingsView({ snap, live }: { snap: Snapshot; live: boolean }) {
  const [login, setLogin] = useState<{ ok: boolean; message: string } | 'busy' | null>(null);
  const set = async (key: string, value: unknown) => {
    if (key === 'start_on_login' || key === 'open_dashboard_on_login') setLogin('busy');
    const r = (await post('/api/settings', { key, value })) as { login: { ok: boolean; message: string } | null };
    if (r.login) setLogin(r.login);
  };
  const byName = new Map(snap.services.map((s) => [s.name, s]));
  const st = snap.settings;

  return (
    <div className="settings">
      <section className="card">
        <div className="card-head">
          <h2>Default set</h2>
        </div>
        <p className="card-desc muted">
          What <code>serverstart</code> starts with no arguments.
        </p>
        {!snap.services.length && <p className="muted pad">No services yet</p>}
        {snap.groups.map((g) => (
          <div key={g.group ?? '__none'} className="check-group">
            <div className="group-label">{g.group ?? 'Ungrouped'}</div>
            {g.names.map((n) => {
              const s = byName.get(n)!;
              const by = snap.implied[n];
              return (
                <label key={n} className="check-row">
                  <input type="checkbox" checked={s.default} disabled={!live} onChange={() => void post(`/api/services/${n}/default`, { value: !s.default })} />
                  <span className="check-name">{n}</span>
                  {s.port && <span className="mono muted">:{s.port}</span>}
                  {by && !s.default && (
                    <span className="chip" title={`Starts anyway because ${by} depends on it`}>
                      <Icon d={I.link} size={12} /> {by}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        ))}
      </section>
      <section className="card">
        <div className="card-head">
          <h2>General</h2>
        </div>
        <div className="setting">
          <div>
            <div className="setting-name">Start on login</div>
            <div className="setting-desc muted">Run the default set once when you log in.</div>
            {login === 'busy' && <div className="setting-result muted">Installing LaunchAgent</div>}
            {login && login !== 'busy' && <div className={`setting-result ${login.ok ? 'ok' : 'err'}`}>{login.message}</div>}
          </div>
          <Switch on={st.start_on_login} disabled={!live} label="Start on login" onChange={(v) => void set('start_on_login', v)} />
        </div>
        <div className={`setting ${st.start_on_login ? '' : 'disabled'}`}>
          <div>
            <div className="setting-name">Open dashboard on login</div>
            <div className="setting-desc muted">Also open a Terminal window with the dashboard.</div>
          </div>
          <Switch on={st.open_dashboard_on_login} disabled={!live || !st.start_on_login} label="Open dashboard on login" onChange={(v) => void set('open_dashboard_on_login', v)} />
        </div>
        <div className="setting">
          <div>
            <div className="setting-name">New services join the default set</div>
          </div>
          <Switch on={st.new_services_default} disabled={!live} label="New services join the default set" onChange={(v) => void set('new_services_default', v)} />
        </div>
        <div className="setting">
          <div>
            <div className="setting-name">Ready timeout</div>
            <div className="setting-desc muted">How long a service may take to become ready.</div>
          </div>
          <select value={String(st.ready_timeout)} disabled={!live} onChange={(e) => void set('ready_timeout', e.target.value)}>
            {[...new Set([String(st.ready_timeout), ...TIMEOUTS])].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="setting">
          <div>
            <div className="setting-name">Shell</div>
            <div className="setting-desc muted">Commands run as a login shell, so your PATH and version managers apply.</div>
          </div>
          <select value={st.shell} disabled={!live} onChange={(e) => void set('shell', e.target.value)}>
            {[...new Set([st.shell, ...SHELLS])].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
      </section>
    </div>
  );
}

// ── prompt & toast ─────────────────────────────────────────────────────────────

function PromptModal({ prompt }: { prompt: Snapshot['prompts'][number] }) {
  const answer = (kill: boolean) => void post(`/api/prompts/${prompt.id}`, { kill });
  const leaveRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    leaveRef.current?.focus();
    const on = (e: KeyboardEvent) => {
      if (e.key === 'y' || e.key === 'Y') answer(true);
      else if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') answer(false);
      else return;
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, [prompt.id]);
  return (
    <div className="modal-bg">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div className="modal-icon">
          <Icon d={I.alert} size={20} />
        </div>
        <h3 id="modal-title">Port {prompt.port} is in use</h3>
        <p>
          <span className="mono">{prompt.holder.command}</span> (PID <span className="mono">{prompt.holder.pid}</span>) is listening on it, and ServerStart didn't start it.
        </p>
        <p className="muted">Kill it and start {prompt.service}?</p>
        <div className="modal-actions">
          <button className="btn" ref={leaveRef} onClick={() => answer(false)}>
            Leave it
          </button>
          <button className="btn danger" onClick={() => answer(true)}>
            Kill and start
          </button>
        </div>
      </div>
    </div>
  );
}

function Toast({ result }: { result: Snapshot['result'] }) {
  if (!result) return null;
  const [name, ...rest] = result.text.split('   ');
  return (
    <div className={`toast ${result.level}`} role="status">
      <span className="toast-dot" />
      <strong>{name}</strong>
      <span className="muted">{rest.join(', ')}</span>
    </div>
  );
}

// ── app ────────────────────────────────────────────────────────────────────────

function App() {
  usePalette();
  const { snap, live } = useSnapshot();
  const [tab, setTab] = useState<'services' | 'settings'>('services');
  const [selected, setSelected] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const spinning = !!snap && (snap.docker !== null || snap.services.some((s) => s.state === 'starting' || s.state === 'stopping'));
  const frame = useFrame(spinning);
  const order = useMemo(() => (snap ? snap.groups.flatMap((g) => g.names) : []), [snap]);
  const sel = snap?.services.find((s) => s.name === selected);

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === ',') return setTab((t) => (t === 'settings' ? 'services' : 'settings'));
      if (tab !== 'services' || !snap) return;
      const curName = selected ?? cursor ?? order[0];
      const i = curName ? order.indexOf(curName) : -1;
      const move = (n: string | undefined) => {
        if (!n) return;
        setCursor(n);
        if (selected) setSelected(n);
      };
      const cur = snap.services.find((s) => s.name === curName);
      if (e.key === 'ArrowDown' || e.key === 'j') move(order[Math.min(order.length - 1, i + 1)]);
      else if (e.key === 'ArrowUp' || e.key === 'k') move(order[Math.max(0, i - 1)]);
      else if (e.key === 'Enter' && curName) setSelected((x) => (x ? null : curName));
      else if (e.key === 'Escape') setSelected(null);
      else if (!cur || !live) return;
      else if (e.key === 'r' && cur.state !== 'external') void post(`/api/services/${cur.name}/restart`);
      else if (e.key === 's') void post(`/api/services/${cur.name}/${running(cur) ? 'stop' : 'start'}`);
      else if (e.key === 'o' && cur.url) window.open(cur.url, '_blank');
      else if (e.key === 'd') void post(`/api/services/${cur.name}/default`, { value: !cur.default });
      else if (e.key === '/') {
        if (!selected) setSelected(cur.name);
        setTimeout(() => findRef.current?.focus(), 50);
      } else return;
      e.preventDefault();
    },
    [tab, snap, order, selected, cursor, live],
  );
  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  return (
    <div className={`app ${live ? '' : 'offline'} ${sel && tab === 'services' ? 'with-drawer' : ''}`}>
      <header className="appbar">
        <div className="brand">
          <span className="logo">
            <Icon d={I.play} size={11} fill />
          </span>
          ServerStart
        </div>
        <nav className="tabs">
          <button className={tab === 'services' ? 'active' : ''} onClick={() => setTab('services')}>
            Services
          </button>
          <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
            Settings
          </button>
        </nav>
        <span className="spacer" />
        {snap?.docker != null && (
          <span className="docker muted">
            <span className="spin">{SPINNER[frame % SPINNER.length]}</span> Starting Docker Desktop {snap.docker}s
          </span>
        )}
        <span className="config mono" title={snap?.config}>
          {snap && (snap.config.length > 48 ? '…' + snap.config.slice(-47) : snap.config)}
        </span>
        <span className={`conn ${live ? 'live' : 'off'}`}>
          <span className="conn-dot" />
          {live ? 'Live' : 'Disconnected'}
        </span>
      </header>
      {!live && snap && (
        <div className="banner">
          Disconnected from ServerStart. Run <code>serverstart web</code> to reconnect.
        </div>
      )}
      <main className="page">
        {!snap && <div className="loading muted">Connecting</div>}
        {snap && tab === 'services' && <ServicesView snap={snap} frame={frame} live={live} selected={selected} cursor={cursor} select={setSelected} />}
        {snap && tab === 'settings' && <SettingsView snap={snap} live={live} />}
      </main>
      {tab === 'services' && sel && <LogDrawer svc={sel} frame={frame} live={live} onClose={() => setSelected(null)} findRef={findRef} />}
      {snap && live && snap.prompts[0] && <PromptModal prompt={snap.prompts[0]} />}
      {snap && <Toast result={snap.result} />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
