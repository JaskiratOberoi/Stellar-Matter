import { useMemo, useState } from 'react';
import {
    projectLetterheads,
    projectEnvelopes,
    projectUrineContainers,
    projectEdtaVials,
    projectCitrateVials,
    projectFlourideVials,
    projectSHeparin,
    projectLHeparin,
    projectLbc,
    projectBarcode,
    projectSerum
} from '../lib/tracer.js';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');

// One column per material. `value` returns null when the tile is missing so
// the cell reads as missing data, never as a zero.
const COLUMNS = [
    { id: 'lh', title: 'Letter heads', tile: 'generalTile', kind: 'letterheads',
      value: (t, pages) => (t ? projectLetterheads(t, pages).pages : null),
      est: (t, pages) => !!(t && projectLetterheads(t, pages).estimated) },
    { id: 'envBig', title: 'Env. big', tile: 'generalTile', kind: 'envelopes',
      value: (t, pages) => (t ? projectEnvelopes(t, pages).big : null) },
    { id: 'envSmall', title: 'Env. small', tile: 'generalTile', kind: 'envelopes',
      value: (t, pages) => (t ? projectEnvelopes(t, pages).small : null) },
    { id: 'urine', title: 'Urine', tile: 'urineTile', kind: 'urine_containers', value: (t) => (t ? projectUrineContainers(t).sidsTotal : null) },
    { id: 'edta', title: 'EDTA', tile: 'edtaTile', kind: 'edta_vials', value: (t) => (t ? projectEdtaVials(t).sidsTotal : null) },
    { id: 'flouride', title: 'Flouride', tile: 'flourideTile', kind: 'flouride_vials', value: (t) => (t ? projectFlourideVials(t).sidsTotal : null) },
    { id: 'citrate', title: 'Citrate', tile: 'citrateTile', kind: 'citrate_vials', value: (t) => (t ? projectCitrateVials(t).sidsTotal : null) },
    { id: 'sHep', title: 'S.Heparin', tile: 'sHeparinTile', kind: 's_heparin', value: (t) => (t ? projectSHeparin(t).sidsTotal : null) },
    { id: 'lHep', title: 'L.Heparin', tile: 'lHeparinTile', kind: 'l_heparin', value: (t) => (t ? projectLHeparin(t).sidsTotal : null) },
    { id: 'lbc', title: 'LBC', tile: 'lbcTile', kind: 'lbc', value: (t) => (t ? projectLbc(t).sidsTotal : null) },
    { id: 'barcode', title: 'Barcode', tile: 'barcodeTile', kind: 'barcode', value: (t) => (t ? projectBarcode(t).sidsTotal : null) },
    { id: 'serum', title: 'Serum', tile: 'serumTile', kind: 'serum', value: (t) => (t ? projectSerum(t).sidsTotal : null) }
];

/**
 * Results as one table: a row per unit / scope, a column per material, a sum
 * row. Clicking a figure opens the same breakdown as the card's button.
 *
 * @param {{
 *   rows: { key: string, label: string, group?: string, failed?: boolean, fromDate: string, toDate: string, [tile: string]: any }[],
 *   clientPagesByNorm: Record<string, number>,
 *   onOpenDetail: (tile: object, kind: string) => void,
 *   cover?: Record<string, number | null> | null,
 *   canPlan?: (row: object) => boolean,
 *   onPlan?: (row: object, vals: Record<string, number | null>) => void,
 * }} props
 */
