import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../apiClient.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useSalesMarketingUsers } from '../hooks/useSalesMarketingUsers.js';
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
import { RunProgress } from '../components/RunProgress.jsx';

/**
 * @param {{
 *   tiles: object[],
 *   visibleTiles?: object[],
 *   reloadTiles: () => Promise<void>,
 *   submit: (body: object) => Promise<{ ok: boolean, error?: string }>,
 *   running: boolean,
 *   runFanOut?: object | null,
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
                        buKey: k,
                        bu: row.bu,
                        generalTile: row.generalTile,
                        urineTile: row.urineTile,
                        edtaTile: row.edtaTile,
                        citrateTile: row.citrateTile,
                        sHeparinTile: row.sHeparinTile,
                        lHeparinTile: row.lHeparinTile,
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
                await waitForRunIdle(() => apiFetch('/api/run/status'));
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

    const buCount = bannerRows.filter((row) => row.generalTile || row.urineTile || row.edtaTile).length;
    const regCount = regionBannerRows.filter(
        (row) => row.generalTile || row.urineTile || row.edtaTile || row.citrateTile || row.sHeparinTile || row.lHeparinTile
    ).length;
    const printSummaryParts = [];
    if (collatedBannerRow) printSummaryParts.push('collated');
    if (buCount) printSummaryParts.push(`${buCount} BU${buCount === 1 ? '' : 's'}`);
    if (regCount) printSummaryParts.push(`${regCount} sales scope${regCount === 1 ? '' : 's'}`);

    return (
        <div className={`tracer-page${printFocusKey ? ' tracer-print-single' : ''}`}>
            <div className="tracer-print-root">
                <div className="tracer-print-header" aria-hidden="true">
                    <h1 className="tracer-print-title">Stellar Matter — Tracer</h1>
                    {printSummaryParts.length > 0 ? (
                        <p className="tracer-print-sub muted small">{printSummaryParts.join(' · ')}</p>
                    ) : null}
                </div>

                <div className="tracer-hide-print">
                    {showFanOut && <RunProgress payload={runFanOut} />}
                    {running && !showFanOut && <RunProgress fallbackText="Starting run…" />}
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
                                citrateTile={collatedBannerRow.citrateTile}
                                sHeparinTile={collatedBannerRow.sHeparinTile}
                                lHeparinTile={collatedBannerRow.lHeparinTile}
                                clientPagesByNorm={clientPagesByNorm}
                                isPrintTarget={printFocusKey === collatedBannerRow.bannerKey}
                                onPrintSection={() => startPrintSection(collatedBannerRow.bannerKey)}
                                onOpenDetail={(tile, kind) => {
                                    if (!tile) return;
                                    setOpenTile(tile);
                                    setOpenTileKind(kind);
                                }}
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
                            citrateTile={row.citrateTile}
                            sHeparinTile={row.sHeparinTile}
                            lHeparinTile={row.lHeparinTile}
                            clientPagesByNorm={clientPagesByNorm}
                            isPrintTarget={printFocusKey === `bu:${row.buKey}`}
                            onPrintSection={() => startPrintSection(`bu:${row.buKey}`)}
                            onOpenDetail={(tile, kind) => {
                                if (!tile) return;
                                setOpenTile(tile);
                                setOpenTileKind(kind);
                            }}
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
                            citrateTile={row.citrateTile}
                            sHeparinTile={row.sHeparinTile}
                            lHeparinTile={row.lHeparinTile}
                            clientPagesByNorm={clientPagesByNorm}
                            isPrintTarget={printFocusKey === row.bannerKey}
                            onPrintSection={() => startPrintSection(row.bannerKey)}
                            onOpenDetail={(tile, kind) => {
                                if (!tile) return;
                                setOpenTile(tile);
                                setOpenTileKind(kind);
                            }}
                        />
                    ))}
                </div>

                <div className="tracer-pdf-row tracer-hide-print">
                    <button type="button" className="btn-secondary" onClick={() => window.print()}>
                        Print all
                    </button>
                    <span className="muted small">Opens the browser print dialog (Save as PDF).</span>
                </div>
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
        </div>
    );
}
