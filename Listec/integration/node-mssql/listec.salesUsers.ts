/**
 * Tracer: "Sales and Marketing" users → MCC client codes (User Client Mapping in LIS).
 *
 * The checked-in `Listec/docs/noble-schema/Noble DB schema.sql` may only contain
 * CREATE DATABASE lines on some installations — this module discovers the actual
 * Noble layout at runtime via sys.foreign_keys + INFORMATION_SCHEMA (same idea as
 * listec.lookups.ts / dumpMccUnits).
 *
 * Canonical user-type label: "Sales and Marketing" (case-insensitive match on the
 * type-master name column).
 */

import sql from 'mssql';
import { getListecPool } from './listec.client';

const SALES_TYPE_PHRASE = 'sales and marketing';
const MAX_CODES_RETURN = 5000;

export interface SalesMarketingUserRow {
  userId: number;
  /** Display label for Tracer chips (First + Last, else UserName, else id). */
  label: string;
  /** Count of distinct MCC unit codes mapped in LIS (for UI badge). */
  codeCount: number;
}

let cachedSchema: SalesSchemaResolved | null = null;

/** Resolved dbo tables/columns for Sales & Marketing → MCC mapping (see `inspect-sales-mapping.ts`). */
export interface SalesSchemaResolved {
  userTable: string;
  userPk: string;
  userTypeFkCol: string | null;
  typeTable: string | null;
  typePk: string | null;
  typeNameCol: string | null;
  /** When user table stores type as raw string with no FK */
  userTypeInlineCol: string | null;
  firstNameCol: string | null;
  lastNameCol: string | null;
  userNameCol: string | null;
  mapTable: string;
  mapUserCol: string;
  mapMccUnitIdCol: string;
  mccTable: string;
  mccPk: string;
  mccCodeCol: string;
}

interface ColRow {
  COLUMN_NAME: string;
  DATA_TYPE: string;
}

function pickColumn(cols: ColRow[], candidates: string[]): string | null {
  const upper = new Map(cols.map((c) => [c.COLUMN_NAME.toUpperCase(), c.COLUMN_NAME]));
  for (const cand of candidates) {
    const hit = upper.get(cand.toUpperCase());
    if (hit) return hit;
  }
  return null;
}

async function loadColumns(pool: sql.ConnectionPool, table: string): Promise<ColRow[]> {
  const r = await pool
    .request()
    .input('tn', sql.NVarChar(128), table)
    .query<ColRow>(
      `SELECT COLUMN_NAME, DATA_TYPE
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = @tn`,
    );
  return r.recordset || [];
}

/** One row per dbo foreign-key column (parent → referenced). */
export interface SalesFkEdge {
  parentTable: string;
  parentCol: string;
  refTable: string;
  refCol: string;
}

export async function loadDboForeignKeys(pool: sql.ConnectionPool): Promise<SalesFkEdge[]> {
  const r = await pool.request().query<{
    parent_table: string;
    parent_col: string;
    ref_table: string;
    ref_col: string;
  }>(`
    SELECT
      OBJECT_SCHEMA_NAME(fk.parent_object_id) + '.' + OBJECT_NAME(fk.parent_object_id) AS parent_full,
      cp.name AS parent_table,
      cp_col.name AS parent_col,
      cr.name AS ref_table,
      cr_col.name AS ref_col
    FROM sys.foreign_keys fk
    INNER JOIN sys.foreign_key_columns fkc
      ON fkc.constraint_object_id = fk.object_id
    INNER JOIN sys.tables cp ON fk.parent_object_id = cp.object_id
    INNER JOIN sys.columns cp_col
      ON cp_col.object_id = fk.parent_object_id AND cp_col.column_id = fkc.parent_column_id
    INNER JOIN sys.tables cr ON fk.referenced_object_id = cr.object_id
    INNER JOIN sys.columns cr_col
      ON cr_col.object_id = fk.referenced_object_id AND cr_col.column_id = fkc.referenced_column_id
    WHERE SCHEMA_NAME(cp.schema_id) = 'dbo' AND SCHEMA_NAME(cr.schema_id) = 'dbo'
  `);
  const out: SalesFkEdge[] = [];
  for (const row of r.recordset || []) {
    out.push({
      parentTable: String(row.parent_table),
      parentCol: String(row.parent_col),
      refTable: String(row.ref_table),
      refCol: String(row.ref_col),
    });
  }
  return out;
}

