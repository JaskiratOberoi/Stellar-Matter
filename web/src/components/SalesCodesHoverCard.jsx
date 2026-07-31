import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '../apiClient.js';

// Keyed by salesperson id. Module-level so sweeping across the chip grid, or
// re-hovering a chip, doesn't refetch a mapping that rarely changes.
const codesCache = new Map();

/**
 * Whether this device has a real hovering pointer.
 *
 * Touch browsers still emit `mouseenter` on tap, so without this check a
 * single tap meant to select a chip would also pop the card open — and with no
 * pointer to move away, it would sit there. On touch the card is reached by
 * long press instead.
 */
const CAN_HOVER =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(hover: hover) and (pointer: fine)').matches
        : true;

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
    // A card opened by long press has to stay put until dismissed: there is no
    // pointer to leave the chip, and the tap that closes it must not toggle
    // the chip's selection.
    const [pinned, setPinned] = useState(false);
    const [data, setData] = useState(/** @type {null | { codes: string[], clientsByCode: object }} */ (null));
    const [error, setError] = useState(/** @type {string | null} */ (null));
    const [pos, setPos] = useState(/** @type {null | { left: number, top: number, width: number }} */ (null));
    const triggerRef = useRef(null);
    const cardRef = useRef(null);
    const openTimer = useRef(null);
    const closeTimer = useRef(null);
    const longPressTimer = useRef(null);
    const touchStart = useRef(/** @type {null | { x: number, y: number }} */ (null));
    /** Set when a long press opened the card, so the trailing click is dropped. */
    const suppressClick = useRef(false);

    const place = useCallback(() => {
        const el = triggerRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        // Phones are narrower than the desktop card; fit the viewport instead
        // of letting it run off the right edge.
        const width = Math.min(320, window.innerWidth - 16);
        const height = 300;
        const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - width - 8));
        const below = window.innerHeight - r.bottom;
        setPos({
            left,
            top: below > height + 16 ? r.bottom + 6 : Math.max(8, r.top - height - 6),
            width
        });
    }, []);

    const openNow = useCallback(() => {
        place();
        setOpen(true);
    }, [place]);

    const show = useCallback(() => {
        if (pinned || !CAN_HOVER) return;
        clearTimeout(closeTimer.current);
        openTimer.current = setTimeout(openNow, 140);
    }, [openNow, pinned]);

    // Keyboard focus should reveal the card even on a touch device; a tap that
    // merely focuses the chip should not. :focus-visible draws that line.
    const showOnKeyboardFocus = useCallback(
        (e) => {
            if (pinned) return;
            try {
                if (!e.currentTarget.matches(':focus-visible')) return;
            } catch {
                if (!CAN_HOVER) return;
            }
            clearTimeout(closeTimer.current);
            openTimer.current = setTimeout(openNow, 140);
        },
        [openNow, pinned]
    );

    const hide = useCallback(() => {
        if (pinned) return;
        clearTimeout(openTimer.current);
        closeTimer.current = setTimeout(() => setOpen(false), 160);
    }, [pinned]);

    const dismiss = useCallback(() => {
        clearTimeout(openTimer.current);
        clearTimeout(closeTimer.current);
        setPinned(false);
        setOpen(false);
    }, []);

    // Touch devices have no hover, so a press held past the threshold opens
    // the card. Movement beyond a few pixels means the user is scrolling the
    // chip grid, not inspecting a chip.
    const onTouchStart = useCallback(
        (e) => {
            const t = e.touches && e.touches[0];
            touchStart.current = t ? { x: t.clientX, y: t.clientY } : null;
            suppressClick.current = false;
            clearTimeout(longPressTimer.current);
            longPressTimer.current = setTimeout(() => {
                suppressClick.current = true;
                setPinned(true);
                openNow();
            }, 450);
        },
        [openNow]
    );

    const onTouchMove = useCallback((e) => {
        const start = touchStart.current;
        const t = e.touches && e.touches[0];
        if (!start || !t) return;
        if (Math.abs(t.clientX - start.x) > 8 || Math.abs(t.clientY - start.y) > 8) {
            clearTimeout(longPressTimer.current);
        }
    }, []);

    const onTouchEnd = useCallback(() => {
        clearTimeout(longPressTimer.current);
    }, []);

    useEffect(
        () => () => {
            clearTimeout(openTimer.current);
            clearTimeout(closeTimer.current);
            clearTimeout(longPressTimer.current);
        },
        []
    );

    // Tap anywhere outside dismisses a pinned card — the mobile equivalent of
    // moving the pointer away.
    useEffect(() => {
        if (!pinned || !open) return undefined;
        const onDown = (e) => {
            const card = cardRef.current;
            const trigger = triggerRef.current;
            if (card && card.contains(e.target)) return;
            if (trigger && trigger.contains(e.target)) return;
            dismiss();
        };
        document.addEventListener('pointerdown', onDown, true);
        return () => document.removeEventListener('pointerdown', onDown, true);
    }, [pinned, open, dismiss]);

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
            if (e.key === 'Escape') dismiss();
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
    }, [open, place, dismiss]);

    const codes = data ? data.codes : null;

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                className={`chip bu-chip sales-chip${selected ? ' is-selected' : ''}`}
                aria-pressed={selected ? 'true' : 'false'}
                onClick={() => {
                    if (suppressClick.current) {
                        suppressClick.current = false;
                        return;
                    }
                    if (pinned) {
                        dismiss();
                        return;
                    }
                    onToggle();
                }}
                onMouseEnter={show}
                onMouseLeave={hide}
                onFocus={showOnKeyboardFocus}
                onBlur={hide}
                onTouchStart={onTouchStart}
                onTouchMove={onTouchMove}
                onTouchEnd={onTouchEnd}
                onTouchCancel={onTouchEnd}
                onContextMenu={(e) => {
                    // Android fires the context menu at the same threshold as
                    // our long press; the card is the intended result.
                    if (pinned) e.preventDefault();
                }}
            >
                {user.label}
                {user.codeCount != null ? <span className="region-chip-count">{user.codeCount}</span> : null}
            </button>
            {open &&
                pos &&
                createPortal(
                    <div
                        ref={cardRef}
                        className="sales-codes-hovercard nexus-card"
                        style={{ left: pos.left, top: pos.top, width: pos.width }}
                        onMouseEnter={() => clearTimeout(closeTimer.current)}
                        onMouseLeave={() => {
                            if (!pinned) setOpen(false);
                        }}
                        role="dialog"
                        aria-label={`Client codes for ${user.label}`}
                    >
                        <div className="sales-codes-head">
                            <span className="sales-codes-name">{user.label}</span>
                            <span className="muted small">
                                {codes ? `${codes.length} code${codes.length === 1 ? '' : 's'}` : 'Mapped codes'}
                            </span>
                            {pinned ? (
                                <button
                                    type="button"
                                    className="sales-codes-close"
                                    onClick={dismiss}
                                    aria-label="Close code list"
                                >
                                    ✕
                                </button>
                            ) : null}
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
