/**
 * Cached lookups that resolve human-friendly LIS codes to the numeric ids
 * the stored procedure expects. Each map is loaded lazily on first use and
 * kept in process memory until the API restarts.
 */

import sql from 'mssql';
import { getListecPool } from './listec.client';

interface CodeMap {
    byCodeUpper: Map<string, number>;
    byNameUpper: Map<string, number>;
}

let buCache: CodeMap | null = null;
let statusCache: CodeMap | null = null;
let deptCache: CodeMap | null = null;

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