function resolveFromEnv(): SalesSchemaResolved | null {
  const mapTable = process.env.LISTEC_SALES_MAP_TABLE?.trim();
  const mapUserCol = process.env.LISTEC_SALES_MAP_USER_COL?.trim();
  const mapMccCol = process.env.LISTEC_SALES_MAP_MCC_COL?.trim();
  const userTable = process.env.LISTEC_SALES_USER_TABLE?.trim();
  const userPk = process.env.LISTEC_SALES_USER_PK?.trim();
  const mccTable = process.env.LISTEC_SALES_MCC_TABLE?.trim() || 'tbl_med_mcc_unit_master';
  const mccPk = process.env.LISTEC_SALES_MCC_PK?.trim();
  const mccCodeCol = process.env.LISTEC_SALES_MCC_CODE_COL?.trim() || 'MCCUnitCode';
  if (mapTable && mapUserCol && mapMccCol && userTable && userPk) {
    return {
      userTable,
      userPk,
      userTypeFkCol: process.env.LISTEC_SALES_USER_TYPE_FK_COL?.trim() || null,
      typeTable: process.env.LISTEC_SALES_TYPE_TABLE?.trim() || null,
      typePk: process.env.LISTEC_SALES_TYPE_PK?.trim() || null,
      typeNameCol: process.env.LISTEC_SALES_TYPE_NAME_COL?.trim() || null,
      userTypeInlineCol: process.env.LISTEC_SALES_USER_TYPE_INLINE_COL?.trim() || null,
      firstNameCol: process.env.LISTEC_SALES_FIRST_NAME_COL?.trim() || null,
      lastNameCol: process.env.LISTEC_SALES_LAST_NAME_COL?.trim() || null,
      userNameCol: process.env.LISTEC_SALES_USER_NAME_COL?.trim() || null,
      mapTable,
      mapUserCol,
      mapMccUnitIdCol: mapMccCol,
      mccTable,
      mccPk: mccPk || 'id',
      mccCodeCol,
    };
  }
  return null;
}

