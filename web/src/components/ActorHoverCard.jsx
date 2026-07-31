import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '../apiClient.js';

// Profiles are keyed by actor id (falling back to username for rows from
// failed logins, which have no resolved user). Module-level so sweeping the
// mouse down a column of the same user hits the network once.
const profileCache = new Map();

export function describeUserAgent(ua) {
    if (!ua) return null;
    const s = String(ua);
    const browser =
        (/Edg\/([\d.]+)/.exec(s) && `Edge ${/Edg\/([\d.]+)/.exec(s)[1].split('.')[0]}`) ||
        (/OPR\/([\d.]+)/.exec(s) && `Opera ${/OPR\/([\d.]+)/.exec(s)[1].split('.')[0]}`) ||
        (/Firefox\/([\d.]+)/.exec(s) && `Firefox ${/Firefox\/([\d.]+)/.exec(s)[1].split('.')[0]}`) ||
        (/Chrome\/([\d.]+)/.exec(s) && `Chrome ${/Chrome\/([\d.]+)/.exec(s)[1].split('.')[0]}`) ||
        (/Version\/([\d.]+).*Safari/.exec(s) &&
            `Safari ${/Version\/([\d.]+).*Safari/.exec(s)[1].split('.')[0]}`) ||
        (/curl\/([\d.]+)/i.test(s) && 'curl') ||
        null;
    const os =
        (/Windows NT 10/.test(s) && 'Windows') ||
        (/Windows/.test(s) && 'Windows') ||
        (/iPhone|iPad|iOS/.test(s) && 'iOS') ||
        (/Android/.test(s) && 'Android') ||
        (/Mac OS X/.test(s) && 'macOS') ||
        (/Linux/.test(s) && 'Linux') ||
        null;
    if (browser && os) return `${browser} on ${os}`;
    return browser || os || null;
}

export function formatGeo(geo) {
    if (!geo) return null;
    if (geo.scope === 'private') return geo.label || 'Internal network';
    if (geo.label) return geo.label;
    const bits = [geo.city, geo.region, geo.country].filter(Boolean);
    return bits.length ? bits.join(', ') : null;
}

function fmtTime(iso) {
    if (!iso) return '—';
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return String(iso);
    }
}

async function loadProfile(key, params) {
    if (profileCache.has(key)) return profileCache.get(key);
    const promise = (async () => {
        const r = await apiFetch(`/api/admin/audit-log/actor?${params.toString()}`);
        if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            throw new Error(j.error || `HTTP ${r.status}`);
        }
        return r.json();
    })();
    profileCache.set(key, promise);
    // A failed lookup shouldn't be cached forever — drop it so a later hover retries.
    promise.catch(() => profileCache.delete(key));
    return promise;
}

/**
 * Username cell that reveals the identity behind an audit entry on hover:
 * the IP and resolved location for *this* action, plus the account's overall
 * footprint (addresses used, first/last seen, recent actions).
 */
