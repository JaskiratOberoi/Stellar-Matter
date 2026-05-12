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
  /**
   * Sorted, deduped list of MCCUnitCode values that contribute to this city.
   * Surfaced in the UI tooltip for human verification.
   */
  codes: string[];
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
let stateNamesCache: Map<number, string> | null = null;
let stateColsCache: McuColumnInfo[] | null = null;

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
 * Load `dbo.tbl_med_states` once and cache `id -> statename`. The MCC unit
 * master only stores `stateid INT` (FK) — no text state column — so every
 * geography lookup needs this map. Column names are auto-detected via
 * INFORMATION_SCHEMA so a future schema rename doesn't silently break us.
 */
const STATES_TABLE = 'tbl_med_states';

async function loadStateColumns(pool: sql.ConnectionPool): Promise<McuColumnInfo[]> {
  if (stateColsCache) return stateColsCache;
  const r = await pool
    .request()
    .input('table_name', sql.NVarChar(128), STATES_TABLE)
    .query<{ COLUMN_NAME: string; DATA_TYPE: string }>(
      `SELECT COLUMN_NAME, DATA_TYPE
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = @table_name`,
    );
  stateColsCache = r.recordset.map((c) => ({ name: c.COLUMN_NAME, type: c.DATA_TYPE }));
  return stateColsCache;
}

export async function loadStateNames(): Promise<Map<number, string>> {
  if (stateNamesCache) return stateNamesCache;
  const pool = await getListecPool();
  let cols: McuColumnInfo[];
  try {
    cols = await loadStateColumns(pool);
  } catch (e) {
    console.warn(
      `[listec] ${STATES_TABLE} introspection failed (${e instanceof Error ? e.message : String(e)}) — state names unavailable.`,
    );
    stateNamesCache = new Map();
    return stateNamesCache;
  }
  const idCol = pickColumn(cols, ['id', 'stateid', 'StateId', 'state_id']);
  const nameCol = pickColumn(cols, ['statename', 'state_name', 'State', 'state', 'Name', 'name']);
  if (!idCol || !nameCol) {
    console.warn(
      `[listec] ${STATES_TABLE} missing id/name columns (id=${idCol}, name=${nameCol}) — state names unavailable.`,
    );
    stateNamesCache = new Map();
    return stateNamesCache;
  }
  try {
    const r = await pool.request().query<{ id: number | null; nm: string | null }>(
      `SELECT ${idCol} AS id, ${nameCol} AS nm FROM dbo.${STATES_TABLE}`,
    );
    const map = new Map<number, string>();
    for (const row of r.recordset) {
      if (row.id == null || row.nm == null) continue;
      const trimmed = String(row.nm).trim();
      if (!trimmed) continue;
      map.set(Number(row.id), trimmed);
    }
    stateNamesCache = map;
    return map;
  } catch (e) {
    console.warn(
      `[listec] ${STATES_TABLE} read failed (${e instanceof Error ? e.message : String(e)}) — state names unavailable.`,
    );
    stateNamesCache = new Map();
    return stateNamesCache;
  }
}

/**
 * Load tbl_med_mcc_unit_master rows (client / collection centre codes -> City /
 * State). Joins `dbo.tbl_med_states` on `stateid` because the master table
 * only stores the FK, not a text state column. The state name column is
 * detected at runtime so installations using a different casing/name still
 * work.
 */
