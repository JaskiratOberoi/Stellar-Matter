import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Topbar } from './components/Topbar.jsx';
import { RoleGate } from './components/RoleGate.jsx';
import { InstallPrompt } from './components/InstallPrompt.jsx';
import { LoginPage } from './pages/LoginPage.jsx';
import { AdminUsersPage } from './pages/AdminUsersPage.jsx';
import { AdminAuditLogPage } from './pages/AdminAuditLogPage.jsx';
import { AdminOrgsPage } from './pages/AdminOrgsPage.jsx';
import { InventoryPage } from './pages/InventoryPage.jsx';
import { TracerPage } from './pages/TracerPage.jsx';
import { useAuth } from './contexts/AuthContext.jsx';
import { useTiles } from './hooks/useTiles.js';
import { useBuOptions } from './hooks/useBuOptions.js';
import { useRunStatus } from './hooks/useRunStatus.js';
import { usePackagePagesMap } from './hooks/usePackagePagesMap.js';
import { LS_HIDDEN, readHiddenSet } from './lib/storage.js';
import './styles/app.css';

/**
 * Inventory is the home screen. Tracer is a secondary tool mounted at
 * /tracer, so its run polling, tile loads and Listec-backed lookups only
 * start once someone actually opens it — the inventory home never pays for
 * them.
 */
export function App() {
    const { authRequired, user, loading: authLoading } = useAuth();

    if (authRequired && authLoading) {
        return <div className="role-gate-loading muted small">Checking access…</div>;
    }
    if (authRequired && !user) {
        return (
            <>
                <Routes>
                    <Route path="/login" element={<LoginPage />} />
                    <Route path="*" element={<Navigate to="/login" replace />} />
                </Routes>
                <InstallPrompt />
            </>
        );
    }

    const inventoryView = (
        <>
            <Topbar onOrgSwitched={() => {}} />
            <InventoryPage key={user?.active_org_id || 'inventory'} />
        </>
    );

    return (
        <>
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
                <Route path="/tracer" element={<TracerRoute />} />
                <Route path="/" element={inventoryView} />
                {/* Legacy entry points: the old tile dashboard and the pre-swap inventory path. */}
                <Route path="/dashboard" element={<Navigate to="/tracer" replace />} />
                <Route path="/inventory" element={<Navigate to="/" replace />} />
                <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            <InstallPrompt />
        </>
    );
}

function TracerRoute() {
    const [hiddenSet, setHiddenSet] = useState(() => readHiddenSet());
    const [submitError, setSubmitError] = useState(null);

    const clientPagesByNorm = usePackagePagesMap();
    const { tiles, errors, loadError, loadedAt, reload: reloadTiles } = useTiles();
    const {
        options,
        groups: buGroups,
        error: buError,
        selected: buSelected,
        groupSelected: buGroupSelected,
        toggle,
        toggleGroup,
        selectAll,
        clear: clearBu,
        selectAllGroups,
        clearGroups
    } = useBuOptions();

    const {
        status,
        running,
        submitError: runStatusError,
        submit,
        cancel,
        cancelling
    } = useRunStatus({
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

    const handleSubmit = useCallback(
        // Forward `opts` so callers can override the target endpoint — e.g.
        // TracerPage POSTs to '/api/tracer-run' to fan out 6 modes × N BUs in
        // one Listec call. Dropping opts here previously fell back to
        // '/api/run' and ran the legacy single-mode flow with no bucketing,
        // producing empty Urine/EDTA/Citrate/SHeparin/LHeparin tiles.
        async (body, opts) => {
            setSubmitError(null);
            const r = await submit(body, opts);
            if (!r.ok && r.error) setSubmitError(String(r.error));
            return r;
        },
        [submit]
    );

    // The pill reflects the LAST FINISHED run, held in server memory until the
    // next run starts — a red "error" could be hours old. Carry the run's start
    // time in the text so it reads as a dated record, not a live alarm.
    const statusPill = useMemo(() => {
        if (running) return { kind: 'running', text: 'running' };
        if (status && typeof status.exitCode === 'number') {
            const at = status.startedAt ? new Date(status.startedAt) : null;
            const when =
                at && !Number.isNaN(at.getTime())
                    ? ` · ${at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
                    : '';
            return status.exitCode === 0
                ? { kind: 'ok', text: `last run ok${when}` }
                : { kind: 'err', text: `last run failed${when}` };
        }
        return null;
    }, [running, status]);

    const fanOut = (status && (status.fanOut || status.lastFanOut)) || null;

    return (
        <>
            <Topbar
                statusPill={statusPill}
                lastUpdated={loadedAt}
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
                    runFanOut={fanOut}
                    onCancelRun={cancel}
                    cancelling={cancelling}
                    cancellable={!!(status && status.cancellable)}
                    clientPagesByNorm={clientPagesByNorm}
                    buOptions={{ options, groups: buGroups, error: buError }}
                    buSelected={buSelected}
                    buGroupSelected={buGroupSelected}
                    buActions={{ toggle, toggleGroup, selectAll, clear: clearBu, selectAllGroups, clearGroups }}
                    loadError={loadError}
                    errors={errors}
                    submitError={submitError}
                />
            </main>
        </>
    );
}