export function ActorHoverCard({ entry }) {
    const label = entry.actor_username || entry.actor_id || 'anonymous';
    const cacheKey = entry.actor_id || `username:${entry.actor_username || ''}`;
    const [open, setOpen] = useState(false);
    const [pinned, setPinned] = useState(false);
    const [profile, setProfile] = useState(null);
    const [error, setError] = useState(null);
    const [pos, setPos] = useState(null);
    const triggerRef = useRef(null);
    const openTimer = useRef(null);
    const closeTimer = useRef(null);

    const hasActor = Boolean(entry.actor_id || entry.actor_username);

    const place = useCallback(() => {
        const el = triggerRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const width = 340;
        const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
        // Flip above the row when there isn't room below.
        const below = window.innerHeight - r.bottom;
        setPos({ left, top: below > 300 ? r.bottom + 8 : Math.max(8, r.top - 308), width, flipped: below <= 300 });
    }, []);

    const show = useCallback(() => {
        clearTimeout(closeTimer.current);
        openTimer.current = setTimeout(() => {
            place();
            setOpen(true);
        }, 120);
    }, [place]);

    const hide = useCallback(() => {
        clearTimeout(openTimer.current);
        closeTimer.current = setTimeout(() => {
            if (!pinned) setOpen(false);
        }, 180);
    }, [pinned]);

    useEffect(
        () => () => {
            clearTimeout(openTimer.current);
            clearTimeout(closeTimer.current);
        },
        []
    );

    useEffect(() => {
        if (!open || !hasActor || profile || error) return;
        let cancelled = false;
        const params = new URLSearchParams();
        if (entry.actor_id) params.set('actor_id', entry.actor_id);
        else params.set('username', entry.actor_username);
        loadProfile(cacheKey, params)
            .then((j) => {
                if (!cancelled) setProfile(j);
            })
            .catch((e) => {
                if (!cancelled) setError(String(e.message || e));
            });
        return () => {
            cancelled = true;
        };
    }, [open, hasActor, profile, error, cacheKey, entry.actor_id, entry.actor_username]);

    useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => {
            if (e.key === 'Escape') {
                setPinned(false);
                setOpen(false);
            }
        };
        const onScroll = () => place();
        document.addEventListener('keydown', onKey);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onScroll);
        return () => {
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onScroll);
        };
    }, [open, place]);

    const entryLocation = useMemo(() => formatGeo(entry.geo), [entry.geo]);
    const device = useMemo(() => describeUserAgent(entry.user_agent), [entry.user_agent]);

    return (
        <span className="audit-actor-wrap">
            <button
                type="button"
                ref={triggerRef}
                className={`audit-actor${open ? ' is-open' : ''}`}
                aria-expanded={open ? 'true' : 'false'}
                onMouseEnter={show}
                onMouseLeave={hide}
                onFocus={show}
                onBlur={hide}
                onClick={() => {
                    place();
                    setPinned((v) => !v);
                    setOpen(true);
                }}
            >
                {label}
            </button>
            {open &&
                pos &&
                createPortal(
                    <div
                        className="audit-hovercard nexus-card"
                        style={{ left: pos.left, top: pos.top, width: pos.width }}
                        onMouseEnter={() => clearTimeout(closeTimer.current)}
                        onMouseLeave={() => {
                            setPinned(false);
                            setOpen(false);
                        }}
                        role="dialog"
                        aria-label={`Details for ${label}`}
                    >
                        <div className="audit-hovercard-head">
                            <span className="audit-hovercard-name">
                                {profile && profile.actor && profile.actor.account
                                    ? profile.actor.account.display_name
                                    : label}
                            </span>
                            {profile && profile.actor && profile.actor.account && (
                                <span className="env-chip env-small">{profile.actor.account.role}</span>
                            )}
                        </div>

                        <dl className="audit-hovercard-grid">
                            <dt>IP</dt>
                            <dd>{entry.ip || '—'}</dd>
                            <dt>Location</dt>
                            <dd>{entryLocation || 'Unresolved'}</dd>
                            {entry.geo && entry.geo.isp && (
                                <>
                                    <dt>Network</dt>
                                    <dd>{entry.geo.isp}</dd>
                                </>
                            )}
                            {entry.geo && entry.geo.timezone && (
                                <>
                                    <dt>Timezone</dt>
                                    <dd>{entry.geo.timezone}</dd>
                                </>
                            )}
                            <dt>Device</dt>
                            <dd>{device || 'Unknown client'}</dd>
                            <dt>This action</dt>
                            <dd>
                                {entry.action} · {fmtTime(entry.created_at)}
                            </dd>
                        </dl>

                        {!hasActor && <p className="muted small">No account attached to this entry.</p>}

                        {hasActor && !profile && !error && <p className="muted small">Loading profile…</p>}
                        {error && <p className="muted small">Could not load profile: {error}</p>}

                        {profile && profile.stats && (
                            <>
                                <p className="eyebrow-lite">Footprint</p>
                                <p className="muted small">
                                    {profile.stats.total_events} action
                                    {profile.stats.total_events === 1 ? '' : 's'} ·{' '}
                                    {profile.stats.failed_events} failed · {profile.stats.distinct_ips} IP
                                    {profile.stats.distinct_ips === 1 ? '' : 's'}
                                </p>
                                <p className="muted small">
                                    First seen {fmtTime(profile.stats.first_seen)} · last seen{' '}
                                    {fmtTime(profile.stats.last_seen)}
                                </p>
                            </>
                        )}

                        {profile && profile.addresses && profile.addresses.length > 0 && (
                            <>
                                <p className="eyebrow-lite">Recent addresses</p>
                                <ul className="audit-hovercard-list">
                                    {profile.addresses.map((a) => (
                                        <li key={a.ip}>
                                            <code>{a.ip}</code>
                                            <span className="muted small">
                                                {formatGeo(a.geo) || 'Unresolved'} · {a.events}×
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </>
                        )}

                        {profile && profile.recent && profile.recent.length > 0 && (
                            <>
                                <p className="eyebrow-lite">Latest actions</p>
                                <ul className="audit-hovercard-list">
                                    {profile.recent.map((a) => (
                                        <li key={a.id}>
                                            <code>{a.action}</code>
                                            <span className="muted small">
                                                {a.outcome === 'failure' ? 'failed · ' : ''}
                                                {fmtTime(a.created_at)}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </>
                        )}
                    </div>,
                    document.body
                )}
        </span>
    );
}
