import React, { useEffect, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import type { Config } from '../config/load.js';
import { stateCell } from '../output/format.js';
import { c, duration, pad, pal, trunc } from '../output/term.js';
import type { Engine, Patch } from '../runtime/engine.js';
import { useTicker } from './components.js';

/**
 * In-place rows for `up --quiet`, `down` and `restart` on a terminal (UI.md §6).
 * Exits once `run` resolves; the caller prints the summary.
 */
export function Progress<T>(props: { engine: Engine; config: Config; names: string[]; run: () => Promise<T>; onDone: (r: T) => void }) {
  const { exit } = useApp();
  const p = pal();
  const [state, setState] = useState<Record<string, Patch & { t0: number; t1?: number }>>({});
  const [docker, setDocker] = useState<number | null>(null);
  const spinning = Object.values(state).some((s) => s.state === 'starting' || s.state === 'stopping' || s.state === 'queued') || docker !== null;
  const frame = useTicker(spinning, 80);

  useEffect(() => {
    const onChange = (name: string, patch: Patch) =>
      setState((prev) => {
        const old = prev[name];
        const t0 = old?.t0 ?? Date.now();
        const final = ['ready', 'crashed', 'stopped', 'blocked'].includes(patch.state);
        return { ...prev, [name]: { ...old, ...patch, t0, t1: final ? Date.now() : undefined } };
      });
    props.engine.on('change', onChange);
    props.engine.on('docker', setDocker);
    void props.run().then((r) => {
      setTimeout(() => {
        props.onDone(r);
        exit();
      }, 50);
    });
    return () => {
      props.engine.off('change', onChange);
      props.engine.off('docker', setDocker);
    };
  }, []);

  const rows = props.names
    .filter((n) => state[n])
    .map((n) => {
      const s = state[n];
      const svc = props.config.services[n];
      const detail =
        s.state === 'crashed'
          ? c(p.err, trunc(s.error ?? '', 44))
          : s.state === 'blocked'
            ? c(p.text, s.blocked_by ?? '') + ' ' + c(p.states.crashed, '✕')
            : s.state === 'stopping' && svc.docker
              ? c(p.cmd, `docker compose stop${svc.docker.service ? ' ' + svc.docker.service : ''}`)
              : c(s.t1 ? p.muted : p.states[s.state], duration((s.t1 ?? Date.now()) - s.t0));
      const glyphState = stateCell(s.state, frame);
      const [glyph, ...word] = glyphState.split(' ');
      return '  ' + glyph + ' ' + pad(c(p.text, n), 17) + pad(word.join(' '), 11) + pad(svc.port ? c(p.port, svc.port) : c(p.faint, '–'), 7) + detail;
    });

  return (
    <Box flexDirection="column">
      {docker !== null && <Text>{'  ' + c(p.accent, '⠼') + ' ' + c(p.text, 'Docker Desktop') + '   ' + c(p.muted, `${docker}s`)}</Text>}
      {rows.map((r, i) => (
        <Text key={i} wrap="truncate-end">
          {r}
        </Text>
      ))}
    </Box>
  );
}
