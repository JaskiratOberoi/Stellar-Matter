import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../apiClient.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useSalesMarketingUsers } from '../hooks/useSalesMarketingUsers.js';
import { fmtDateRange } from '../lib/format.js';
import {
    mapCollatedTileToBanner,
    mapRegionTilesToBanners,
    mapTilesToBanners,
    tracerBuKey,
    waitForRunIdle
} from '../lib/tracer.js';
import { TracerBanner } from '../components/TracerBanner.jsx';
import '../styles/tracer.css';
import { TracerForm } from '../components/TracerForm.jsx';
import { RunModal } from '../components/RunModal.jsx';
import { CodeWiseModal } from '../components/CodeWiseModal.jsx';
import { RunProgress } from '../components/RunProgress.jsx';

/**
 * @param {{
 *   tiles: object[],
 *   visibleTiles?: object[],
 *   reloadTiles: () => Promise<void>,
 *   submit: (body: object) => Promise<{ ok: boolean, error?: string }>,
 *   running: boolean,
 *   runFanOut?: object | null,
 *   onCancelRun?: () => Promise<{ ok: boolean }>,
 *   cancelling?: boolean,
 *   cancellable?: boolean,
 *   clientPagesByNorm: Record<string, number>,
 *   buOptions: { options: { id: string, label: string }[], error: string | null },
 *   buSelected: Set<string>,
 *   buActions: { toggle: (label: string) => void, selectAll: () => void, clear: () => void },
 *   loadError: string | null,
 *   errors: { file: string, error: string }[],
 *   submitError: string | null,
 * }} props
 */
