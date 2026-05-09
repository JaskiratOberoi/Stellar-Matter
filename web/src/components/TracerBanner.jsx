import { fmtDateRange } from '../lib/format.js';
import {
    projectLetterheads,
    projectEnvelopes,
    projectUrineContainers
} from '../lib/tracer.js';

/** @param {{ bu: string, fromDate: string, toDate: string, generalTile: object|null, urineTile: object|null, clientPagesByNorm: Record<string, number>, onOpenDetail?: (tile: object | null, kind: string) => void }} props */
export function TracerBanner({ bu, fromDate, toDate, generalTile, urineTile, clientPagesByNorm, onOpenDetail }) {
    const lh = generalTile ? projectLetterheads(generalTile, clientPagesByNorm) : { headline: '0', subline: 'No data', estimated: false };
    const env = generalTile ? projectEnvelopes(generalTile, clientPagesByNorm) : { headline: '0 BIG / 0 SMALL', subline: '0 total', estimated: false };
    const ur = urineTile ? projectUrineContainers(urineTile) : { headline: '0', subline: 'No data' };
    const rangeLabel = fmtDateRange(fromDate, toDate);

    const Card = ({ title, headline, subline, est, onOpen }) => (
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

    return (
        <section className="tracer-banner nexus-card">
            <div className="tracer-banner-head">
                <div>
                    <h2 className="tracer-banner-bu">{bu}</h2>
                    <p className="muted small tracer-banner-range">{rangeLabel}</p>
                </div>
            </div>
            <div className="tracer-stat-row" role="group" aria-label={`Material stats for ${bu}`}>
                <Card
                    title="Letter Heads"
                    headline={lh.headline}
                    subline={lh.subline}
                    est={lh.estimated}
                    onOpen={generalTile && onOpenDetail ? () => onOpenDetail(generalTile, 'letterheads') : undefined}
                />
                <Card
                    title="Envelopes"
                    headline={env.headline}
                    subline={env.subline}
                    est={env.estimated}
                    onOpen={generalTile && onOpenDetail ? () => onOpenDetail(generalTile, 'envelopes') : undefined}
                />
                <Card
                    title="Urine Containers"
                    headline={ur.headline}
                    subline={ur.subline}
                    est={false}
                    onOpen={urineTile && onOpenDetail ? () => onOpenDetail(urineTile, 'urine_containers') : undefined}
                />
            </div>
        </section>
    );
}
