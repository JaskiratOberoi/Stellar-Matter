import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Topbar } from './components/Topbar.jsx';
import { RunSidebar } from './components/RunSidebar.jsx';
import { TileWall } from './components/TileWall.jsx';
import { RunModal } from './components/RunModal.jsx';
import { RunProgress } from './components/RunProgress.jsx';
import { RoleGate } from './components/RoleGate.jsx';
import { LoginPage } from './pages/LoginPage.jsx';
import { AdminUsersPage } from './pages/AdminUsersPage.jsx';
import { AdminAuditLogPage } from './pages/AdminAuditLogPage.jsx';
import { AdminOrgsPage } from './pages/AdminOrgsPage.jsx';
import { TracerPage } from './pages/TracerPage.jsx';
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
    if (
        raw === 'history' ||
        raw === 'envelopes' ||
        raw === 'letterheads' ||
        raw === 'urine_containers' ||
        raw === 'edta_vials' ||
        raw === 'citrate_vials'
    )
        return raw;
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
            return r;
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
        return (
            <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="*" element={<Navigate to="/login" replace />} />
            </Routes>
        );
    }

    const indexFor = (tile) => visibleTiles.findIndex((t) => String(t.id) === String(tile.id)) + 1;

    const tracerView = (
        <>
            <Topbar
                currentTab={tab}
                onTabChange={setTab}
                statusPill={statusPill}
                lastUpdated={loadedAt}
                sidebarCollapsed={sidebarCollapsed}
                onToggleSidebar={() => setSidebarCollapsed((c) => !c)}
                onOrgSwitched={() => {
                    reloadTiles();
                }}
            />
            <main className="main-pane tracer-main">
                <TracerPage
                    tiles={tiles}
                    visibleTiles={visibleTiles}
                    reloadTiles={reloadTiles}
                    submit={handleSubmit}
                    running={running}
                    clientPagesByNorm={clientPagesByNorm}
                    buOptions={{ options, error: buError }}
                    buSelected={buSelected}
                    buActions={{ toggle, selectAll, clear: clearBu }}
                    loadError={loadError}
                    errors={errors}
                    submitError={submitError}
                />
            </main>
        </>
    );

    const dashboard = (
        <>
            <Topbar
                currentTab={tab}
                onTabChange={setTab}
                statusPill={statusPill}
                lastUpdated={loadedAt}
                sidebarCollapsed={sidebarCollapsed}
                onToggleSidebar={() => setSidebarCollapsed((c) => !c)}
                onOrgSwitched={() => {
                    // Switching org changes which tiles the server returns; refetch.
                    reloadTiles();
                }}
            />
            <div className={`app-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
                <RunSidebar
                    collapsed={sidebarCollapsed}
                    buOptions={{ options, error: buError }}
                    buSelected={buSelected}
                    buActions={{ toggle, selectAll, clear: clearBu }}
                    busy={running}
                    mode={
                        tab === 'urine_containers'
                            ? 'urine_containers'
                            : tab === 'edta_vials'
                              ? 'edta_vials'
                              : tab === 'citrate_vials'
                                ? 'citrate_vials'
                                : 'general'
                    }
                    sqlOnlyLocked={Boolean(authRequired && user && user.role === 'admin')}
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

                    {tab === 'urine_containers' && (
                        <section className="tabpanel" data-metric-kind="urine_containers">
                            <TileWall
                                tiles={visibleTiles}
                                kind="urine_containers"
                                hiddenCount={hiddenCount}
                                clientPagesByNorm={clientPagesByNorm}
                                onRestoreHidden={restoreHidden}
                                onOpen={(t) => {
                                    setOpenTile(t);
                                    setOpenTileKind('urine_containers');
                                }}
                            />
                        </section>
                    )}

                    {tab === 'edta_vials' && (
                        <section className="tabpanel" data-metric-kind="edta_vials">
                            <TileWall
                                tiles={visibleTiles}
                                kind="edta_vials"
                                hiddenCount={hiddenCount}
                                clientPagesByNorm={clientPagesByNorm}
                                onRestoreHidden={restoreHidden}
                                onOpen={(t) => {
                                    setOpenTile(t);
                                    setOpenTileKind('edta_vials');
                                }}
                            />
                        </section>
                    )}

                    {tab === 'citrate_vials' && (
                        <section className="tabpanel" data-metric-kind="citrate_vials">
                            <TileWall
                                tiles={visibleTiles}
                                kind="citrate_vials"
                                hiddenCount={hiddenCount}
                                clientPagesByNorm={clientPagesByNorm}
                                onRestoreHidden={restoreHidden}
                                onOpen={(t) => {
                                    setOpenTile(t);
                                    setOpenTileKind('citrate_vials');
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

    return (
        <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
                path="/admin/users"
                element={
                    <RoleGate roles={['super_admin']}>
                        <AdminUsersPage />
                    </RoleGate>
                }
            />
            <Route
                path="/admin/audit-log"
                element={
                    <RoleGate roles={['super_admin']}>
                        <AdminAuditLogPage />
                    </RoleGate>
                }
            />
            <Route
                path="/admin/orgs"
                element={
                    <RoleGate roles={['super_admin']}>
                        <AdminOrgsPage />
                    </RoleGate>
                }
            />
            <Route path="/" element={dashboard} />
            <Route path="/tracer" element={tracerView} />
            <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
    );
}
