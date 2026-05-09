/**
 * Cached lookups that resolve human-friendly LIS codes to the numeric ids
 * the stored procedure expects. Each map is loaded lazily on first use and
 * kept in process memory until the API restarts.
 */

import sql from 'mssql';
import { getListecPool } from './listec.client';
import { getRegionAliasesWatcher, normaliseCity, normaliseState } from './regionAliases';

interface CodeMap {
  byCodeUpper: Map<string, number>;
  byNameUpper: Map<string, number>;
}

/** One MCC unit client code → normalised geography for Tracer region chips */
export interface MccGeoLookup {
  cityKey: string;
  cityLabel: string;
  stateKey: string;
  stateLabel: string;
}

export interface RegionCityNode {
  key: string;
  label: string;
  mccCount: number;
}

export interface RegionStateNode {
  key: string;
  label: string;
  mccCount: number;
  cities: RegionCityNode[];
}

let buCache: CodeMap | null = null;
let statusCache: CodeMap | null = null;
let deptCache: CodeMap | null = null;
let mccGeoCache: Map<string, MccGeoLookup> | null = null;

function emptyMap(): CodeMap {
  return { byCodeUpper: new Map(), byNameUpper: new Map() };
}

function add(map: CodeMap, code: string | null, name: string | null, id: number) {
  if (code) map.byCodeUpper.set(code.trim().toUpperCase(), id);
  if (name) map.byNameUpper.set(name.trim().toUpperCase(), id);
}

async function loadBu(): Promise<CodeMap> {
  if (buCache) return buCache;
  const pool = await getListecPool();
  const r = await pool
    .request()
    .query<{ id: number; BusinessUnitCode: string | null; BusinessUnitName: string | null }>(
      'SELECT id, BusinessUnitCode, BusinessUnitName FROM dbo.tbl_med_business_unit_master',
    );
  const map = emptyMap();
  for (const row of r.recordset) add(map, row.BusinessUnitCode, row.BusinessUnitName, row.id);
  buCache = map;
  return map;
}

async function loadStatus(): Promise<CodeMap> {
  if (statusCache) return statusCache;
  const pool = await getListecPool();
  const r = await pool
    .request()
    .query<{ id: number; status: string | null }>(
      'SELECT id, status FROM dbo.tbl_med_mcc_patient_samples_status_master',
    );
  const map = emptyMap();
  for (const row of r.recordset) add(map, row.status, row.status, row.id);
  statusCache = map;
  return map;
}

async function loadDept(): Promise<CodeMap> {
  if (deptCache) return deptCache;
  const pool = await getListecPool();
  const r = await pool
    .request()
    .query<{ id: number; Code: string | null; Name: string | null }>(
      'SELECT id, Code, Name FROM dbo.tbl_med_department_master',
    );
  const map = emptyMap();
  for (const row of r.recordset) add(map, row.Code, row.Name, row.id);
  deptCache = map;
  return map;
}

/**
 * Load tbl_med_mcc_unit_master rows (client / collection centre codes → City /
 * State). Requires SELECT on this table — grant db_datareader to listec_ro or
 * a narrow SELECT grant if EXECUTE-only is insufficient.
 */