async function discoverSchema(pool: sql.ConnectionPool): Promise<SalesSchemaResolved> {
  const fromEnv = resolveFromEnv();
  if (fromEnv) return fromEnv;

  const fks = await loadDboForeignKeys(pool);
  const mccTable = 'tbl_med_mcc_unit_master';
  const mccCols = await loadColumns(pool, mccTable);
  const mccPk =
    pickColumn(mccCols, ['id', 'ID', 'Id', 'MccUnitId', 'MCCUnitId']) ||
    (() => {
      throw new Error(`[listec.salesUsers] Could not resolve PK on ${mccTable}`);
    })();
  const mccCodeCol = pickColumn(mccCols, ['MCCUnitCode', 'MccUnitCode']);
  if (!mccCodeCol) {
    throw new Error(`[listec.salesUsers] ${mccTable} missing MCCUnitCode`);
  }

  // Mapping rows: parent table references mccTable
  const toMcc = fks.filter((e) => e.refTable === mccTable);
  const mapCandidates = [...new Set(toMcc.map((e) => e.parentTable))];

  /** User-type master tables are keyed from the real user row — never treat them as the "user" table. */
  function isUserTypeLookupTable(table: string): boolean {
    const t = table.toLowerCase();
    if (t === 'tbl_med_usertypes') return true;
    if (t.includes('usertype') && !t.includes('user_master')) return true;
    return false;
  }

  function scoreMccColumnName(col: string): number {
    const c = col.toUpperCase();
    if (c.includes('MCC_CODE') || c === 'MCCCODE' || c.includes('MCCID')) return 8;
    if (c.includes('MCC') || c.includes('PCC')) return 4;
    return 0;
  }

  /** @type {{ mapTable: string; userTable: string; mapUserCol: string; mapMccCol: string; userPk: string; score: number } | null} */
  let best: {
    mapTable: string;
    userTable: string;
    mapUserCol: string;
    mapMccCol: string;
    userPk: string;
    score: number;
  } | null = null;

  // Pass 1 — prefer true junction tables: map row → tbl_*user_master* + MCC
  const userMasterRe = /user_master/i;
  for (const mapTableName of mapCandidates) {
    const towardMccEdges = toMcc.filter((e) => e.parentTable === mapTableName);
    const toUserMasterEdges = fks.filter(
      (e) => e.parentTable === mapTableName && userMasterRe.test(e.refTable) && e.refTable !== mccTable,
    );
    for (const ue of toUserMasterEdges) {
      const ut = ue.refTable;
      const ucols = await loadColumns(pool, ut);
      const pkGuess =
        pickColumn(ucols, ['id', 'ID', 'MccUserId', 'UserId', 'User_Id', 'MCUUserId', 'McuUserId']) ||
        null;
      if (!pkGuess) continue;
      for (const mccEdge of towardMccEdges) {
        const mapUpper = mapTableName.toUpperCase();
        let score = 80;
        score += mapUpper.includes('MAPPING') || mapUpper.includes('_MAP') ? 25 : 0;
        score += mapUpper.includes('SALES') && mapUpper.includes('MCC') ? 15 : 0;
        score += scoreMccColumnName(mccEdge.parentCol);
        const picked = {
          mapTable: mapTableName,
          userTable: ut,
          mapUserCol: ue.parentCol,
          mapMccCol: mccEdge.parentCol,
          userPk: pkGuess,
          score,
        };
        if (!best || picked.score > best.score) best = picked;
      }
    }
  }

  // Pass 2 — legacy heuristic (e.g. odd schemas); never pick usertypes as the human user table
  for (const mapTableName of mapCandidates) {
    const towardMccEdges = toMcc.filter((e) => e.parentTable === mapTableName);
    for (const towardMcc of towardMccEdges) {
      const fromMap = fks.filter((e) => e.parentTable === mapTableName && e.refTable !== mccTable);
      for (const edge of fromMap) {
        const ut = edge.refTable;
        if (ut === mccTable || isUserTypeLookupTable(ut)) continue;
        const ucols = await loadColumns(pool, ut);
        const pkGuess =
          pickColumn(ucols, ['id', 'ID', 'MccUserId', 'UserId', 'User_Id', 'MCUUserId', 'McuUserId']) ||
          null;
        if (!pkGuess) continue;
        const utUpper = ut.toUpperCase();
        const score =
          (utUpper.includes('USER') ? 2 : 0) +
          (utUpper.includes('MCU') || utUpper.includes('MCC') ? 2 : 0) +
          (utUpper.includes('MAP') ? -1 : 0) +
          scoreMccColumnName(towardMcc.parentCol);
        const picked = {
          mapTable: mapTableName,
          userTable: ut,
          mapUserCol: edge.parentCol,
          mapMccCol: towardMcc.parentCol,
          userPk: pkGuess,
          score,
        };
        if (!best || picked.score > best.score) best = picked;
      }
    }
  }

  if (!best) {
    throw new Error(
      `[listec.salesUsers] Could not discover user↔MCC mapping: no FK path dbo.* → ${mccTable}. ` +
        `Set LISTEC_SALES_MAP_TABLE, LISTEC_SALES_MAP_USER_COL, LISTEC_SALES_MAP_MCC_COL, LISTEC_SALES_USER_TABLE, LISTEC_SALES_USER_PK.`,
    );
  }

  const { mapTable, userTable, mapUserCol, mapMccCol, userPk } = best;
  const userCols = await loadColumns(pool, userTable);
  const firstNameCol = pickColumn(userCols, ['FirstName', 'FName', 'First_Name']);
  const lastNameCol = pickColumn(userCols, ['LastName', 'LName', 'Last_Name']);
  const userNameCol = pickColumn(userCols, ['UserName', 'Username', 'LoginName', 'Login_Id', 'User_Id_Name']);

  const userTypeFkCol = pickColumn(userCols, [
    'UserTypeId',
    'UsertypeId',
    'usertypeid',
    'User_Type_Id',
    'TypeId',
    'UserType_ID',
    'FK_UserTypeId',
    'Usertype_ID',
  ]);
  let typeTable: string | null = null;
  let typePk: string | null = null;
  let typeNameCol: string | null = null;
  let userTypeInlineCol: string | null = null;

  if (userTypeFkCol) {
    const fkType = fks.find((e) => e.parentTable === userTable && e.parentCol === userTypeFkCol);
    if (fkType) {
      typeTable = fkType.refTable;
      typePk = fkType.refCol;
      const tcols = await loadColumns(pool, typeTable);
      typeNameCol = pickColumn(tcols, [
        'UserType',
        'Usertype',
        'Name',
        'TypeName',
        'User_Type_Name',
        'Description',
        'Type',
        'Title',
        'Label',
        'User_Type',
      ]);
    }
  } else {
    userTypeInlineCol = pickColumn(userCols, [
      'UserType',
      'Usertype',
      'User_Type',
      'TypeName',
      'Designation',
      'Department',
      'DepartmentName',
      'DeptName',
      'EmpDesignation',
    ]);
  }

  return {
    userTable,
    userPk,
    userTypeFkCol,
    typeTable,
    typePk,
    typeNameCol,
    userTypeInlineCol,
    firstNameCol,
    lastNameCol,
    userNameCol,
    mapTable,
    mapUserCol,
    mapMccUnitIdCol: mapMccCol,
    mccTable,
    mccPk,
    mccCodeCol,
  };
}

