'use strict';

/**
 * Labels inside `[...]` in Test Names cell; deduped within a single cell.
 * @param {string} text
 * @returns {string[]}
 */
function extractBracketLabels(text) {
    const raw = String(text || '');
    const re = /\[([^\]]+)\]/g;
    const seen = new Set();
    const out = [];
    let m;
    while ((m = re.exec(raw)) !== null) {
        const label = String(m[1] || '')
            .replace(/\s+/g, ' ')
            .trim();
        if (!label || seen.has(label)) continue;
        seen.add(label);
        out.push(label);
    }
    return out;
}

/**
 * Count every bracket occurrence (same label may appear multiple times in one cell).
 * @param {string} text
 * @returns {Record<string, number>}
 */
function countBracketMatches(text) {
    const raw = String(text || '');
    const re = /\[([^\]]+)\]/g;
    /** @type {Record<string, number>} */
    const counts = {};
    let m;
    while ((m = re.exec(raw)) !== null) {
        const label = String(m[1] || '')
            .replace(/\s+/g, ' ')
            .trim();
        if (!label) continue;
        counts[label] = (counts[label] || 0) + 1;
    }
    return counts;
}

/**
 * @param {{ sid: string, testNamesText: string }[]} rows
 * @returns {{ labelToSids: Record<string, string[]>, labelOccurrences: Record<string, number>, uniqueLabelCount: number, otherTestsRowCount: number }}
 */
function aggregateRows(rows) {
    /** @type {Record<string, Set<string>>} */
    const labelToSids = {};
    /** @type {Record<string, number>} */
    const labelOccurrences = {};
    let otherTestsRowCount = 0;

    for (const row of rows) {
        const sid = String(row.sid || '').trim();
        const testNamesText = row.testNamesText || '';

        const perCellCounts = countBracketMatches(testNamesText);
        if (Object.keys(perCellCounts).length === 0) {
            otherTestsRowCount++;
            continue;
        }

        for (const [label, c] of Object.entries(perCellCounts)) {
            labelOccurrences[label] = (labelOccurrences[label] || 0) + c;
        }

        if (!sid) continue;

        const labels = extractBracketLabels(testNamesText);
        for (const label of labels) {
            if (!labelToSids[label]) labelToSids[label] = new Set();
            labelToSids[label].add(sid);
        }
    }

    /** @type {Record<string, string[]>} */
    const labelToSidsOut = {};
    for (const [label, set] of Object.entries(labelToSids)) {
        labelToSidsOut[label] = [...set].sort();
    }

    const uniqueLabelCount = Object.keys(labelOccurrences).length;
    return { labelToSids: labelToSidsOut, labelOccurrences, uniqueLabelCount, otherTestsRowCount };
}

/**
 * @param {{ sid: string, testNamesText: string }[]} rows
 * @returns {number}
 */
function countRowsWithBracketLabels(rows) {
    let n = 0;
    for (const row of rows) {
        const t = String(row.testNamesText || '');
        if (t.includes('[') && /\[[^\]]+\]/.test(t)) n++;
    }
    return n;
}

module.exports = {
    extractBracketLabels,
    countBracketMatches,
    aggregateRows,
    countRowsWithBracketLabels
};
