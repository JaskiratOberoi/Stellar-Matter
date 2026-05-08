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

export function aggregatePackages(rawRows: WorksheetReportRow[]): PackagesAggregate {
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

    return {
        rowCount: rows.length,
        rowsWithBrackets,
        otherTestsRowCount,
        uniqueLabelCount: Object.keys(labelOccurrences).length,
        labelOccurrences,
        labelToSids: labelToSidsOut,
        sids: [...sidSet].sort(),
        rows,
    };
}