async function getSchema(pool: sql.ConnectionPool): Promise<SalesSchemaResolved> {
  if (cachedSchema) return cachedSchema;
  cachedSchema = await discoverSchema(pool);
  return cachedSchema;
}

function labelExpr(s: SalesSchemaResolved): string {
  const parts: string[] = [];
  if (s.firstNameCol) parts.push(`LTRIM(RTRIM(CAST(U.${s.firstNameCol} AS NVARCHAR(200))))`);
  if (s.lastNameCol) parts.push(`LTRIM(RTRIM(CAST(U.${s.lastNameCol} AS NVARCHAR(200))))`);
  let nameConcat = 'NULL';
  if (parts.length === 1) {
    nameConcat = `NULLIF(LTRIM(RTRIM(${parts[0]})), N'')`;
  } else if (parts.length >= 2) {
    nameConcat = `NULLIF(LTRIM(RTRIM(${parts[0]} + N' ' + ${parts[1]})), N'')`;
  }
  const userPart = s.userNameCol ? `LTRIM(RTRIM(CAST(U.${s.userNameCol} AS NVARCHAR(200))))` : `NULL`;
  return `COALESCE(${nameConcat}, ${userPart}, CAST(U.${s.userPk} AS NVARCHAR(50)))`;
}

function salesTypeFilterSql(s: SalesSchemaResolved): string {
  if (s.userTypeInlineCol) {
    return `LOWER(LTRIM(RTRIM(CAST(U.${s.userTypeInlineCol} AS NVARCHAR(255))))) = @salesPhrase`;
  }
  if (s.userTypeFkCol && s.typeTable && s.typePk && s.typeNameCol) {
    return `LOWER(LTRIM(RTRIM(CAST(T.${s.typeNameCol} AS NVARCHAR(255))))) = @salesPhrase`;
  }
  throw new Error(
    '[listec.salesUsers] User table has no UserTypeId FK and no inline UserType — cannot filter Sales and Marketing. Set LISTEC_SALES_* env overrides.',
  );
}

function typeJoinSql(s: SalesSchemaResolved): string {
  if (s.userTypeInlineCol) return '';
  if (s.userTypeFkCol && s.typeTable && s.typePk) {
    return `INNER JOIN dbo.${s.typeTable} T ON T.${s.typePk} = U.${s.userTypeFkCol}`;
  }
  return '';
}

/**
 * All users whose type matches "Sales and Marketing", with mapped code counts.
 */
