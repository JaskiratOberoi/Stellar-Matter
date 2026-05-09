import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../apiClient.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useRegions } from '../hooks/useRegions.js';
import { useTracerRegionSelection } from '../hooks/useTracerRegionSelection.js';
import {
    buildRegionsSubmitPayload,
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

    const { states: regionStates, error: regionsFetchErr, loading: regionsLoading } = useRegions();
    const {
        selectedStates: regionSelectedStates,
        selectedCities: regionSelectedCities,
        toggleState,
        toggleCity,
        clearRegions,
        pruneStale
    } = useTracerRegionSelection();

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
    const [localError, setLocalError] = useState( /** @type {string | null} */ (null));
    const [tracerBusy, setTracerBusy] = useState(false);
    const [openTile, setOpenTile] = useState( /** @type {object | null} */ (null));
    const [openTileKind, setOpenTileKind] = useState('letterheads');
    /** Print focus: BU key (`bu:normalized`) or region `tracerRegionRowKey`. */
    const [printFocusKey, setPrintFocusKey] = useState( /** @type {string | null} */ (null));

    const pendingBannerRef = useRef(
        /** @type {null | { batchIso: string, from: string, to: string, bus: Set<string>, regionTargets: { kind: string, key: string, label: string }[] }} */ (
            null
        )
    );
    const busy = running || tracerBusy;
    const showFanOut = running && !!runFanOut;

    const tilesForIndex = visibleTiles ?? tiles;

    useEffect(() => {
        if (!regionStates.length) return;
        const validStateKeys = new Set(regionStates.map((s) => s.key));
        const validCityKeys = new Set();
        for (const s of regionStates) {
            for (const c of s.cities || []) validCityKeys.add(c.key);
        }
        pruneStale(validStateKeys, validCityKeys);
    }, [regionStates, pruneStale]);

    useEffect(() => {
        const p = pendingBannerRef.current;
        if (!p) return;
        pendingBannerRef.current = null;

        const from = p.from;
        const to = p.to;
        const batchIso = p.batchIso;

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

        const rt = p.regionTargets || [];
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
        const { regions } = buildRegionsSubmitPayload(snap.regionStatesTree, snap.selectedRegions.states, snap.selectedRegions.cities);
        if (regions.states.length > 0 || regions.cities.length > 0) {
            body.regions = regions;
        }
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
            const { bannerTargets } = buildRegionsSubmitPayload(
                snap.regionStatesTree,
                snap.selectedRegions.states,
                snap.selectedRegions.cities
            );

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
                    regionTargets: bannerTargets
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
    if (buCount) printSummaryParts.push(`${buCount} BU${buCount === 1 ? '' : 's'}`);
    if (regCount) printSummaryParts.push(`${regCount} region${regCount === 1 ? '' : 's'}`);

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
                    regionStates={regionStates}
                    regionLoading={regionsLoading}
                    regionLookupError={regionsFetchErr}
                    regionSelectedStates={regionSelectedStates}
                    regionSelectedCities={regionSelectedCities}
                    regionActions={{
                        toggleState,
                        toggleCity,
                        clearRegions
                    }}
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
                        <span className="eyebrow-lite field-label">Region tracer</span>
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