export async function loadMccGeoMap(): Promise<Map<string, MccGeoLookup>> {
  getRegionAliasesWatcher();
  if (mccGeoCache) return mccGeoCache;
  const pool = await getListecPool();
  const map = new Map<string, MccGeoLookup>();

  let stateCols: McuColumnInfo[] = [];
  try {
    stateCols = await loadStateColumns(pool);
  } catch {
    // best-effort — handled below by fallback to NULL state name
  }
  const stateIdColInStates = pickColumn(stateCols, ['id', 'stateid', 'StateId', 'state_id']);
  const stateNameColInStates = pickColumn(stateCols, [
    'statename',
    'state_name',
    'State',
    'state',
    'Name',
    'name',
  ]);
  const haveStatesJoin = Boolean(stateIdColInStates && stateNameColInStates);
  const stateSelectExpr = haveStatesJoin
    ? `S.${stateNameColInStates}`
    : `CAST(NULL AS NVARCHAR(255))`;
  const stateJoinClause = haveStatesJoin
    ? `LEFT JOIN dbo.${STATES_TABLE} S ON S.${stateIdColInStates} = U.stateid`
    : '';

  interface MccRow {
    MCCUnitCode: string | null;
    City: string | null;
    StateName: string | null;
  }

  let r;
  try {
    r = await pool.request().query<MccRow>(
      `SELECT
          LTRIM(RTRIM(U.MCCUnitCode)) AS MCCUnitCode,
          U.city                        AS City,
          ${stateSelectExpr}            AS StateName
       FROM dbo.tbl_med_mcc_unit_master U
       ${stateJoinClause}
       WHERE U.MCCUnitCode IS NOT NULL
         AND LTRIM(RTRIM(U.MCCUnitCode)) <> ''`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[listec] mcc-geo JOIN failed (${msg}) — region buckets disabled.`,
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
    const st = normaliseState(row.StateName);
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
  mcuColumnsCache = null;
  stateNamesCache = null;
  stateColsCache = null;
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
 * Full row from tbl_med_mcc_unit_master with normalised geography, suitable
 * for the Postgres `client_locations` mirror in api-matter (db-1). Column
 * coverage is best-effort: we introspect INFORMATION_SCHEMA so installations
 * with extra/missing columns don't break the dump.
 */
export interface McuDumpRow {
  code: string;
  name: string | null;
  businessUnitCode: string | null;
  businessUnitName: string | null;
  cityRaw: string | null;
  cityKey: string;
  cityLabel: string;
  stateRaw: string | null;
  stateKey: string;
  stateLabel: string;
  mobile: string | null;
  rateLabel: string | null;
  reportFlag: string | null;
  subCodes: string | null;
}

const MCU_TABLE = 'tbl_med_mcc_unit_master';

interface McuColumnInfo {
  name: string;
  type: string;
}

let mcuColumnsCache: McuColumnInfo[] | null = null;

async function loadMcuColumns(pool: sql.ConnectionPool): Promise<McuColumnInfo[]> {
  if (mcuColumnsCache) return mcuColumnsCache;
  const r = await pool
    .request()
    .input('table_name', sql.NVarChar(128), MCU_TABLE)
    .query<{ COLUMN_NAME: string; DATA_TYPE: string }>(
      `SELECT COLUMN_NAME, DATA_TYPE
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = @table_name`,
    );
  mcuColumnsCache = r.recordset.map((c) => ({ name: c.COLUMN_NAME, type: c.DATA_TYPE }));
  return mcuColumnsCache;
}

/** First column whose name (case-insensitive) matches any of the candidates. */
function pickColumn(columns: McuColumnInfo[], candidates: string[]): string | null {
  const upper = new Map(columns.map((c) => [c.name.toUpperCase(), c.name]));
  for (const cand of candidates) {
    const hit = upper.get(cand.toUpperCase());
    if (hit) return hit;
  }
  return null;
}

/**
 * Dump every MCC unit with normalised geography. Used by api-matter's sync
 * job to materialise a Postgres `client_locations` mirror. Keep the response
 * SELECT-only and stable enough for hash-based change detection on the
 * caller side.
 */
export async function dumpMccUnits(): Promise<McuDumpRow[]> {
  const pool = await getListecPool();
  const cols = await loadMcuColumns(pool);
  if (cols.length === 0) {
    return [];
  }

  const codeCol = pickColumn(cols, ['MCCUnitCode']);
  if (!codeCol) {
    throw new Error(
      `${MCU_TABLE} is missing the MCCUnitCode column — schema unexpected, refusing to dump.`,
    );
  }
  const nameCol = pickColumn(cols, ['MCCUnitName', 'Name']);
  const cityCol = pickColumn(cols, ['City']);
  const stateCol = pickColumn(cols, ['State']);
  const stateIdCol = pickColumn(cols, ['stateid', 'StateId', 'state_id']);
  const mobileCol = pickColumn(cols, ['Mobile', 'MobileNo', 'Phone', 'PhoneNo']);
  const rateCol = pickColumn(cols, ['RateListName', 'RateList', 'Rate']);
  const reportCol = pickColumn(cols, ['Report', 'ReportFlag', 'ReportType']);
  const subCodesCol = pickColumn(cols, ['SubCodes', 'SubCode', 'FranchiseCodes']);
  const buIdCol = pickColumn(cols, ['BusinessUnitId', 'business_unit_id']);

  // Resolve state name through dbo.tbl_med_states when the master table only
  // exposes `stateid INT` (the common case in Noble) — the legacy `State`
  // text column doesn't exist there.
  let stateNameColInStates: string | null = null;
  let stateIdColInStates: string | null = null;
  if (!stateCol && stateIdCol) {
    try {
      const stateCols = await loadStateColumns(pool);
      stateIdColInStates = pickColumn(stateCols, ['id', 'stateid', 'StateId', 'state_id']);
      stateNameColInStates = pickColumn(stateCols, [
        'statename',
        'state_name',
        'State',
        'state',
        'Name',
        'name',
      ]);
    } catch (e) {
      console.warn(
        `[listec] dumpMccUnits: ${STATES_TABLE} introspection failed (${e instanceof Error ? e.message : String(e)}) — state_raw will be NULL.`,
      );
    }
  }
  const useStatesJoin = !stateCol && Boolean(stateIdCol && stateIdColInStates && stateNameColInStates);

  const stateSelectExpr = stateCol
    ? `U.${stateCol}`
    : useStatesJoin
      ? `S.${stateNameColInStates}`
      : `CAST(NULL AS NVARCHAR(255))`;

  const selectParts: string[] = [
    `LTRIM(RTRIM(U.${codeCol})) AS code`,
    nameCol ? `U.${nameCol} AS name` : `CAST(NULL AS NVARCHAR(255)) AS name`,
    cityCol ? `U.${cityCol} AS city_raw` : `CAST(NULL AS NVARCHAR(255)) AS city_raw`,
    `${stateSelectExpr} AS state_raw`,
    mobileCol ? `U.${mobileCol} AS mobile` : `CAST(NULL AS NVARCHAR(255)) AS mobile`,
    rateCol ? `U.${rateCol} AS rate_label` : `CAST(NULL AS NVARCHAR(255)) AS rate_label`,
    reportCol ? `U.${reportCol} AS report_flag` : `CAST(NULL AS NVARCHAR(255)) AS report_flag`,
    subCodesCol ? `U.${subCodesCol} AS sub_codes` : `CAST(NULL AS NVARCHAR(MAX)) AS sub_codes`,
    buIdCol ? `BU.BusinessUnitCode AS bu_code` : `CAST(NULL AS NVARCHAR(255)) AS bu_code`,
    buIdCol ? `BU.BusinessUnitName AS bu_name` : `CAST(NULL AS NVARCHAR(255)) AS bu_name`,
  ];

  const buJoinClause = buIdCol
    ? `LEFT JOIN dbo.tbl_med_business_unit_master BU ON BU.id = U.${buIdCol}`
    : '';
  const stateJoinClause = useStatesJoin
    ? `LEFT JOIN dbo.${STATES_TABLE} S ON S.${stateIdColInStates} = U.${stateIdCol}`
    : '';

  const query = `
    SELECT ${selectParts.join(', ')}
    FROM dbo.${MCU_TABLE} U
    ${buJoinClause}
    ${stateJoinClause}
    WHERE U.${codeCol} IS NOT NULL
      AND LTRIM(RTRIM(U.${codeCol})) <> ''
  `;

  interface RawRow {
    code: string;
    name: string | null;
    city_raw: string | null;
    state_raw: string | null;
    mobile: string | null;
    rate_label: string | null;
    report_flag: string | null;
    sub_codes: string | null;
    bu_code: string | null;
    bu_name: string | null;
  }

  const r = await pool.request().query<RawRow>(query);
  const out: McuDumpRow[] = [];
  for (const row of r.recordset) {
    const codeUpper = String(row.code ?? '').trim().toUpperCase();
    if (!codeUpper) continue;
    const c = normaliseCity(row.city_raw);
    const st = normaliseState(row.state_raw);
    out.push({
      code: codeUpper,
      name: row.name == null ? null : String(row.name).trim() || null,
      businessUnitCode: row.bu_code == null ? null : String(row.bu_code).trim() || null,
      businessUnitName: row.bu_name == null ? null : String(row.bu_name).trim() || null,
      cityRaw: row.city_raw == null ? null : String(row.city_raw).trim() || null,
      cityKey: c.key,
      cityLabel: c.label,
      stateRaw: row.state_raw == null ? null : String(row.state_raw).trim() || null,
      stateKey: st.key,
      stateLabel: st.label,
      mobile: row.mobile == null ? null : String(row.mobile).trim() || null,
      rateLabel: row.rate_label == null ? null : String(row.rate_label).trim() || null,
      reportFlag: row.report_flag == null ? null : String(row.report_flag).trim() || null,
      subCodes: row.sub_codes == null ? null : String(row.sub_codes).trim() || null,
    });
  }
  return out;
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
    { label: string; mccCount: number; cities: Map<string, { label: string; mccCount: number; codes: Set<string> }> }
  >();

  if (mcc) {
    for (const [code, g] of mcc) {
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
        sn.cities.set(ck, { label: g.cityLabel, mccCount: 0, codes: new Set() });
      }
      const cn = sn.cities.get(ck)!;
      cn.mccCount += 1;
      cn.codes.add(code);
    }
  }

  const states: RegionStateNode[] = [];
  for (const [sk, sd] of stateMap) {
    const cities: RegionCityNode[] = [];
    for (const [ck, cd] of sd.cities) {
      cities.push({
        key: ck,
        label: cd.label,
        mccCount: cd.mccCount,
        codes: [...cd.codes].sort(),
      });
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
