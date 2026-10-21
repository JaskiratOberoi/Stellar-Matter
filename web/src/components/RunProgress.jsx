import { useEffect, useRef, useState } from 'react';

const STATE_LABEL = { done: 'done', running: 'running', failed: 'failed', cancelled: 'cancelled' };

function fmtElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Live run status: a determinate bar (finished / total), a summary line with
 * elapsed time, and one pill per scope coloured by state. Without a fan-out
 * payload yet, it shows the fallback text over an indeterminate shimmer.
 */
export function RunProgress({ payload, fallbackText, onCancel, cancelling, cancelDisabled }) {
    // Elapsed counts from when this page first saw the run.
    const startRef = useRef(Date.now());
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, []);

    if (!payload && !fallbackText) return null;
    const items = payload && Array.isArray(payload.items) ? payload.items : [];
    const total = items.length;
    const count = (st) => items.filter((it) => it.state === st).length;
    const done = count('done');
    const failed = count('failed');
    const cancelled = count('cancelled');
    const finished = done + failed + cancelled;
    const pct = total ? Math.round((finished / total) * 100) : 0;

    return (
        <div className="run-progress-wrap">
            {total ? (
                <div
                    className="run-progress-meter"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={total}
                    aria-valuenow={finished}
                    aria-label="Tracer run progress"
                >
                    <span style={{ width: `${pct}%` }} />
                </div>
            ) : (
                <div className="run-progress-bar" aria-hidden="true" />
            )}
            <div className="run-progress-strip" aria-live="polite">
                <span className="run-progress-summary">
                    {total ? (
                        <>
                            <strong>Running</strong> · {done} of {total} done
                            {failed ? <span className="run-progress-bad"> · {failed} failed</span> : null}
                            {cancelled ? ` · ${cancelled} cancelled` : null}
                        </>
                    ) : (
                        fallbackText
                    )}
                    <span className="run-progress-time"> · {fmtElapsed(now - startRef.current)}</span>
                </span>
                {onCancel ? (
                    <button
                        type="button"
                        className="run-progress-cancel"
                        onClick={onCancel}
                        disabled={cancelDisabled || cancelling}
                        title="Abort the running query. Scopes already finished keep their results."
                    >
                        {cancelling ? 'Stopping…' : 'Stop run'}
                    </button>
                ) : null}
            </div>
            {total > 0 && (
                <ul className="run-progress-pills">
                    {items.map((it, i) => {
                        const st = STATE_LABEL[it.state] ? it.state : 'queued';
                        return (
                            <li key={`${it.bu}:${i}`} className={`run-pill is-${st}`} title={it.error ? `${it.bu}: ${it.error}` : `${it.bu}: ${STATE_LABEL[st] || 'queued'}`}>
                                <span className="run-pill-dot" aria-hidden="true" />
                                {it.bu || '—'}
                                <span className="visually-hidden"> ({STATE_LABEL[st] || 'queued'})</span>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
