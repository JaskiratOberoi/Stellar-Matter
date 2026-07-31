import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '../apiClient.js';

// Keyed by salesperson id. Module-level so sweeping across the chip grid, or
// re-hovering a chip, doesn't refetch a mapping that rarely changes.
const codesCache = new Map();

async function loadCodes(userId) {
    if (codesCache.has(userId)) return codesCache.get(userId);
    const promise = (async () => {
        const r = await apiFetch(
            `/api/tracer/sales-marketing-users/codes?detail=1&ids=${encodeURIComponent(userId)}`
        );
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        const codes = (j.codesByUser && j.codesByUser[String(userId)]) || [];
        return { codes, clientsByCode: j.clientsByCode || {} };
    })();
    codesCache.set(userId, promise);
    promise.catch(() => codesCache.delete(userId));
    return promise;
}

/**
 * Salesperson chip that reveals the client codes mapped to that user on hover.
 *
 * The chip itself only carries a count, and a count is not enough to tell
 * whether a scope covers the clients you expect. Codes are fetched on first
 * hover rather than upfront: the grid holds ~150 users and some map to
 * hundreds of codes each, so loading it all with the page would be a large
 * payload nobody reads.
 *
 * @param {{
 *   user: { userId: number, label: string, codeCount?: number },
 *   selected: boolean,
 *   onToggle: () => void,
 * }} props
 */
export function SalesCodesHoverCard({ user, selected, onToggle }) {
    const [open, setOpen] = useState(false);
    const [data, setData] = useState(/** @type {null | { codes: string[], clientsByCode: object }} */ (null));
    const [error, setError] = useState(/** @type {string | null} */ (null));
    const [pos, setPos] = useState(/** @type {null | { left: number, top: number, width: number }} */ (null));
    const triggerRef = useRef(null);
    const openTimer = useRef(null);
    const closeTimer = useRef(null);

    const place = useCallback(() => {
        const el = triggerRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const width = 320;
        const height = 300;
        const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
        const below = window.innerHeight - r.bottom;
        setPos({
            left,
            top: below > height + 16 ? r.bottom + 6 : Math.max(8, r.top - height - 6),
            width
        });
    }, []);

    const show = useCallback(() => {
        clearTimeout(closeTimer.current);
        openTimer.current = setTimeout(() => {
            place();
            setOpen(true);
        }, 140);
    }, [place]);

    const hide = useCallback(() => {
        clearTimeout(openTimer.current);
        closeTimer.current = setTimeout(() => setOpen(false), 160);
    }, []);

    useEffect(
        () => () => {
            clearTimeout(openTimer.current);
            clearTimeout(closeTimer.current);
        },
        []
    );

    useEffect(() => {
        if (!open || data || error) return undefined;
        let cancelled = false;
        loadCodes(user.userId)
            .then((j) => {
                if (!cancelled) setData(j);
            })
            .catch((e) => {
                if (!cancelled) setError(String(e.message || e));
            });
        return () => {
            cancelled = true;
        };
    }, [open, data, error, user.userId]);

    useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => {
            if (e.key === 'Escape') setOpen(false);
        };
        const reposition = () => place();
        document.addEventListener('keydown', onKey);
        window.addEventListener('scroll', reposition, true);
        window.addEventListener('resize', reposition);
        return () => {
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('scroll', reposition, true);
            window.removeEventListener('resize', reposition);
        };
    }, [open, place]);

    const codes = data ? data.codes : null;

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                className={`chip bu-chip${selected ? ' is-selected' : ''}`}
                aria-pressed={selected ? 'true' : 'false'}
                onClick={onToggle}
                onMouseEnter={show}
                onMouseLeave={hide}
                onFocus={show}
                onBlur={hide}
            >
                {user.label}
                {user.codeCount != null ? <span className="region-chip-count">{user.codeCount}</span> : null}
            </button>
            {open &&
                pos &&
                createPortal(
                    <div
                        className="sales-codes-hovercard nexus-card"
                        style={{ left: pos.left, top: pos.top, width: pos.width }}
                        onMouseEnter={() => clearTimeout(closeTimer.current)}
                        onMouseLeave={() => setOpen(false)}
                        role="dialog"
                        aria-label={`Client codes for ${user.label}`}
                    >
                        <div className="sales-codes-head">
                            <span className="sales-codes-name">{user.label}</span>
                            <span className="muted small">
                                {codes ? `${codes.length} code${codes.length === 1 ? '' : 's'}` : 'Mapped codes'}
                            </span>
                        </div>
                        {!codes && !error && <p className="muted small">Loading codes…</p>}
                        {error && <p className="muted small">Could not load codes: {error}</p>}
                        {codes && codes.length === 0 && (
                            <p className="muted small">No client codes mapped to this user.</p>
                        )}
                        {codes && codes.length > 0 && (
                            <ul className="sales-codes-list">
                                {codes.map((code) => {
                                    const meta = data.clientsByCode[String(code).toUpperCase()];
                                    const where = meta
                                        ? [meta.city, meta.state].filter(Boolean).join(', ')
                                        : '';
                                    return (
                                        <li key={code}>
                                            <code>{code}</code>
                                            <span className="muted small">
                                                {meta && meta.name ? meta.name : 'Not in client mirror'}
                                                {where ? ` · ${where}` : ''}
                                            </span>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>,
                    document.body
                )}
        </>
    );
}
