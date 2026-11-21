import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { dark, light, GLYPH, SPINNER, runtimeColor, type Palette } from '../../ui/theme.js';
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

const COUNT_ORDER: ServiceState[] = ['ready', 'starting', 'queued', 'stopping', 'crashed', 'blocked', 'stopped', 'external'];
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
    root.setProperty('--blocked', p.states.blocked);
    document.documentElement.style.colorScheme = isLight ? 'light' : 'dark';
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
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function size(n: number | null): string {
  if (n === null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function StateCell({ s, p, frame }: { s: ServiceState; p: Palette; frame: number }) {
  const glyph = s === 'starting' || s === 'stopping' ? SPINNER[frame % SPINNER.length] : GLYPH[s];
  return <span style={{ color: p.states[s] }}>{`${glyph} ${s}`}</span>;
}

function Counts({ snap, p, frame }: { snap: Snapshot; p: Palette; frame: number }) {
  if (snap.docker !== null)
    return (
      <span>
        <span style={{ color: p.accent }}>{SPINNER[frame % SPINNER.length]}</span> Docker Desktop <span className="muted">{snap.docker}s</span>
      </span>
    );
  if (!snap.services.length) return <span className="muted">0 services</span>;
  return (
    <>
      {COUNT_ORDER.filter((s) => snap.counts[s]).map((s) => (
        <span key={s} style={{ color: p.states[s] }}>{`${GLYPH[s]} ${snap.counts[s]} ${s}`}</span>
      ))}
    </>
  );
}

const canStop = (s: ServiceStatus) => s.state === 'ready' || s.state === 'starting';

// ── log panel ──────────────────────────────────────────────────────────────────

function classify(line: string): string {
  if (/^── \d{4}-\d\d-\d\d .* start \d+ ─+$/.test(line)) return 'sep';
  if (/\b[A-Z]\w*(Error|Exception)\b|Traceback|^\s*Error:|\bERROR\b|\bERR!/.test(line)) return 'lvl-err';
  if (/\bWARN(ING)?\b/.test(line)) return 'lvl-warn';
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

function LogLine({ line, isError, q }: { line: string; isError: boolean; q: string }) {
  const cls = isError ? 'error' : classify(line);
  const m = /^(\s*(?:INFO|DEBUG):?)(.*)$/.exec(line);
  return (
    <div className={`log-line ${cls}`}>
      {m && !cls ? (
        <>
          <span className="lvl-info">{m[1]}</span>
          {highlight(m[2], q)}
        </>
      ) : (
        highlight(line, q)
      )}
    </div>
  );
}

function LogPanel({ svc, p, frame, onClose, findRef }: { svc: ServiceStatus; p: Palette; frame: number; onClose: () => void; findRef: React.RefObject<HTMLInputElement> }) {
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
      setLines(d.lines);
      setMeta({ path: d.path, size: d.size });
    });
    es.addEventListener('append', (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      setLines((prev) => {
        const incoming = (d.text as string).split('\n');
        const next = [...prev];
        if (next.length && prev[prev.length - 1] !== undefined && incoming.length) {
          // continue a partial last line
          const last = next.pop()!;
          next.push(last + incoming.shift());
        }
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

  const findNext = () => {
    const el = body.current;
    if (!el || !query) return;
    const rows = [...el.querySelectorAll('.log-line')];
    const top = el.scrollTop;
    const hit = rows.find((r) => (r as HTMLElement).offsetTop > top + 4 && r.textContent?.toLowerCase().includes(query.toLowerCase())) ?? rows.find((r) => r.textContent?.toLowerCase().includes(query.toLowerCase()));
    if (hit) {
      setFollowing(false);
      el.scrollTop = (hit as HTMLElement).offsetTop - el.clientHeight / 2;
    }
  };

  const shown = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  const errorLine = svc.state === 'crashed' ? svc.error : null;
  return (
    <aside className="panel">
      <div className="panel-head">
        <div className="row">
          <span className="name" style={{ fontWeight: 700 }}>
            {svc.name}
          </span>
          <StateCell s={svc.state} p={p} frame={frame} />
          {svc.port && <span className="port">{svc.port}</span>}
          <span className="spacer" />
          <button className="btn close" onClick={onClose}>
            [close]
          </button>
        </div>
        <div className="row">
          <span className="path">{meta.path.replace(/^.*\/(logs\/)/, '$1')}</span>
          <span className="muted">{size(meta.size)}</span>
        </div>
      </div>
      <div className="panel-body" ref={body} onScroll={onScroll}>
        {shown.map((l, i) => (
          <LogLine key={i} line={l} isError={!!errorLine && l.trim() === errorLine} q={query} />
        ))}
      </div>
      <div className="panel-foot">
        <button
          className={`follow ${following ? 'on' : 'off'}`}
          onClick={() => {
            setFollowing(true);
            setPending(0);
          }}
        >
          {following ? 'FOLLOWING' : `PAUSED${pending ? ` +${pending}` : ''}`}
        </button>
        <input
          ref={findRef}
          className="find"
          placeholder="find"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') findNext();
            if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
            e.stopPropagation();
          }}
        />
      </div>
    </aside>
  );
}

// ── services view ──────────────────────────────────────────────────────────────

function ServicesView(props: {
  snap: Snapshot;
  p: Palette;
  frame: number;
  selected: string | null;
  setSelected: (n: string) => void;
  panel: boolean;
  setPanel: (v: boolean) => void;
  findRef: React.RefObject<HTMLInputElement>;
}) {
  const { snap, p, frame } = props;
  const byName = new Map(snap.services.map((s) => [s.name, s]));
  const sel = props.selected ? byName.get(props.selected) : undefined;
  if (!snap.services.length) {
    return (
      <div className="list">
        <div className="empty">
          <span className="cmd">serverstart add</span>
          <span className="muted">register the project in the current directory</span>
          <span className="cmd">serverstart install-skill</span>
          <span className="muted">let Claude Code register projects</span>
        </div>
      </div>
    );
  }
  return (
    <div className="main">
      <div className="list">
        <table>
          <thead>
            <tr>
              <th />
              <th>NAME</th>
              <th>STATE</th>
              <th>PORT</th>
              <th className="wide">PID</th>
              <th className="wide">RUNTIME</th>
              <th className="right">UPTIME</th>
            </tr>
          </thead>
          <tbody>
            {snap.groups.map((g) => (
              <React.Fragment key={g.group ?? '__none'}>
                <tr className="group">
                  <td colSpan={7}>{g.group ? g.group.toUpperCase() : 'UNGROUPED'}</td>
                </tr>
                {g.names.map((n) => {
                  const s = byName.get(n);
                  if (!s) return null;
                  const isSel = n === props.selected;
                  const time = s.state === 'ready' ? uptime(s.uptime_s) : s.state === 'starting' || s.state === 'stopping' ? uptime(s.elapsed_s ?? null) : '';
                  return (
                    <React.Fragment key={n}>
                      <tr
                        className={`svc ${isSel ? 'sel' : ''}`}
                        onClick={() => {
                          if (isSel) props.setPanel(!props.panel);
                          else {
                            props.setSelected(n);
                            props.setPanel(true);
                          }
                        }}
                      >
                        <td>
                          <button
                            className={`star ${s.default ? '' : 'off'}`}
                            title={s.default ? 'in default set' : 'not in default set'}
                            onClick={(e) => {
                              e.stopPropagation();
                              void post(`/api/services/${n}/default`, { value: !s.default });
                            }}
                          >
                            ★
                          </button>
                        </td>
                        <td className="name">{s.name}</td>
                        <td>
                          <StateCell s={s.state} p={p} frame={frame} />
                        </td>
                        <td>{s.port ? <span className="port">{s.port}</span> : <span className="faint">–</span>}</td>
                        <td className="wide">{s.pid ? <span className="muted">{s.pid}</span> : <span className="faint">–</span>}</td>
                        <td className="wide" style={{ color: runtimeColor(p, s.runtime) }}>
                          {s.runtime}
                        </td>
                        <td className="right" style={{ color: s.state === 'ready' ? p.muted : p.states[s.state] }}>
                          {time}
                        </td>
                      </tr>
                      {s.state === 'crashed' && s.error && (
                        <tr className={`sub ${isSel ? 'sel' : ''}`}>
                          <td />
                          <td colSpan={6}>
                            <span className="tree">└ </span>
                            <span className="err">{s.error}</span>
                          </td>
                        </tr>
                      )}
                      {s.state === 'blocked' && s.blocked_by && (
                        <tr className="sub">
                          <td />
                          <td colSpan={6}>
                            <span className="tree">└ </span>
                            <span className="name">{s.blocked_by}</span> <span style={{ color: p.states.crashed }}>✕</span>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {props.panel && sel && <LogPanel svc={sel} p={p} frame={frame} onClose={() => props.setPanel(false)} findRef={props.findRef} />}
    </div>
  );
}

function ActionBar({ snap, sel, p, live }: { snap: Snapshot; sel?: ServiceStatus; p: Palette; live: boolean }) {
  const r = snap.result;
  const disabled = !live || !sel;
  return (
    <div className="actions">
      {sel && sel.state !== 'external' && (
        <button className="btn" disabled={disabled} onClick={() => void post(`/api/services/${sel.name}/restart`)}>
          [restart]
        </button>
      )}
      {sel && sel.state !== 'external' && sel.state !== 'stopping' && (
        <button className="btn" disabled={disabled} onClick={() => void post(`/api/services/${sel.name}/${canStop(sel) ? 'stop' : 'start'}`)}>
          {canStop(sel) ? '[stop]' : '[start]'}
        </button>
      )}
      {sel?.url && (
        <button className="btn" disabled={disabled} onClick={() => window.open(sel.url!, '_blank')}>
          [open]
        </button>
      )}
      {sel && (
        <button className="btn" disabled={disabled} onClick={() => void post(`/api/services/${sel.name}/default`, { value: !sel.default })}>
          {sel.default ? '[★ remove default]' : '[★ default]'}
        </button>
      )}
      {r && (
        <span className="result">
          <span style={{ color: r.level === 'ok' ? p.ok : r.level === 'err' ? p.err : p.star }}>{r.level === 'ok' ? '✓' : r.level === 'err' ? '✕' : '★'}</span>{' '}
          <span className="name">{r.text.split('   ')[0]}</span>
          <span className={r.level === 'err' ? 'err' : 'muted'}>{'   ' + r.text.split('   ').slice(1).join('   ')}</span>
        </span>
      )}
    </div>
  );
}

// ── settings view ──────────────────────────────────────────────────────────────

function SettingsView({ snap, p, live }: { snap: Snapshot; p: Palette; live: boolean }) {
  const [login, setLogin] = useState<{ ok: boolean; message: string } | 'busy' | null>(null);
  const set = async (key: string, value: unknown) => {
    if (key === 'start_on_login' || key === 'open_dashboard_on_login') setLogin('busy');
    const r = (await post('/api/settings', { key, value })) as { login: { ok: boolean; message: string } | null };
    if (r.login) setLogin(r.login);
  };
  const byName = new Map(snap.services.map((s) => [s.name, s]));
  const st = snap.settings;
  const box = (on: boolean | 'implied') => <span className={`box ${on === 'implied' ? 'implied' : on ? 'on' : 'off'}`}>{on === 'implied' ? '[+]' : on ? '[✓]' : '[ ]'}</span>;
  const cycle = (opts: string[], cur: string, dir: number) => opts[(Math.max(0, opts.indexOf(cur)) + dir + opts.length) % opts.length];

  return (
    <div className="settings">
      <div className="card">
        <div className="heading">DEFAULT SET</div>
        {!snap.services.length && <div className="muted">0 services</div>}
        {snap.groups.map((g) => (
          <div key={g.group ?? '__none'}>
            <div className="glabel">{g.group ? g.group.toUpperCase() : 'UNGROUPED'}</div>
            {g.names.map((n) => {
              const s = byName.get(n)!;
              const by = snap.implied[n];
              return (
                <button key={n} className="check" disabled={!live} onClick={() => void post(`/api/services/${n}/default`, { value: !s.default })}>
                  {box(s.default ? true : by ? 'implied' : false)}
                  <span className="label" style={{ width: 180 }}>
                    {n}
                  </span>
                  <span className="port" style={{ width: 50 }}>
                    {s.port ?? ''}
                  </span>
                  {by && !s.default && (
                    <span>
                      <span className="muted">← </span>
                      {by}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="card">
        <div className="heading">GENERAL</div>
        <button className="check" disabled={!live} onClick={() => void set('start_on_login', !st.start_on_login)}>
          {box(st.start_on_login)}
          <span className="label">Start on login</span>
          {login === 'busy' && <span style={{ color: p.accent }}>LaunchAgent</span>}
          {login && login !== 'busy' && <span style={{ color: login.ok ? p.ok : p.err }}>{(login.ok ? '✓ ' : '✕ ') + login.message}</span>}
        </button>
        <button className="check" disabled={!live || !st.start_on_login} onClick={() => void set('open_dashboard_on_login', !st.open_dashboard_on_login)}>
          {box(st.open_dashboard_on_login)}
          <span className="label">Open dashboard on login</span>
        </button>
        <button className="check" disabled={!live} onClick={() => void set('new_services_default', !st.new_services_default)}>
          {box(st.new_services_default)}
          <span className="label">New services join default set</span>
        </button>
        <div className="stepper">
          <span className="label">Ready timeout</span>
          <button className="btn" disabled={!live} onClick={() => void set('ready_timeout', cycle(TIMEOUTS, String(st.ready_timeout), -1))}>
            [-]
          </button>
          <span className="name" style={{ width: 48, textAlign: 'center' }}>
            {String(st.ready_timeout)}
          </span>
          <button className="btn" disabled={!live} onClick={() => void set('ready_timeout', cycle(TIMEOUTS, String(st.ready_timeout), 1))}>
            [+]
          </button>
        </div>
        <div className="stepper">
          <span className="label">Shell</span>
          <select value={st.shell} disabled={!live} onChange={(e) => void set('shell', e.target.value)}>
            {[...new Set([st.shell, ...SHELLS])].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

// ── prompt ─────────────────────────────────────────────────────────────────────

function PromptModal({ prompt }: { prompt: Snapshot['prompts'][number] }) {
  const answer = (kill: boolean) => void post(`/api/prompts/${prompt.id}`, { kill });
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === 'y' || e.key === 'Y') answer(true);
      else if (e.key === 'n' || e.key === 'N' || e.key === 'Escape' || e.key === 'Enter') answer(false);
      e.stopPropagation();
    };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, [prompt.id]);
  return (
    <div className="modal-bg">
      <div className="modal">
        <div className="title">Port {prompt.port} in use</div>
        <div>
          <span className="muted">PID </span>
          {prompt.holder.pid}
          {'   '}
          {prompt.holder.command}
        </div>
        <div style={{ marginTop: 12 }}>
          Kill {prompt.holder.pid} and start {prompt.service}?
        </div>
        <div className="row">
          <button className="btn" onClick={() => answer(true)}>
            [y kill and start]
          </button>
          <button className="btn" onClick={() => answer(false)} autoFocus>
            [N leave it]
          </button>
        </div>
      </div>
    </div>
  );
}

// ── app ────────────────────────────────────────────────────────────────────────

function App() {
  const p = usePalette();
  const { snap, live } = useSnapshot();
  const [tab, setTab] = useState<'services' | 'settings'>('services');
  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState(false);
  const findRef = useRef<HTMLInputElement>(null);
  const spinning = !!snap && (snap.docker !== null || snap.services.some((s) => s.state === 'starting' || s.state === 'stopping'));
  const frame = useFrame(spinning);

  const order = useMemo(() => (snap ? snap.groups.flatMap((g) => g.names) : []), [snap]);
  useEffect(() => {
    if (!selected && order.length) setSelected(order[0]);
  }, [order, selected]);
  const sel = snap?.services.find((s) => s.name === selected);

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT' || e.metaKey || e.ctrlKey) return;
      if (e.key === ',') return setTab((t) => (t === 'settings' ? 'services' : 'settings'));
      if (tab !== 'services' || !snap) return;
      const i = selected ? order.indexOf(selected) : -1;
      if (e.key === 'ArrowDown' || e.key === 'j') setSelected(order[Math.min(order.length - 1, i + 1)]);
      else if (e.key === 'ArrowUp' || e.key === 'k') setSelected(order[Math.max(0, i - 1)]);
      else if (e.key === 'Enter') setPanel((v) => !v);
      else if (e.key === 'Escape') setPanel(false);
      else if (!sel || !live) return;
      else if (e.key === 'r' && sel.state !== 'external') void post(`/api/services/${sel.name}/restart`);
      else if (e.key === 's' && sel.state !== 'external' && sel.state !== 'stopping') void post(`/api/services/${sel.name}/${canStop(sel) ? 'stop' : 'start'}`);
      else if (e.key === 'o' && sel.url) window.open(sel.url, '_blank');
      else if (e.key === 'd') void post(`/api/services/${sel.name}/default`, { value: !sel.default });
      else if (e.key === '/') {
        setPanel(true);
        setTimeout(() => findRef.current?.focus(), 0);
        e.preventDefault();
      } else return;
      e.preventDefault();
    },
    [tab, snap, order, selected, sel, live],
  );
  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  return (
    <div className={`app ${live ? '' : 'offline'}`}>
      <header className="top">
        <div className="top-row">
          <span className="brand">ServerStart</span>
          <span className="path">{snap?.config ?? ''}</span>
          <span className="spacer" />
          {live ? (
            <span className="conn live">● LIVE</span>
          ) : (
            <span>
              <span className="conn offline">● OFFLINE</span>
              {'   '}
              <span className="cmd">serverstart web</span>
            </span>
          )}
        </div>
        <div className="counts">{snap && <Counts snap={snap} p={p} frame={frame} />}</div>
        <nav className="tabs">
          <button className={`tab ${tab === 'services' ? 'active' : ''}`} onClick={() => setTab('services')}>
            SERVICES
          </button>
          <button className={`tab ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>
            SETTINGS
          </button>
        </nav>
      </header>
      {snap && tab === 'services' && <ServicesView snap={snap} p={p} frame={frame} selected={selected} setSelected={setSelected} panel={panel} setPanel={setPanel} findRef={findRef} />}
      {snap && tab === 'settings' && <SettingsView snap={snap} p={p} live={live} />}
      {snap && tab === 'services' && snap.services.length > 0 && <ActionBar snap={snap} sel={sel} p={p} live={live} />}
      {snap && live && snap.prompts[0] && <PromptModal prompt={snap.prompts[0]} />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
