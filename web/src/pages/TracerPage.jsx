import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../apiClient.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { mapTilesToBanners, tracerBuKey, waitForRunIdle } from '../lib/tracer.js';
import { TracerBanner } from '../components/TracerBanner.jsx';
import '../styles/tracer.css';
import { TracerForm } from '../components/TracerForm.jsx';
import { RunModal } from '../components/RunModal.jsx';

/**
 * @param {{
 *   tiles: object[],
 *   visibleTiles?: object[],
 *   reloadTiles: () => Promise<void>,
 *   submit: (body: object) => Promise<{ ok: boolean, error?: string }>,
 *   running: boolean,
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

    const [bannerRows, setBannerRows] = useState(
        /** @type {{ buKey: string, bu: string, fromDate: string, toDate: string, generalTile: object | null, urineTile: object | null, edtaTile: object | null, citrateTile: object | null }[]} */ ([])
    );
    const [localError, setLocalError] = useState( /** @type {string | null} */ (null));
    const [tracerBusy, setTracerBusy] = useState(false);
    const [openTile, setOpenTile] = useState( /** @type {object | null} */ (null));
    const [openTileKind, setOpenTileKind] = useState('letterheads');
    const [printFocusKey, setPrintFocusKey] = useState( /** @type {string | null} */ (null));

    const pendingBannerRef = useRef( /** @type {null | { batchIso: string, from: string, to: string, bus: Set<string> }} */ (null));
    const busy = running || tracerBusy;

    const tilesForIndex = visibleTiles ?? tiles;

    useEffect(() => {
        const p = pendingBannerRef.current;
        if (!p) return;
        pendingBannerRef.current = null;
        const incoming = mapTilesToBanners(tiles, p.bus, p.batchIso, p.from, p.to);
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
                    fromDate: p.from,
                    toDate: p.to
                });
            }
            return [...m.values()];
        });
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

    const startPrintBu = useCallback((buKey) => {
        setPrintFocusKey(buKey);
        requestAnimationFrame(() => window.print());
    }, []);

    const buildBody = useCallback((mode, snap) => {
        const body = { source: 'sql', mode };
        if (snap.fromDate) body.fromDate = snap.fromDate;
        if (snap.toDate) body.toDate = snap.toDate;
        if (String(snap.fromHour || '').trim() !== '') body.fromHour = Number(snap.fromHour);
        if (String(snap.toHour || '').trim() !== '') body.toHour = Number(snap.toHour);
        if (snap.businessUnits && snap.businessUnits.length > 0) {
            body.businessUnits = snap.businessUnits;
            if (snap.businessUnits.length === 1 && !body.bu) body.bu = snap.businessUnits[0];
        } else if (String(snap.bu || '').trim()) {
            body.bu = String(snap.bu).trim();
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
            setTracerBusy(true);
            try {
                const r1 = await submit(buildBody('general', snap));
                if (!r1.ok) {
                    setLocalError(String(r1.error || 'General run failed'));
                    return;
                }
                await waitForRunIdle(() => apiFetch('/api/run/status'));
                const r2 = await submit(buildBody('urine_containers', snap));
                if (!r2.ok) {
                    setLocalError(String(r2.error || 'Urine container run failed'));
                    return;
                }
                await waitForRunIdle(() => apiFetch('/api/run/status'));
                const r3 = await submit(buildBody('edta_vials', snap));
                if (!r3.ok) {
                    setLocalError(String(r3.error || 'EDTA vials run failed'));
                    return;
                }
                await waitForRunIdle(() => apiFetch('/api/run/status'));
                const r4 = await submit(buildBody('citrate_vials', snap));
                if (!r4.ok) {
                    setLocalError(String(r4.error || 'Citrate run failed'));
                    return;
                }
                await waitForRunIdle(() => apiFetch('/api/run/status'));
                pendingBannerRef.current = { batchIso, from: snap.fromDate, to: snap.toDate, bus };
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
        [buildBody, reloadTiles, submit, viewerDisabled]
    );

    return (
        <div className={`tracer-page${printFocusKey ? ' tracer-print-single' : ''}`}>
            <div className="tracer-print-root">
                <div className="tracer-print-header" aria-hidden="true">
                    <h1 className="tracer-print-title">Stellar Matter — Tracer</h1>
                    {bannerRows.length > 0 ? (
                        <p className="tracer-print-sub muted small">
                            {bannerRows.length} business unit{bannerRows.length === 1 ? '' : 's'}
                        </p>
                    ) : null}
                </div>

                <TracerForm
                    buOptions={buOptions}
                    buSelected={buSelected}
                    buActions={buActions}
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
                            clientPagesByNorm={clientPagesByNorm}
                            isPrintTarget={printFocusKey === row.buKey}
                            onPrintSection={() => startPrintBu(row.buKey)}
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
