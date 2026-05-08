import { useCallback, useEffect, useMemo, useState } from 'react';
import { Topbar } from './components/Topbar.jsx';
import { RunSidebar } from './components/RunSidebar.jsx';
import { TileWall } from './components/TileWall.jsx';
import { RunModal } from './components/RunModal.jsx';
import { RunProgress } from './components/RunProgress.jsx';
import { useAuth } from './contexts/AuthContext.jsx';
import { useTiles } from './hooks/useTiles.js';
import { useBuOptions } from './hooks/useBuOptions.js';
import { useRunStatus } from './hooks/useRunStatus.js';
import { usePackagePagesMap } from './hooks/usePackagePagesMap.js';
import {
    LS_HIDDEN,
    LS_SIDEBAR,
    LS_VIEW,
    clearHiddenSet,
    readHiddenSet,
    readString,
    writeHiddenSet,
    writeString
} from './lib/storage.js';
import './styles/app.css';

function loadInitialView() {
    const raw = readString(LS_VIEW, 'letterheads');
    if (raw === 'history' || raw === 'envelopes' || raw === 'letterheads') return raw;
    if (raw === 'results') return 'letterheads';
    return 'letterheads';
}

export function App() {
    const { authRequired, user, loading: authLoading } = useAuth();
    const [tab, setTab] = useState(loadInitialView);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readString(LS_SIDEBAR, '0') === '1');
    const [hiddenSet, setHiddenSet] = useState(() => readHiddenSet());
    const [openTile, setOpenTile] = useState(null);
    const [openTileKind, setOpenTileKind] = useState('letterheads');
    const [submitError, setSubmitError] = useState(null);

    useEffect(() => writeString(LS_VIEW, tab), [tab]);
    useEffect(() => writeString(LS_SIDEBAR, sidebarCollapsed ? '1' : '0'), [sidebarCollapsed]);

    const clientPagesByNorm = usePackagePagesMap();
    const { tiles, errors, loadError, loadedAt, reload: reloadTiles } = useTiles();
    const { options, error: buError, selected: buSelected, toggle, selectAll, clear: clearBu } = useBuOptions();

    const { status, running, submitError: runStatusError, submit } = useRunStatus({
        onIdle: () => {
            reloadTiles();
        }
    });

    useEffect(() => {
        setSubmitError(runStatusError);
    }, [runStatusError]);

    // Cross-tab sync: pick up hidden-set changes from other windows.
    useEffect(() => {
        const onStorage = (e) => {
            if (e.key === LS_HIDDEN) setHiddenSet(readHiddenSet());
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    const visibleTiles = useMemo(() => tiles.filter((t) => !hiddenSet.has(String(t.id))), [tiles, hiddenSet]);
    const hiddenCount = hiddenSet.size;

    const handleSubmit = useCallback(
        async (body) => {
            setSubmitError(null);
            const r = await submit(body);
            if (!r.ok && r.error) setSubmitError(String(r.error));
        },
        [submit]
    );

    const handleClearLedger = useCallback(() => {
        if (!visibleTiles.length) {
            if (window.confirm('No visible tiles. Restore previously hidden tiles from localStorage?')) {
                clearHiddenSet();
                setHiddenSet(new Set());
            }
            return;
        }
        if (!window.confirm(`Hide all ${visibleTiles.length} tile(s)? Files in /out are kept.`)) return;
        const next = new Set(hiddenSet);
        for (const t of visibleTiles) next.add(String(t.id));
        writeHiddenSet(next);
        setHiddenSet(next);
    }, [visibleTiles, hiddenSet]);

    const restoreHidden = useCallback(() => {
        clearHiddenSet();
        setHiddenSet(new Set());
        reloadTiles();
    }, [reloadTiles]);

    const statusPill = useMemo(() => {
        if (running) return { kind: 'running', text: 'running' };
        if (status && typeof status.exitCode === 'number') {
            return status.exitCode === 0 ? { kind: 'ok', text: 'success' } : { kind: 'err', text: 'error' };
        }
        return null;
    }, [running, status]);

    const fanOut = (status && (status.fanOut || status.lastFanOut)) || null;
    const showFanOut = running ? !!fanOut : false;

    if (authRequired && authLoading) {
        return <div className="role-gate-loading muted small">Checking access…</div>;
    }
    if (authRequired && !user) {
        // Auth wired but user not signed in — login page lands in admin-page todo.
        return (
            <main style={{ padding: '2rem', maxWidth: 480, margin: '0 auto' }}>
                <h1 className="wordmark" style={{ marginTop: '3rem' }}>
                    Stellar Matter
                </h1>
                <p className="muted">Sign-in screen ships in the admin-panel phase.</p>
            </main>
        );
    }

    const indexFor = (tile) => visibleTiles.findIndex((t) => String(t.id) === String(tile.id)) + 1;

    return (
        <>
            <Topbar
                currentTab={tab}
                onTabChange={setTab}
                statusPill={statusPill}
                lastUpdated={loadedAt}
                sidebarCollapsed={sidebarCollapsed}
                onToggleSidebar={() => setSidebarCollapsed((c) => !c)}
            />
            <div className={`app-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
                <RunSidebar
                    collapsed={sidebarCollapsed}
                    buOptions={{ options, error: buError }}
                    buSelected={buSelected}
                    buActions={{ toggle, selectAll, clear: clearBu }}
                    busy={running}
                    onSubmit={handleSubmit}
                    onClearLedger={handleClearLedger}
                />
                <main className="main-pane tile-wall-outer">
                    {showFanOut && <RunProgress payload={fanOut} />}
                    {!showFanOut && running && <RunProgress fallbackText="Starting run…" />}
                    {(submitError || loadError || errors.length > 0) && (
                        <div className="results-error nexus-card">
                            {submitError || loadError ||
                                `Tile load: ${errors.map((e) => `${e.file}: ${e.error}`).join(' \u00b7 ')}`}
                        </div>
                    )}

                    {tab === 'letterheads' && (
                        <section className="tabpanel" data-metric-kind="letterheads">
                            <TileWall
                                tiles={visibleTiles}
                                kind="letterheads"
                                hiddenCount={hiddenCount}
                                clientPagesByNorm={clientPagesByNorm}
                                onRestoreHidden={restoreHidden}
                                onOpen={(t) => {
                                    setOpenTile(t);
                                    setOpenTileKind('letterheads');
                                }}
                            />
                        </section>
                    )}

                    {tab === 'envelopes' && (
                        <section className="tabpanel" data-metric-kind="envelopes">
                            <TileWall
                                tiles={visibleTiles}
                                kind="envelopes"
                                hiddenCount={hiddenCount}
                                clientPagesByNorm={clientPagesByNorm}
                                onRestoreHidden={restoreHidden}
                                onOpen={(t) => {
                                    setOpenTile(t);
                                    setOpenTileKind('envelopes');
                                }}
                            />
                        </section>
                    )}

                    {tab === 'history' && (
                        <section className="tabpanel tabpanel-history">
                            <div className="card history-card">
                                <h2 className="card-title-demoted">Run history</h2>
                                <p className="muted small">
                                    The full history pane (sortable list + per-run JSON viewer) lives in the
                                    legacy dashboard at <code>/legacy</code>. It will be ported here once the
                                    Phase 8 Postgres-backed runs table lands.
                                </p>
                            </div>
                        </section>
                    )}
                </main>
            </div>

            {openTile && (
                <RunModal
                    tile={openTile}
                    kind={openTileKind}
                    indexFromOne={indexFor(openTile) || 1}
                    clientPagesByNorm={clientPagesByNorm}
                    onClose={() => setOpenTile(null)}
                />
            )}
        </>
    );
}
