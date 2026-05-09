/**
 * Aggregate SP rows into the bracket-label shape lis-nav-bot's package
 * dashboard expects. Mirrors the algorithm in
 * scripts/lis-nav-bot/lib/packages.js so the SQL data source can produce
 * a drop-in result for the existing UI.
 */

import type { WorksheetReportRow } from './listec.types';

export interface PackagesAggregate {
    rowCount: number;
    rowsWithBrackets: number;
    otherTestsRowCount: number;
    uniqueLabelCount: number;
    labelOccurrences: Record<string, number>;
    labelToSids: Record<string, string[]>;
    sids: string[];
    rows: { sid: string; testNamesText: string }[];
    /**
     * Tracer-only opt-in. When `bucketCodes` is passed, we walk each row's
     * `results` array and bucket SIDs / result-row counts by test_code. This
     * lets the Tracer pipeline derive every specialty mode (urine / EDTA /
     * citrate / S.Hep / L.Hep) from a single SP execution per BU instead of
     * one SP execution per (mode × test_code) combination.
     *
     * Match is case-insensitive on `test_code`. SID dedupe is per-bucket.
     * `resultRowsByTestCode` counts the raw result rows (not SIDs) — same
     * semantics as the legacy `byTestCode[code].rows` field that the tile
     * renderer uses for the breakdown table.
     */
    sidsByTestCode?: Record<string, string[]>;
    resultRowsByTestCode?: Record<string, number>;
    /** Tracer regions — bucket keys match `bucketCities` / `bucketStates` param values (upper, underscore-normalised city/state keys). */
    sidsByCity?: Record<string, string[]>;
    sidsByState?: Record<string, string[]>;
    resultRowsByCity?: Record<string, number>;
    resultRowsByState?: Record<string, number>;
}

export interface AggregateOptions {
    /**
     * If set, the result includes `sidsByTestCode` + `resultRowsByTestCode`
     * keyed by these (lowercased) codes. Codes that match nothing in the
     * window still appear with empty bucket so the caller can rely on the
     * shape regardless of data presence.
     */
    bucketCodes?: string[];
    /** Normalised city keys (same as `/api/regions` city.key). Requires `mccGeoLookup`. */
    bucketCities?: string[];
    bucketStates?: string[];
    /** MCCUnitCode (uppercase) → geography from tbl_med_mcc_unit_master */
    mccGeoLookup?: Map<string, { cityKey: string; stateKey: string }>;
}

const BRACKET_RE = /\[([^\]]+)\]/g;

function normaliseLabel(raw: string): string {
    return raw.replace(/\s+/g, ' ').trim();
}

function countBrackets(text: string): Record<string, number> {
    const out: Record<string, number> = {};
    BRACKET_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BRACKET_RE.exec(text)) !== null) {
        const label = normaliseLabel(m[1] ?? '');
        if (!label) continue;
        out[label] = (out[label] ?? 0) + 1;
    }
    return out;
}

function uniqueLabels(text: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    BRACKET_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BRACKET_RE.exec(text)) !== null) {
        const label = normaliseLabel(m[1] ?? '');
        if (!label || seen.has(label)) continue;
        seen.add(label);
        out.push(label);
    }
    return out;
}