export function TracerPage({
    tiles,
    visibleTiles,
    reloadTiles,
    submit,
    running,
    runFanOut,
    onCancelRun,
    cancelling,
    cancellable,
    clientPagesByNorm,
    buOptions,
    buSelected,
    buActions,
    loadError,
    errors,
    submitError
}) {
    const { authRequired, user } = useAuth();
    const viewerDisabled = Boolean(authRequired && user && user.role === 'viewer');

    const { users: salesUsers, error: salesFetchErr, loading: salesLoading } = useSalesMarketingUsers();

    const [salesSelectedIds, setSalesSelectedIds] = useState(() => new Set());

    const toggleSales = useCallback((userId, label) => {
        setSalesSelectedIds((prev) => {
            const n = new Set(prev);
            if (n.has(userId)) n.delete(userId);
            else n.add(userId);
            return n;
        });
    }, []);

    const clearSales = useCallback(() => setSalesSelectedIds(new Set()), []);
    const [bannerRows, setBannerRows] = useState(
        /** @type {{ buKey: string, bu: string, fromDate: string, toDate: string, generalTile: object | null, urineTile: object | null, edtaTile: object | null, citrateTile: object | null, sHeparinTile: object | null, lHeparinTile: object | null }[]} */ (
            []
        )
    );
    const [regionBannerRows, setRegionBannerRows] = useState(
        /** @type {{ bannerKey: string, label: string, kind: string, key: string, fromDate: string, toDate: string, generalTile: object | null, urineTile: object | null, edtaTile: object | null, citrateTile: object | null, sHeparinTile: object | null, lHeparinTile: object | null }[]} */ (
            []
        )
    );
    const [collatedBannerRow, setCollatedBannerRow] = useState(
        /** @type {null | { bannerKey: string, label: string, fromDate: string, toDate: string, generalTile: object | null, urineTile: object | null, edtaTile: object | null, citrateTile: object | null, sHeparinTile: object | null, lHeparinTile: object | null }} */ (
            null
        )
    );
    const [localError, setLocalError] = useState( /** @type {string | null} */ (null));
    const [tracerBusy, setTracerBusy] = useState(false);
    const [openTile, setOpenTile] = useState( /** @type {object | null} */ (null));
    const [openTileKind, setOpenTileKind] = useState('letterheads');
    /** Scope whose code-wise table is open: { tile, bu, fromDate, toDate }. */
    const [codeWiseScope, setCodeWiseScope] = useState(/** @type {object | null} */ (null));
    /** Print focus: BU key (`bu:normalized`) or region `tracerRegionRowKey`. */
    const [printFocusKey, setPrintFocusKey] = useState( /** @type {string | null} */ (null));

    const pendingBannerRef = useRef(
        /** @type {null | { batchIso: string, from: string, to: string, bus: Set<string>, scopeTargets: { kind: string, key: string, label: string }[], collate: boolean }} */ (
            null
        )
    );
    const busy = running || tracerBusy;
    const showFanOut = running && !!runFanOut;

    const tilesForIndex = visibleTiles ?? tiles;

    useEffect(() => {
        const p = pendingBannerRef.current;
        if (!p) return;
        pendingBannerRef.current = null;

        const from = p.from;
        const to = p.to;
        const batchIso = p.batchIso;

        // Collate replaces the per-BU and per-region rows entirely. Reset
        // those stacks so a previously collate-OFF batch's tiles don't keep
        // hanging around alongside the new collated row.
        if (p.collate) {
            const collated = mapCollatedTileToBanner(tiles, batchIso, from, to);
            if (collated) {
                setCollatedBannerRow(collated);
                setBannerRows([]);
                setRegionBannerRows([]);
            }
            return;
        }

        // Non-collate batch: drop any stale collated row from a prior run so
        // the wall doesn't show both shapes simultaneously.
        setCollatedBannerRow(null);

        if (p.bus && p.bus.size > 0) {
            const incoming = mapTilesToBanners(tiles, p.bus, batchIso, from, to);
            setBannerRows((prev) => {
                const m = new Map(prev.map((r) => [r.buKey, { ...r }]));
                for (const row of incoming) {
                    const k = tracerBuKey(row.bu);
                    m.set(k, {
                        ...row,
                        buKey: k,
                        bu: row.bu,
                        fromDate: from,
                        toDate: to
                    });
                }
                return [...m.values()];
            });
        }

        const rt = p.scopeTargets || [];
        if (rt.length > 0) {
            const incomingReg = mapRegionTilesToBanners(tiles, rt, batchIso, from, to);
            setRegionBannerRows((prev) => {
                const m = new Map(prev.map((r) => [r.bannerKey, { ...r }]));
                for (const row of incomingReg) {
                    m.set(row.bannerKey, {
                        ...row,
                        fromDate: from,
                        toDate: to
                    });
                }
                return [...m.values()];
            });
        }
    }, [tiles]);

    useEffect(() => {
        const onAfterPrint = () => setPrintFocusKey(null);
        window.addEventListener('afterprint', onAfterPrint);
        return () => window.removeEventListener('afterprint', onAfterPrint);
    }, []);

    const indexFromOne = useCallback(
        (tile) => {
            const i = tilesForIndex.findIndex((t) => String(t.id) === String(tile.id));
            const n = i + 1;
            return n > 0 ? n : 1;
        },
        [tilesForIndex]
    );

    const startPrintSection = useCallback((key) => {
        setPrintFocusKey(key);
        requestAnimationFrame(() => window.print());
    }, []);

    const buildTracerBody = useCallback((snap) => {
        const body = { source: 'sql' };
        if (snap.fromDate) body.fromDate = snap.fromDate;
        if (snap.toDate) body.toDate = snap.toDate;
        if (String(snap.fromHour || '').trim() !== '') body.fromHour = Number(snap.fromHour);
        if (String(snap.toHour || '').trim() !== '') body.toHour = Number(snap.toHour);
        if (snap.businessUnits && snap.businessUnits.length > 0) {
            body.businessUnits = snap.businessUnits;
            if (snap.businessUnits.length === 1 && !body.bu) body.bu = snap.businessUnits[0];
        } else if (String(snap.bu || '').trim()) {
            body.bu = String(snap.bu).trim();
            body.businessUnits = [body.bu];
        }
        const sp = Array.isArray(snap.salesPeople) ? snap.salesPeople : [];
        if (sp.length > 0) body.salesPeople = sp;
        if (snap.collate) body.collate = true;
        return body;
    }, []);

    const handleCancel = useCallback(async () => {
        if (typeof onCancelRun !== 'function') return;
        setLocalError(null);
        await onCancelRun();
    }, [onCancelRun]);

    const handleRun = useCallback(
        async (snap) => {
            setLocalError(null);
            if (viewerDisabled) return;
            const batchIso = new Date().toISOString();
            const bus = new Set(snap.businessUnits.length > 0 ? snap.businessUnits : []);
            if (bus.size === 0 && String(snap.bu || '').trim()) {
                bus.add(String(snap.bu).trim());
            }
            const scopeTargets = (snap.salesPeople || []).map((p) => ({
                kind: 'sales',
                key: String(p.id),
                label: String(p.label || p.id)
            }));

            setTracerBusy(true);
            try {
                const r = await submit(buildTracerBody(snap), { endpoint: '/api/tracer-run' });
                if (!r.ok) {
                    setLocalError(String(r.error || 'Tracer run failed'));
                    return;
                }
                const final = await waitForRunIdle(() => apiFetch('/api/run/status'));
                if (final && final.cancelled) {
                    setLocalError(
                        'Tracer run cancelled. Any scope that finished before the stop kept its tiles; the rest were aborted on the server.'
                    );
                }
                pendingBannerRef.current = {
                    batchIso,
                    from: snap.fromDate,
                    to: snap.toDate,
                    bus,
                    scopeTargets,
                    collate: !!snap.collate
                };
                try {
                    await reloadTiles();
                } catch (loadErr) {
                    pendingBannerRef.current = null;
                    throw loadErr;
                }
            } catch (e) {
                setLocalError(String(e));
            } finally {
                setTracerBusy(false);
            }
        },
        [buildTracerBody, reloadTiles, submit, viewerDisabled]
    );

    const buCount = bannerRows.filter(
        (row) =>
            row.generalTile ||
            row.urineTile ||
            row.edtaTile ||
            row.flourideTile ||
            row.citrateTile ||
            row.sHeparinTile ||
            row.lHeparinTile ||
            row.lbcTile ||
            row.barcodeTile ||
            row.serumTile
    ).length;
    const regCount = regionBannerRows.filter(
        (row) =>
            row.generalTile ||
            row.urineTile ||
            row.edtaTile ||
            row.flourideTile ||
            row.citrateTile ||
            row.sHeparinTile ||
            row.lHeparinTile ||
            row.lbcTile ||
            row.barcodeTile ||
            row.serumTile
    ).length;
    const printSummaryParts = [];
    if (collatedBannerRow) printSummaryParts.push('collated');
    if (buCount) printSummaryParts.push(`${buCount} business unit${buCount === 1 ? '' : 's'}`);
    if (regCount) printSummaryParts.push(`${regCount} sales scope${regCount === 1 ? '' : 's'}`);
    const firstRow = collatedBannerRow || bannerRows[0] || regionBannerRows[0] || null;
    const windowLabel = firstRow ? fmtDateRange(firstRow.fromDate, firstRow.toDate) : '';
    if (windowLabel) printSummaryParts.push(windowLabel);
    const hasResults = Boolean(collatedBannerRow) || buCount > 0 || regCount > 0;
    const resultsCaption = printSummaryParts.join(' · ');

    return (
        <div className={`tracer-page${printFocusKey ? ' tracer-print-single' : ''}`}>
            <div className="tracer-print-root">
                <div className="tracer-print-header" aria-hidden="true">
                    <h1 className="tracer-print-title">Stellar Matter — Tracer</h1>
                    {printSummaryParts.length > 0 ? (
                        <p className="tracer-print-sub muted small">{printSummaryParts.join(' · ')}</p>
                    ) : null}
                </div>

                <div className="inv-sechead tracer-page-head tracer-hide-print">
                    <div className="inv-sechead-text">
                        <h2 className="inv-sechead-title">Tracer</h2>
                        <p className="inv-sechead-cap">
                            Material counts per business unit or sales scope for a date window, straight from Listec.
                        </p>
                    </div>
                </div>

                <div className="tracer-hide-print">
                    {showFanOut && (
                        <RunProgress
                            payload={runFanOut}
                            onCancel={handleCancel}
                            cancelling={cancelling}
                            cancelDisabled={!cancellable || viewerDisabled}
                        />
                    )}
                    {running && !showFanOut && (
                        <RunProgress
                            fallbackText="Starting run…"
                            onCancel={handleCancel}
                            cancelling={cancelling}
                            cancelDisabled={!cancellable || viewerDisabled}
                        />
                    )}
                    {!running && tracerBusy && <RunProgress fallbackText="Preparing next tracer step…" />}
                </div>

                <TracerForm
                    buOptions={buOptions}
                    buSelected={buSelected}
                    buActions={buActions}
                    salesUsers={salesUsers}
                    salesLoading={salesLoading}
                    salesLookupError={salesFetchErr}
                    salesSelectedIds={salesSelectedIds}
                    salesActions={{ toggle: toggleSales, clear: clearSales }}
                    busy={busy}
                    viewerDisabled={viewerDisabled}
                    onRun={handleRun}
                />

                {(localError || submitError || loadError || errors.length > 0) && (
                    <div className="results-error nexus-card tracer-hide-print">
                        {localError ||
                            submitError ||
                            loadError ||
                            `Tile load: ${errors.map((e) => `${e.file}: ${e.error}`).join(' \u00b7 ')}`}
                    </div>
                )}

                {hasResults ? (
                    <div className="inv-sechead tracer-results-head tracer-hide-print">
                        <div className="inv-sechead-text">
                            <h2 className="inv-sechead-title">Results</h2>
                            <p className="inv-sechead-cap">{resultsCaption}</p>
                        </div>
                        <div className="inv-sechead-tools">
                            <button type="button" className="chip chip-tool" onClick={() => window.print()}>
                                Print all
                            </button>
                        </div>
                    </div>
                ) : null}

                {collatedBannerRow ? (
                    <>
                        <div className="tracer-collated-banner-head tracer-hide-print">
                            <span className="eyebrow-lite field-label">Collated tracer</span>
                            <span className="muted small">SIDs deduped across selected BUs and sales scopes</span>
                        </div>
                        <div className="tracer-banner-stack">
                            <TracerBanner
                                key={collatedBannerRow.bannerKey}
                                bu={collatedBannerRow.label}
                                fromDate={collatedBannerRow.fromDate}
                                toDate={collatedBannerRow.toDate}
                                generalTile={collatedBannerRow.generalTile}
                                urineTile={collatedBannerRow.urineTile}
                                edtaTile={collatedBannerRow.edtaTile}
                                flourideTile={collatedBannerRow.flourideTile}
                                citrateTile={collatedBannerRow.citrateTile}
                                sHeparinTile={collatedBannerRow.sHeparinTile}
                                lHeparinTile={collatedBannerRow.lHeparinTile}
                                lbcTile={collatedBannerRow.lbcTile}
                                barcodeTile={collatedBannerRow.barcodeTile}
                                serumTile={collatedBannerRow.serumTile}
                                clientPagesByNorm={clientPagesByNorm}
                                isPrintTarget={printFocusKey === collatedBannerRow.bannerKey}
                                onPrintSection={() => startPrintSection(collatedBannerRow.bannerKey)}
                                onOpenDetail={(tile, kind) => {
                                    if (!tile) return;
                                    setOpenTile(tile);
                                    setOpenTileKind(kind);
                                }}
                                onExpandCodeWise={() =>
                                    setCodeWiseScope({
                                        tile: collatedBannerRow.generalTile,
                                        bu: collatedBannerRow.label,
                                        fromDate: collatedBannerRow.fromDate,
                                        toDate: collatedBannerRow.toDate
                                    })
                                }
                            />
                        </div>
                    </>
                ) : null}

                <div className="tracer-banner-stack">
                    {bannerRows.map((row) => (
                        <TracerBanner
                            key={row.buKey}
                            bu={row.bu}
                            fromDate={row.fromDate}
                            toDate={row.toDate}
                            generalTile={row.generalTile}
                            urineTile={row.urineTile}
                            edtaTile={row.edtaTile}
                            flourideTile={row.flourideTile}
                            citrateTile={row.citrateTile}
                            sHeparinTile={row.sHeparinTile}
                            lHeparinTile={row.lHeparinTile}
                            lbcTile={row.lbcTile}
                            barcodeTile={row.barcodeTile}
                            serumTile={row.serumTile}
                            clientPagesByNorm={clientPagesByNorm}
                            isPrintTarget={printFocusKey === `bu:${row.buKey}`}
                            onPrintSection={() => startPrintSection(`bu:${row.buKey}`)}
                            onOpenDetail={(tile, kind) => {
                                if (!tile) return;
                                setOpenTile(tile);
                                setOpenTileKind(kind);
                            }}
                            onExpandCodeWise={() =>
                                setCodeWiseScope({
                                    tile: row.generalTile,
                                    bu: row.bu,
                                    fromDate: row.fromDate,
                                    toDate: row.toDate
                                })
                            }
                        />
                    ))}
                </div>

                {regionBannerRows.length > 0 ? (
                    <div className="tracer-region-stack-head tracer-hide-print">
                        <span className="eyebrow-lite field-label">Sales scope tracer</span>
                    </div>
                ) : null}

                <div className="tracer-banner-stack">
                    {regionBannerRows.map((row) => (
                        <TracerBanner
                            key={row.bannerKey}
                            bu={row.label}
                            fromDate={row.fromDate}
                            toDate={row.toDate}
                            generalTile={row.generalTile}
                            urineTile={row.urineTile}
                            edtaTile={row.edtaTile}
                            flourideTile={row.flourideTile}
                            citrateTile={row.citrateTile}
                            sHeparinTile={row.sHeparinTile}
                            lHeparinTile={row.lHeparinTile}
                            lbcTile={row.lbcTile}
                            barcodeTile={row.barcodeTile}
                            serumTile={row.serumTile}
                            clientPagesByNorm={clientPagesByNorm}
                            isPrintTarget={printFocusKey === row.bannerKey}
                            onPrintSection={() => startPrintSection(row.bannerKey)}
                            onOpenDetail={(tile, kind) => {
                                if (!tile) return;
                                setOpenTile(tile);
                                setOpenTileKind(kind);
                            }}
                            onExpandCodeWise={() =>
                                setCodeWiseScope({
                                    tile: row.generalTile,
                                    bu: row.label,
                                    fromDate: row.fromDate,
                                    toDate: row.toDate
                                })
                            }
                        />
                    ))}
                </div>

                {hasResults ? (
                    <div className="tracer-pdf-row tracer-hide-print">
                        <button type="button" className="btn-secondary" onClick={() => window.print()}>
                            Print all
                        </button>
                        <span className="muted small">
                            Each business unit prints as one block — a block that does not fit moves to the next page.
                        </span>
                    </div>
                ) : null}
            </div>

            {openTile && (
                <RunModal
                    tile={openTile}
                    kind={openTileKind}
                    indexFromOne={indexFromOne(openTile)}
                    clientPagesByNorm={clientPagesByNorm}
                    onClose={() => setOpenTile(null)}
                />
            )}

            {codeWiseScope && codeWiseScope.tile && (
                <CodeWiseModal
                    tile={codeWiseScope.tile}
                    bu={codeWiseScope.bu}
                    fromDate={codeWiseScope.fromDate}
                    toDate={codeWiseScope.toDate}
                    clientPagesByNorm={clientPagesByNorm}
                    onClose={() => setCodeWiseScope(null)}
                />
            )}
        </div>
    );
}
