/**
 * Color tokens (UI.md §0). Shared by the Ink UI, terminal output and the web dashboard.
 * Every element has a color; nothing falls back to the terminal default.
 */
import type { ServiceState } from '../runtime/types.js';

export interface Palette {
  accent: string;
  text: string;
  label: string;
  muted: string;
  faint: string;
  line: string;
  select: string;
  star: string;
  port: string;
  path: string;
  cmd: string;
  ok: string;
  warn: string;
  err: string;
  info: string;
  docker: string;
  node: string;
  python: string;
  other: string;
  logInfo: string;
  match: string;
  yamlKey: string;
  yamlString: string;
  yamlNumber: string;
  yamlBool: string;
  states: Record<ServiceState, string>;
  // web surfaces
  bg: string;
  surface: string;
}

export const dark: Palette = {
  accent: '#E8875B',
  text: '#F1F5F9',
  label: '#CBD5E1',
  muted: '#94A3B8',
  faint: '#64748B',
  line: '#475569',
  select: '#1E293B',
  star: '#FACC15',
  port: '#22D3EE',
  path: '#93C5FD',
  cmd: '#FDBA74',
  ok: '#4ADE80',
  warn: '#FBBF24',
  err: '#F87171',
  info: '#C084FC',
  docker: '#38BDF8',
  node: '#A3E635',
  python: '#FFD43B',
  other: '#CBD5E1',
  logInfo: '#60A5FA',
  match: '#FACC15',
  yamlKey: '#93C5FD',
  yamlString: '#A3E635',
  yamlNumber: '#22D3EE',
  yamlBool: '#C084FC',
  states: {
    ready: '#4ADE80',
    starting: '#E8875B',
    queued: '#94A3B8',
    stopping: '#FBBF24',
    crashed: '#F87171',
    blocked: '#F472B6',
    stopped: '#64748B',
    external: '#C084FC',
  },
  bg: '#0B1220',
  surface: '#111A2E',
};

/** Same hues, darkened for light backgrounds (≥ 4.5:1 contrast). */
export const light: Palette = {
  accent: '#C2562A',
  text: '#0F172A',
  label: '#334155',
  muted: '#475569',
  faint: '#64748B',
  line: '#94A3B8',
  select: '#E2E8F0',
  star: '#B45309',
  port: '#0E7490',
  path: '#1D4ED8',
  cmd: '#C2410C',
  ok: '#15803D',
  warn: '#B45309',
  err: '#B91C1C',
  info: '#7E22CE',
  docker: '#0369A1',
  node: '#4D7C0F',
  python: '#A16207',
  other: '#334155',
  logInfo: '#1D4ED8',
  match: '#FDE047',
  yamlKey: '#1D4ED8',
  yamlString: '#4D7C0F',
  yamlNumber: '#0E7490',
  yamlBool: '#7E22CE',
  states: {
    ready: '#15803D',
    starting: '#C2562A',
    queued: '#475569',
    stopping: '#B45309',
    crashed: '#B91C1C',
    blocked: '#BE185D',
    stopped: '#64748B',
    external: '#7E22CE',
  },
  bg: '#F8FAFC',
  surface: '#FFFFFF',
};

export const GLYPH: Record<ServiceState, string> = {
  ready: '✓',
  starting: '⠋',
  queued: '◌',
  stopping: '⠋',
  crashed: '✕',
  blocked: '⊘',
  stopped: '–',
  external: '◇',
};

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function runtimeColor(p: Palette, runtime: string): string {
  if (runtime.startsWith('docker')) return p.docker;
  if (runtime.startsWith('node')) return p.node;
  if (runtime.startsWith('python')) return p.python;
  return p.other;
}