export async function listSalesMarketingUsers(): Promise<SalesMarketingUserRow[]> {
  const pool = await getListecPool();
  const s = await getSchema(pool);

  const labelSql = labelExpr(s);
  const typeJoin = typeJoinSql(s);
  const typeFilter = salesTypeFilterSql(s);

  const q = `
    SELECT
      CAST(U.${s.userPk} AS INT) AS userId,
      MIN(${labelSql}) AS label,
      COUNT(DISTINCT LTRIM(RTRIM(UPPER(CAST(M.${s.mccCodeCol} AS NVARCHAR(50)))))) AS codeCount
    FROM dbo.${s.userTable} U
    ${typeJoin}
    INNER JOIN dbo.${s.mapTable} MAP ON MAP.${s.mapUserCol} = U.${s.userPk}
    INNER JOIN dbo.${s.mccTable} M ON M.${s.mccPk} = MAP.${s.mapMccUnitIdCol}
    WHERE M.${s.mccCodeCol} IS NOT NULL AND LTRIM(RTRIM(CAST(M.${s.mccCodeCol} AS NVARCHAR(50)))) <> ''
      AND (${typeFilter})
    GROUP BY U.${s.userPk}
    ORDER BY MIN(${labelSql})
  `;

  const r = await pool
    .request()
    .input('salesPhrase', sql.NVarChar(100), SALES_TYPE_PHRASE)
    .query<{ userId: number; label: string; codeCount: number }>(q);
  const out: SalesMarketingUserRow[] = [];
  for (const row of r.recordset || []) {
    const uid = Number(row.userId);
    if (!Number.isFinite(uid)) continue;
    out.push({
      userId: uid,
      label: String(row.label || uid).trim() || String(uid),
      codeCount: Math.max(0, Math.floor(Number(row.codeCount) || 0)),
    });
  }
  return out;
}

/**
 * MCC client codes for one or more user ids (User Client Mapping).
 */
export async function listClientCodesForUsers(userIds: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  const unique = [...new Set(userIds.map((n) => Math.floor(Number(n))).filter((n) => Number.isFinite(n)))];
  for (const id of unique) out.set(id, []);
  if (unique.length === 0) return out;

  const pool = await getListecPool();
  const s = await getSchema(pool);

  const typeJoin = typeJoinSql(s);
  const typeFilter = salesTypeFilterSql(s);

  // TVP-style IN clause (bounded)
  if (unique.length > 2000) {
    throw new Error(`[listec.salesUsers] Too many user ids (${unique.length}), max 2000 per request.`);
  }
  const placeholders = unique.map((_, i) => `@u${i}`).join(', ');
  const req = pool.request();
  unique.forEach((id, i) => {
    req.input(`u${i}`, sql.Int, id);
  });
  req.input('salesPhrase', sql.NVarChar(100), SALES_TYPE_PHRASE);

  const q = `
    SELECT CAST(U.${s.userPk} AS INT) AS userId,
           LTRIM(RTRIM(UPPER(CAST(M.${s.mccCodeCol} AS NVARCHAR(50))))) AS code
    FROM dbo.${s.userTable} U
    ${typeJoin}
    INNER JOIN dbo.${s.mapTable} MAP ON MAP.${s.mapUserCol} = U.${s.userPk}
    INNER JOIN dbo.${s.mccTable} M ON M.${s.mccPk} = MAP.${s.mapMccUnitIdCol}
    WHERE U.${s.userPk} IN (${placeholders})
      AND M.${s.mccCodeCol} IS NOT NULL AND LTRIM(RTRIM(CAST(M.${s.mccCodeCol} AS NVARCHAR(50)))) <> ''
      AND (${typeFilter})
  `;

  const r = await req.query<{ userId: number; code: string }>(q);
  for (const row of r.recordset || []) {
    const uid = Math.floor(Number(row.userId));
    const code = String(row.code || '').trim();
    if (!Number.isFinite(uid) || !code) continue;
    const arr = out.get(uid);
    if (!arr) continue;
    if (!arr.includes(code)) {
      arr.push(code);
      if (arr.length > MAX_CODES_RETURN) {
        throw new Error(`[listec.salesUsers] User ${uid} exceeds ${MAX_CODES_RETURN} mapped codes.`);
      }
    }
  }
  for (const arr of out.values()) arr.sort();
  return out;
}

export function invalidateSalesSchemaCache(): void {
  cachedSchema = null;
}

/**
 * LISTEC_SALES_* override from env when the five required keys are set (see `.env.example`).
 */
export function readSalesSchemaFromEnv(): SalesSchemaResolved | null {
  return resolveFromEnv();
}

/**
 * Clears the cached schema and re-runs FK/column discovery — for `npm run inspect:sales` only.
 */
export async function forceDiscoverSalesSchema(
  pool: sql.ConnectionPool,
): Promise<SalesSchemaResolved> {
  invalidateSalesSchemaCache();
  return discoverSchema(pool);
}
