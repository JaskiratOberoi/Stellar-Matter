import { fmtDateRange } from '../lib/format.js';
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

/** @param {{ bu: string, fromDate: string, toDate: string, generalTile: object|null, urineTile: object|null, edtaTile: object|null, flourideTile: object|null, citrateTile: object|null, sHeparinTile: object|null, lHeparinTile: object|null, lbcTile: object|null, barcodeTile: object|null, serumTile: object|null, clientPagesByNorm: Record<string, number>, isPrintTarget?: boolean, onPrintSection?: () => void, onOpenDetail?: (tile: object | null, kind: string) => void, onExpandCodeWise?: () => void }} props */
export function TracerBanner({
    bu,
    fromDate,
    toDate,
    generalTile,
    urineTile,
    edtaTile,
    flourideTile,
    citrateTile,
    sHeparinTile,
    lHeparinTile,
    lbcTile,
    barcodeTile,
    serumTile,
    clientPagesByNorm,
    isPrintTarget,
    onPrintSection,
    onOpenDetail,
    onExpandCodeWise
}) {
    const lh = generalTile ? projectLetterheads(generalTile, clientPagesByNorm) : { headline: '0', subline: 'No data', estimated: false };
    const env = generalTile ? projectEnvelopes(generalTile, clientPagesByNorm) : { headline: '0 BIG / 0 SMALL', subline: '0 total', estimated: false };
    const ur = urineTile ? projectUrineContainers(urineTile) : { headline: '0', subline: 'No data' };
    const ed = edtaTile ? projectEdtaVials(edtaTile) : { headline: '0', subline: 'No data' };
    const fl = flourideTile ? projectFlourideVials(flourideTile) : { headline: '0', subline: 'No data' };
    const ct = citrateTile ? projectCitrateVials(citrateTile) : { headline: '0', subline: 'No data' };
    const sh = sHeparinTile ? projectSHeparin(sHeparinTile) : { headline: '0', subline: 'No data' };
    const lhep = lHeparinTile ? projectLHeparin(lHeparinTile) : { headline: '0', subline: 'No data' };
    const lbc = lbcTile ? projectLbc(lbcTile) : { headline: '0', subline: 'No data' };
    const bc = barcodeTile ? projectBarcode(barcodeTile) : { headline: '0', subline: 'No data' };
    const sr = serumTile ? projectSerum(serumTile) : { headline: '0', subline: 'No data' };
    const rangeLabel = fmtDateRange(fromDate, toDate);

    return (
        <section className={`tracer-banner nexus-card${isPrintTarget ? ' is-printing' : ''}`}>
            <div className="tracer-banner-head">
                <div>
                    <h2 className="tracer-banner-bu">{bu}</h2>
                    <p className="muted small tracer-banner-range">{rangeLabel}</p>
                </div>
                <div className="tracer-banner-tools tracer-hide-print">
                    {onPrintSection ? (
                        <button type="button" className="chip chip-tool tracer-banner-print" onClick={onPrintSection}>
                            Download PDF
                        </button>
                    ) : null}
                    {onExpandCodeWise && generalTile ? (
                        <button
                            type="button"
                            className="chip chip-tool tracer-banner-expand"
                            onClick={onExpandCodeWise}
                            title="Code-wise count for this scope"
                        >
                            Expand
                        </button>
                    ) : null}
                </div>
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
                    title="Flouride Vials"
                    headline={fl.headline}
                    subline={fl.subline}
                    est={false}
                    onOpen={flourideTile && onOpenDetail ? () => onOpenDetail(flourideTile, 'flouride_vials') : undefined}
                />
                <StatCard
                    title="Citrate"
                    headline={ct.headline}
                    subline={ct.subline}
                    est={false}
                    onOpen={citrateTile && onOpenDetail ? () => onOpenDetail(citrateTile, 'citrate_vials') : undefined}
                />
                <StatCard
                    title="S.Heparin"
                    headline={sh.headline}
                    subline={sh.subline}
                    est={false}
                    onOpen={sHeparinTile && onOpenDetail ? () => onOpenDetail(sHeparinTile, 's_heparin') : undefined}
                />
                <StatCard
                    title="L.Heparin"
                    headline={lhep.headline}
                    subline={lhep.subline}
                    est={false}
                    onOpen={lHeparinTile && onOpenDetail ? () => onOpenDetail(lHeparinTile, 'l_heparin') : undefined}
                />
                <StatCard
                    title="LBC"
                    headline={lbc.headline}
                    subline={lbc.subline}
                    est={false}
                    onOpen={lbcTile && onOpenDetail ? () => onOpenDetail(lbcTile, 'lbc') : undefined}
                />
                <StatCard
                    title="Barcode"
                    headline={bc.headline}
                    subline={bc.subline}
                    est={false}
                    onOpen={barcodeTile && onOpenDetail ? () => onOpenDetail(barcodeTile, 'barcode') : undefined}
                />
                <StatCard
                    title="Serum"
                    headline={sr.headline}
                    subline={sr.subline}
                    est={false}
                    onOpen={serumTile && onOpenDetail ? () => onOpenDetail(serumTile, 'serum') : undefined}
                />
            </div>
        </section>
    );
}
