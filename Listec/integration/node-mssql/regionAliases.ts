/**
 * Optional city/state alias map (edit data/region-aliases.json). Hot-reloads on
 * change so typos can be fixed without restarting the Listec service.
 */

import fs from 'fs';
import path from 'path';

export interface AliasEntry {
  key: string;
  label: string;
}

interface AliasesFile {
  cities?: Record<string, { key: string; label: string }>;
  states?: Record<string, { key: string; label: string }>;
}

const aliasesPath = path.resolve(__dirname, 'data', 'region-aliases.json');

let cache: {
  citiesUpper: Map<string, AliasEntry>;
  statesUpper: Map<string, AliasEntry>;
} | null = null;

let watchStarted = false;

function loadFile(): AliasesFile {
  try {
    if (!fs.existsSync(aliasesPath)) return { cities: {}, states: {} };
    const raw = fs.readFileSync(aliasesPath, 'utf8');
    return JSON.parse(raw) as AliasesFile;
  } catch {
    return { cities: {}, states: {} };
  }
}

function rebuildCache(): void {
  const j = loadFile();
  const citiesUpper = new Map<string, AliasEntry>();
  const statesUpper = new Map<string, AliasEntry>();
  for (const [k, v] of Object.entries(j.cities || {})) {
    const ku = String(k || '')
      .trim()
      .toUpperCase();
    if (!ku || !v?.key) continue;
    citiesUpper.set(ku, {
      key: String(v.key).trim().toUpperCase().replace(/\s+/g, '_'),
      label: String(v.label || v.key).trim() || v.key,
    });
  }
  for (const [k, v] of Object.entries(j.states || {})) {
    const ku = String(k || '')
      .trim()
      .toUpperCase();
    if (!ku || !v?.key) continue;
    statesUpper.set(ku, {
      key: String(v.key).trim().toUpperCase().replace(/\s+/g, '_'),
      label: String(v.label || v.key).trim() || v.key,
    });
  }
  cache = { citiesUpper, statesUpper };
}

export function getRegionAliasesWatcher(): void {
  if (watchStarted || process.env.LISTEC_ALIAS_NO_WATCH === '1') return;
  watchStarted = true;
  rebuildCache();
  try {
    fs.watch(aliasesPath, { persistent: false }, () => {
      try {
        rebuildCache();
        console.log('[listec] region-aliases.json reloaded');
      } catch {
        /* keep previous cache */
      }
    });
  } catch {
    /* no watch (read-only deploy path) */
  }
}

function titleCase(raw: string): string {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ''))
    .join(' ');
}

/** Normalise raw DB text to a stable bucket key (underscores, upper). */
export function toRegionKey(raw: string | null | undefined): string {
  const t = String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_');
  return t;
}

export function normaliseCity(raw: string | null | undefined): { key: string; label: string } {
  getRegionAliasesWatcher();
  if (!cache) rebuildCache();
  const upper = String(raw ?? '')
    .trim()
    .toUpperCase();
  const alias = cache!.citiesUpper.get(upper);
  if (alias) return { key: alias.key, label: alias.label };
  const key = toRegionKey(raw);
  return { key: key || 'UNKNOWN', label: titleCase(String(raw ?? '')) || 'Unknown' };
}

export function normaliseState(raw: string | null | undefined): { key: string; label: string } {
  getRegionAliasesWatcher();
  if (!cache) rebuildCache();
  const upper = String(raw ?? '')
    .trim()
    .toUpperCase();
  const alias = cache!.statesUpper.get(upper);
  if (alias) return { key: alias.key, label: alias.label };
  const key = toRegionKey(raw);
  return { key: key || 'UNKNOWN', label: titleCase(String(raw ?? '')) || 'Unknown' };
}