export async function loadMccGeoMap(): Promise<Map<string, MccGeoLookup>> {
  getRegionAliasesWatcher();
  if (mccGeoCache) return mccGeoCache;
  const pool = await getListecPool();
  const map = new Map<string, MccGeoLookup>();

  interface MccRow {
    MCCUnitCode: string | null;
    City: string | null;
    State: string | null;
  }

  let r;
  try {
    r = await pool.request().query<MccRow>(
      `SELECT 
          LTRIM(RTRIM(MCCUnitCode)) AS MCCUnitCode,
          City,
          State
       FROM dbo.tbl_med_mcc_unit_master
       WHERE MCCUnitCode IS NOT NULL 
         AND LTRIM(RTRIM(MCCUnitCode)) <> ''`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[listec] tbl_med_mcc_unit_master unreadable (${msg}) — grant SELECT to listec_ro or widen permissions. Region buckets disabled.`,
    );
    mccGeoCache = map;
    return map;
  }

  for (const row of r.recordset) {
    const codeUpper = String(row.MCCUnitCode ?? '')
      .trim()
      .toUpperCase();
    if (!codeUpper) continue;
    const c = normaliseCity(row.City);
    const st = normaliseState(row.State);
    map.set(codeUpper, {
      cityKey: c.key,
      cityLabel: c.label,
      stateKey: st.key,
      stateLabel: st.label,
    });
  }

  mccGeoCache = map;
  return map;
}

function lookup(map: CodeMap, value: string): number | null {
  const key = value.trim().toUpperCase();
  return map.byCodeUpper.get(key) ?? map.byNameUpper.get(key) ?? null;
}

export async function resolveBusinessUnitId(value: string): Promise<number | null> {
  const map = await loadBu();
  return lookup(map, value);
}

export async function resolveStatusId(value: string): Promise<number | null> {
  const map = await loadStatus();
  return lookup(map, value);
}

export async function resolveDepartmentId(value: string): Promise<number | null> {
  const map = await loadDept();
  return lookup(map, value);
}

/** Test/diagnostics — invalidate everything (e.g. if a master row is added). */
export function clearLookupCaches(): void {
  buCache = null;
  statusCache = null;
  deptCache = null;
  mccGeoCache = null;
}

/** For the /api/lookups debug endpoint. */
export async function dumpLookups(): Promise<{ businessUnits: string[]; statuses: string[]; departments: string[] }> {
  const [bu, st, dp] = await Promise.all([loadBu(), loadStatus(), loadDept()]);
  const keysOf = (m: CodeMap) => [...new Set([...m.byCodeUpper.keys(), ...m.byNameUpper.keys()])].sort();
  return {
    businessUnits: keysOf(bu),
    statuses: keysOf(st),
    departments: keysOf(dp),
  };
}

/**
 * State → City hierarchy with MCC-unit counts — for Tracer Region chip UI.
 * Keys match query params passed to `/api/worksheet-reports/packages`
 * bucketCities / bucketStates.
 */
export async function dumpRegionsHierarchy(): Promise<{ states: RegionStateNode[] }> {
  await loadMccGeoMap();
  const mcc = mccGeoCache;
  const stateMap = new Map<
    string,
    { label: string; mccCount: number; cities: Map<string, { label: string; mccCount: number }> }
  >();

  if (mcc) {
    for (const g of mcc.values()) {
      const sk = g.stateKey;
      if (!stateMap.has(sk)) {
        stateMap.set(sk, {
          label: g.stateLabel,
          mccCount: 0,
          cities: new Map(),
        });
      }
      const sn = stateMap.get(sk)!;
      sn.mccCount += 1;
      const ck = g.cityKey;
      if (!sn.cities.has(ck)) {
        sn.cities.set(ck, { label: g.cityLabel, mccCount: 0 });
      }
      const cn = sn.cities.get(ck)!;
      cn.mccCount += 1;
    }
  }

  const states: RegionStateNode[] = [];
  for (const [sk, sd] of stateMap) {
    const cities: RegionCityNode[] = [];
    for (const [ck, cd] of sd.cities) {
      cities.push({ key: ck, label: cd.label, mccCount: cd.mccCount });
    }
    cities.sort((a, b) => (b.mccCount !== a.mccCount ? b.mccCount - a.mccCount : a.label.localeCompare(b.label)));
    states.push({
      key: sk,
      label: sd.label,
      mccCount: sd.mccCount,
      cities,
    });
  }

  states.sort((a, b) => (b.mccCount !== a.mccCount ? b.mccCount - a.mccCount : a.label.localeCompare(b.label)));
  return { states };
}
