import { fmtDateRange } from '../lib/format.js';
import {
    projectLetterheads,
    projectEnvelopes,
    projectUrineContainers,
    projectEdtaVials,
    projectCitrateVials
} from '../lib/tracer.js';

// Module-scope component. MUST NOT be redefined inside TracerBanner — when a
// component type is re-created on every render, React unmounts and re-mounts
// the entire subtree (button included) every time. A re-render landing between
// mousedown and mouseup on a Breakdown button then swallows the click because
// the DOM node was swapped underneath the pointer, which is exactly what the
// "Breakdown does nothing on Tracer" report turned out to be.
function StatCard({ title, headline, subline, est, onOpen }) {
    return (
        <div className="tracer-stat-card nexus-card">
            <p className="tracer-stat-title eyebrow-lite">{title}</p>
            <p className="tracer-stat-headline">{headline}</p>
            <p className="tracer-stat-sub muted small">{subline}</p>
            {est ? <span className="tracer-stat-est muted small">estimated</span> : null}
            {onOpen ? (
                <button type="button" className="tracer-stat-link chip chip-tool" onClick={onOpen}>
                    Breakdown
                </button>
            ) : null}
        </div>
    );
}

/** @param {{ bu: string, fromDate: string, toDate: string, generalTile: object|null, urineTile: object|null, edtaTile: object|null, citrateTile: object|null, clientPagesByNorm: Record<string, number>, isPrintTarget?: boolean, onPrintSection?: () => void, onOpenDetail?: (tile: object | null, kind: string) => void }} props */
export function TracerBanner({
    bu,
    fromDate,
    toDate,
    generalTile,
    urineTile,
    edtaTile,
    citrateTile,
    clientPagesByNorm,
    isPrintTarget,
    onPrintSection,
    onOpenDetail
}) {
    const lh = generalTile ? projectLetterheads(generalTile, clientPagesByNorm) : { headline: '0', subline: 'No data', estimated: false };
    const env = generalTile ? projectEnvelopes(generalTile, clientPagesByNorm) : { headline: '0 BIG / 0 SMALL', subline: '0 total', estimated: false };
    const ur = urineTile ? projectUrineContainers(urineTile) : { headline: '0', subline: 'No data' };
    const ed = edtaTile ? projectEdtaVials(edtaTile) : { headline: '0', subline: 'No data' };
    const ct = citrateTile ? projectCitrateVials(citrateTile) : { headline: '0', subline: 'No data' };
    const rangeLabel = fmtDateRange(fromDate, toDate);

    return (
        <section className={`tracer-banner nexus-card${isPrintTarget ? ' is-printing' : ''}`}>
            <div className="tracer-banner-head">
                <div>
                    <h2 className="tracer-banner-bu">{bu}</h2>
                    <p className="muted small tracer-banner-range">{rangeLabel}</p>
                </div>
                {onPrintSection ? (
                    <button type="button" className="chip chip-tool tracer-banner-print tracer-hide-print" onClick={onPrintSection}>
                        Download PDF
                    </button>
                ) : null}
            </div>
            <div className="tracer-stat-row" role="group" aria-label={`Material stats for ${bu}`}>
                <StatCard
                    title="Letter Heads"
                    headline={lh.headline}
                    subline={lh.subline}
                    est={lh.estimated}
                    onOpen={generalTile && onOpenDetail ? () => onOpenDetail(generalTile, 'letterheads') : undefined}
                />
                <StatCard
                    title="Envelopes"
                    headline={env.headline}
                    subline={env.subline}
                    est={env.estimated}
                    onOpen={generalTile && onOpenDetail ? () => onOpenDetail(generalTile, 'envelopes') : undefined}
                />
                <StatCard
                    title="Urine Containers"
                    headline={ur.headline}
                    subline={ur.subline}
                    est={false}
                    onOpen={urineTile && onOpenDetail ? () => onOpenDetail(urineTile, 'urine_containers') : undefined}
                />
                <StatCard
                    title="EDTA Vials"
                    headline={ed.headline}
                    subline={ed.subline}
                    est={false}
                    onOpen={edtaTile && onOpenDetail ? () => onOpenDetail(edtaTile, 'edta_vials') : undefined}
                />
                <StatCard
                    title="Citrate"
                    headline={ct.headline}
                    subline={ct.subline}
                    est={false}
                    onOpen={citrateTile && onOpenDetail ? () => onOpenDetail(citrateTile, 'citrate_vials') : undefined}
                />
            </div>
        </section>
    );
}