export function aggregatePackages(
    rawRows: WorksheetReportRow[],
    opts: AggregateOptions = {},
): PackagesAggregate {
    const rows = rawRows.map((r) => ({
        sid: String(r.sid ?? '').trim(),
        testNamesText: r.test_names_csv ?? '',
    }));

    const labelOccurrences: Record<string, number> = {};
    const labelToSids: Record<string, Set<string>> = {};
    const sidSet = new Set<string>();
    let rowsWithBrackets = 0;
    let otherTestsRowCount = 0;

    for (const row of rows) {
        if (row.sid) sidSet.add(row.sid);
        const counts = countBrackets(row.testNamesText);
        const labels = Object.keys(counts);
        if (labels.length === 0) {
            otherTestsRowCount++;
            continue;
        }
        rowsWithBrackets++;
        for (const [label, c] of Object.entries(counts)) {
            labelOccurrences[label] = (labelOccurrences[label] ?? 0) + c;
        }
        if (!row.sid) continue;
        for (const label of uniqueLabels(row.testNamesText)) {
            if (!labelToSids[label]) labelToSids[label] = new Set();
            labelToSids[label].add(row.sid);
        }
    }

    const labelToSidsOut: Record<string, string[]> = {};
    for (const [label, set] of Object.entries(labelToSids)) {
        labelToSidsOut[label] = [...set].sort();
    }

    const out: PackagesAggregate = {
        rowCount: rows.length,
        rowsWithBrackets,
        otherTestsRowCount,
        uniqueLabelCount: Object.keys(labelOccurrences).length,
        labelOccurrences,
        labelToSids: labelToSidsOut,
        sids: [...sidSet].sort(),
        rows,
    };

    if (opts.bucketCodes && opts.bucketCodes.length > 0) {
        // Pre-seed every requested code so the response shape is stable even
        // when a code has zero hits in the window. Lowercase normalisation
        // mirrors how SQL Server's collation typically compares these codes
        // (case-insensitive) and keeps the caller's key lookup predictable.
        const wanted = new Set(opts.bucketCodes.map((c) => String(c || '').trim().toLowerCase()).filter(Boolean));
        const sidsByCode: Record<string, Set<string>> = {};
        const rowsByCode: Record<string, number> = {};
        for (const code of wanted) {
            sidsByCode[code] = new Set();
            rowsByCode[code] = 0;
        }

        for (const r of rawRows) {
            const sid = String(r.sid ?? '').trim();
            if (!sid) continue;
            const results = Array.isArray(r.results) ? r.results : [];
            for (const tr of results) {
                const code = String(tr?.test_code ?? '').trim().toLowerCase();
                if (!code || !wanted.has(code)) continue;
                sidsByCode[code].add(sid);
                rowsByCode[code] += 1;
            }
        }

        const sidsByCodeOut: Record<string, string[]> = {};
        for (const [code, set] of Object.entries(sidsByCode)) {
            sidsByCodeOut[code] = [...set].sort();
        }
        out.sidsByTestCode = sidsByCodeOut;
        out.resultRowsByTestCode = rowsByCode;
    }

    const cityKeys = opts.bucketCities?.map((k) => String(k || '').trim().toUpperCase()).filter(Boolean) ?? [];
    const stateKeys = opts.bucketStates?.map((k) => String(k || '').trim().toUpperCase()).filter(Boolean) ?? [];
    const geoLookup = opts.mccGeoLookup;

    if ((cityKeys.length > 0 || stateKeys.length > 0) && geoLookup && geoLookup.size > 0) {
        const wantedCity = new Set(cityKeys);
        const wantedState = new Set(stateKeys);
        const byCitySid: Record<string, Set<string>> = {};
        const byStateSid: Record<string, Set<string>> = {};
        const rowCountCity: Record<string, number> = {};
        const rowCountState: Record<string, number> = {};

        for (const k of wantedCity) {
            byCitySid[k] = new Set();
            rowCountCity[k] = 0;
        }
        for (const k of wantedState) {
            byStateSid[k] = new Set();
            rowCountState[k] = 0;
        }

        for (const r of rawRows) {
            const sid = String(r.sid ?? '').trim();
            if (!sid) continue;
            const mcc = String(r.client_code ?? '')
                .trim()
                .toUpperCase();
            const g = geoLookup.get(mcc);
            if (!g) continue;
            if (wantedCity.has(g.cityKey)) {
                byCitySid[g.cityKey].add(sid);
                rowCountCity[g.cityKey] += 1;
            }
            if (wantedState.has(g.stateKey)) {
                byStateSid[g.stateKey].add(sid);
                rowCountState[g.stateKey] += 1;
            }
        }



        const sidsByCityOut: Record<string, string[]> = {};
        for (const k of wantedCity) {
            sidsByCityOut[k] = [...byCitySid[k]].sort();
        }
        const sidsByStateOut: Record<string, string[]> = {};
        for (const k of wantedState) {
            sidsByStateOut[k] = [...byStateSid[k]].sort();
        }

        out.sidsByCity = sidsByCityOut;
        out.sidsByState = sidsByStateOut;
        out.resultRowsByCity = rowCountCity;
        out.resultRowsByState = rowCountState;
    }

    return out;
}