export function TracerTable({ rows, clientPagesByNorm, onOpenDetail, cover = null, canPlan = null, onPlan = null }) {
    const [sort, setSort] = useState({ col: null, dir: -1 });

    const data = useMemo(
        () =>
            rows.map((r) => {
                const vals = {};
                for (const c of COLUMNS) vals[c.id] = c.value(r[c.tile], clientPagesByNorm);
                const missing = COLUMNS.every((c) => vals[c.id] == null);
                return {
                    row: r,
                    vals,
                    est: COLUMNS.some((c) => c.est && c.est(r[c.tile], clientPagesByNorm)),
                    missing
                };
            }),
        [rows, clientPagesByNorm]
    );

    const sorted = useMemo(() => {
        if (!sort.col) return data;
        return [...data].sort((a, b) => ((a.vals[sort.col] ?? -1) - (b.vals[sort.col] ?? -1)) * sort.dir);
    }, [data, sort]);

    // The sum adds rows as shown. Collated rows dedupe samples across units,
    // and units can share samples, so it is a planning total, not a count.
    const sums = {};
    for (const c of COLUMNS) {
        const present = data.filter((d) => d.vals[c.id] != null);
        sums[c.id] = present.length ? present.reduce((s, d) => s + d.vals[c.id], 0) : null;
    }

    // Demand the stores have to meet: the sum of rows, or the one row.
    const need = data.length === 1 ? data[0].vals : sums;
    const planning = Boolean(onPlan && canPlan);

    const toggleSort = (id) =>
        setSort((s) => (s.col === id ? (s.dir === -1 ? { col: id, dir: 1 } : { col: null, dir: -1 }) : { col: id, dir: -1 }));

    return (
        <div className="tracer-table-wrap">
            <table className="tracer-table">
                <thead>
                    <tr>
                        <th className="tracer-table-unit">Unit / scope</th>
                        {COLUMNS.map((c) => (
                            <th
                                key={c.id}
                                className="num"
                                aria-sort={sort.col === c.id ? (sort.dir === -1 ? 'descending' : 'ascending') : 'none'}
                            >
                                <button type="button" onClick={() => toggleSort(c.id)}>
                                    {c.title}
                                    {sort.col === c.id ? (sort.dir === -1 ? ' ↓' : ' ↑') : ''}
                                </button>
                            </th>
                        ))}
                        {planning && <th className="tracer-table-plan" aria-label="Plan a dispatch" />}
                    </tr>
                </thead>
                <tbody>
                    {sorted.map(({ row, vals, est, missing }) => (
                        <tr key={row.key} className={missing || row.failed ? 'is-missing' : undefined}>
                            <th scope="row" className="tracer-table-unit">
                                <span className="tracer-table-name">{row.label}</span>
                                {row.group && <span className="tracer-table-group">{row.group}</span>}
                                {row.failed ? (
                                    <span className="tracer-banner-status">Failed</span>
                                ) : missing ? (
                                    <span className="tracer-banner-status">No results</span>
                                ) : null}
                                {est && <span className="tracer-table-est" title="Some packages have no page count; letter heads are estimated">est.</span>}
                            </th>
                            {COLUMNS.map((c) => {
                                const v = vals[c.id];
                                const tile = row[c.tile];
                                return (
                                    <td key={c.id} className={`num${v == null ? ' is-na' : v === 0 ? ' is-zero' : ''}`}>
                                        {v == null ? (
                                            '—'
                                        ) : (
                                            <button
                                                type="button"
                                                title={`${row.label} · ${c.title} breakdown`}
                                                onClick={() => onOpenDetail(tile, c.kind)}
                                            >
                                                {fmt(v)}
                                            </button>
                                        )}
                                    </td>
                                );
                            })}
                            {planning && (
                                <td className="tracer-table-plan">
                                    {!missing && !row.failed && canPlan(row) ? (
                                        <button
                                            type="button"
                                            className="chip chip-tool"
                                            title={`Open Dispatch filled with ${row.label}'s demand for this window`}
                                            onClick={() => onPlan(row, vals)}
                                        >
                                            Plan dispatch
                                        </button>
                                    ) : null}
                                </td>
                            )}
                        </tr>
                    ))}
                </tbody>
                {(data.length > 1 || cover) && (
                    <tfoot>
                        {data.length > 1 && (
                            <tr>
                                <th scope="row" className="tracer-table-unit">
                                    Sum of rows
                                    <span className="tracer-table-group">not deduped across rows</span>
                                </th>
                                {COLUMNS.map((c) => (
                                    <td key={c.id} className="num">
                                        {sums[c.id] == null ? '—' : fmt(sums[c.id])}
                                    </td>
                                ))}
                                {planning && <td />}
                            </tr>
                        )}
                        {cover && (
                            <>
                                {/* Stores only: BU balances never go down yet, so they say nothing about need. */}
                                <tr className="tracer-cover-row">
                                    <th scope="row" className="tracer-table-unit">
                                        Stores hold
                                        <span className="tracer-table-group">all stores, today</span>
                                    </th>
                                    {COLUMNS.map((c) => (
                                        <td key={c.id} className="num">
                                            {cover[c.id] == null ? '—' : fmt(cover[c.id])}
                                        </td>
                                    ))}
                                    {planning && <td />}
                                </tr>
                                <tr className="tracer-cover-row">
                                    <th scope="row" className="tracer-table-unit">Cover</th>
                                    {COLUMNS.map((c) => {
                                        const have = cover[c.id];
                                        const want = need[c.id];
                                        if (have == null || want == null) {
                                            return (
                                                <td key={c.id} className="num is-na">
                                                    —
                                                </td>
                                            );
                                        }
                                        const short = want - have;
                                        return (
                                            <td key={c.id} className={`num tracer-cover ${short > 0 ? 'is-short' : 'is-ok'}`}>
                                                {short > 0 ? `short ${fmt(short)}` : 'covered'}
                                            </td>
                                        );
                                    })}
                                    {planning && <td />}
                                </tr>
                            </>
                        )}
                    </tfoot>
                )}
            </table>
        </div>
    );
}
