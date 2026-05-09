import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../apiClient.js';

/**
 * Polls /api/run/status while a run is active. Returns the latest status
 * object plus a `submit(body)` callback that POSTs /api/run and starts polling.
 *
 * `onIdle` fires once each time the server transitions back to idle after a
 * run we kicked off (used by App.jsx to refresh tiles + history).
 */
export function useRunStatus({ onIdle } = {}) {
    const [status, setStatus] = useState(null);
    const [running, setRunning] = useState(false);
    const [submitError, setSubmitError] = useState(null);
    const pollTimer = useRef(null);
    const wasRunningRef = useRef(false);
    // Ref pattern keeps `tick`'s identity stable across App re-renders even
    // when callers pass an inline `onIdle: () => reloadTiles()`. Without this,
    // every App render produced a new `onIdle` → new `tick` → the
    // mount-effect below fired again → an immediate /api/run/status poll on
    // every render, multiplied by every state update from those polls. Result
    // was a tight loop hammering the API. Polling now happens exactly once on
    // mount + at the 1.5 s interval while a run is active.
    const onIdleRef = useRef(onIdle);
    useEffect(() => {
        onIdleRef.current = onIdle;
    }, [onIdle]);

    const stopPolling = useCallback(() => {
        if (pollTimer.current) {
            clearInterval(pollTimer.current);
            pollTimer.current = null;
        }
    }, []);

    const tick = useCallback(async () => {
        try {
            const r = await apiFetch('/api/run/status');
            const j = await r.json();
            setStatus(j);
            const isRun = j && j.state === 'running';
            setRunning(!!isRun);
            if (!isRun) {
                stopPolling();
                if (wasRunningRef.current && typeof onIdleRef.current === 'function') {
                    onIdleRef.current(j);
                }
                wasRunningRef.current = false;
            } else {
                wasRunningRef.current = true;
            }
        } catch {
            /* swallow — next tick retries */
        }
    }, [stopPolling]);

    const startPolling = useCallback(() => {
        if (pollTimer.current) return;
        pollTimer.current = setInterval(tick, 1500);
    }, [tick]);

    useEffect(() => {
        tick();
        return stopPolling;
    }, [tick, stopPolling]);

    const submit = useCallback(
        /**
         * @param {object} body
         * @param {{ endpoint?: string }} [opts] - override target endpoint (e.g.
         *   the Tracer page POSTs to '/api/tracer-run' so a single call kicks
         *   off all 6 modes × N BUs in one go). Defaults to '/api/run' so the
         *   dashboard's per-mode runs are unchanged.
         */
        async (body, opts = {}) => {
            setSubmitError(null);
            const endpoint = opts.endpoint || '/api/run';
            try {
                const r = await apiFetch(endpoint, {
                    method: 'POST',
                    body: JSON.stringify(body)
                });
                const j = await r.json().catch(() => ({}));
                if (r.status === 409) {
                    setSubmitError(j.error || 'Server busy');
                    return { ok: false, busy: true, error: j.error };
                }
                if (!r.ok) {
                    setSubmitError(j.error ? String(j.error) : `HTTP ${r.status}`);
                    return { ok: false, error: j.error };
                }
                setRunning(true);
                wasRunningRef.current = true;
                await tick();
                startPolling();
                return { ok: true, response: j };
            } catch (e) {
                setSubmitError(String(e));
                return { ok: false, error: String(e) };
            }
        },
        [tick, startPolling]
    );

    return { status, running, submitError, submit, refresh: tick };
}
