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

/**
 * "Slate": a cool blue-gray scale. Almost everything is neutral; color is reserved for the
 * accent (cursor, keys, active controls) and for service states.
 */
export const dark: Palette = {
  accent: '#8DB4D9',
  text: '#DCE2EA',
  label: '#AEB7C3',
  muted: '#7D8794',
  faint: '#555E6A',
  line: '#323A45',
  select: '#1B222B',
  star: '#C7B37A',
  port: '#AEB7C3',
  path: '#7D8794',
  cmd: '#AEB7C3',
  ok: '#9CC3A0',
  warn: '#D2BC82',
  err: '#D4888A',
  info: '#A99BC9',
  docker: '#7D8794',
  node: '#7D8794',
  python: '#7D8794',
  other: '#7D8794',
  logInfo: '#7FA3C6',
  match: '#C7B37A',
  yamlKey: '#8DB4D9',
  yamlString: '#AEB7C3',
  yamlNumber: '#DCE2EA',
  yamlBool: '#A99BC9',
  states: {
    ready: '#9CC3A0',
    starting: '#8DB4D9',
    queued: '#7D8794',
    stopping: '#D2BC82',
    crashed: '#D4888A',
    blocked: '#C29AB7',
    stopped: '#555E6A',
    external: '#A99BC9',
  },
  bg: '#0F1318',
  surface: '#151A21',
};

/** Slate for light backgrounds: same hues, darkened to keep 4.5:1 contrast on white. */
export const light: Palette = {
  accent: '#2F6694',
  text: '#1C2430',
  label: '#3B4654',
  muted: '#5E6978',
  faint: '#8A94A3',
  line: '#D5DBE3',
  select: '#EAF0F6',
  star: '#8A6D1F',
  port: '#3B4654',
  path: '#5E6978',
  cmd: '#3B4654',
  ok: '#2F7A44',
  warn: '#8A6D1F',
  err: '#A63D40',
  info: '#5B4F95',
  docker: '#5E6978',
  node: '#5E6978',
  python: '#5E6978',
  other: '#5E6978',
  logInfo: '#2F6694',
  match: '#F3E3A8',
  yamlKey: '#2F6694',
  yamlString: '#3B4654',
  yamlNumber: '#1C2430',
  yamlBool: '#5B4F95',
  states: {
    ready: '#2F7A44',
    starting: '#2F6694',
    queued: '#5E6978',
    stopping: '#8A6D1F',
    crashed: '#A63D40',
    blocked: '#8E4E7A',
    stopped: '#8A94A3',
    external: '#5B4F95',
  },
  bg: '#F6F8FA',
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
