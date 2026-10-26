import { useId } from 'react';

/**
 * The Stellar Infinity mark: the rounded double-helix figure-8, the same
 * shape and gradient as Infinity's own brand mark, as Biosentry and Sense
 * draw it on everything that came from Infinity. Sized by className or the
 * size prop; the viewBox is cropped to the figure.
 */
export function InfinityMark({ className, size, title = 'Stellar Infinity' }) {
    // useId contains colons, which are invalid in url(#…) references.
    const grad = `inf-mk-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`;
    const h = size ? Number(size) : undefined;
    const w = h ? Math.round(h * (388 / 112)) : undefined;
    return (
        <svg
            viewBox="46 64 388 112"
            width={w}
            height={h}
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            role="img"
            aria-label={title}
            className={className}
            preserveAspectRatio="xMidYMid meet"
        >
            <defs>
                <linearGradient id={grad} x1="0" y1="0" x2="480" y2="240" gradientUnits="userSpaceOnUse">
                    <stop offset="0%" stopColor="#22d3ee" />
                    <stop offset="50%" stopColor="#2dd4bf" />
                    <stop offset="100%" stopColor="#60a5fa" />
                </linearGradient>
            </defs>
            <path
                d="M96,92 L96,148 M132,78 L132,162 M168,92 L168,148 M312,92 L312,148 M348,78 L348,162 M384,92 L384,148"
                stroke="rgba(45,212,191,.5)"
                strokeWidth="10"
                strokeLinecap="round"
            />
            <path
                d="M60,120 C60,182 170,182 240,120 C310,58 420,58 420,120"
                stroke="rgba(45,212,191,.55)"
                strokeWidth="22"
                strokeLinecap="round"
                fill="none"
            />
            <path
                d="M60,120 C60,58 170,58 240,120 C310,182 420,182 420,120"
                stroke={`url(#${grad})`}
                strokeWidth="22"
                strokeLinecap="round"
                fill="none"
            />
        </svg>
    );
}

/**
 * "via Infinity · username · centre · region" — the tag a request raised
 * from Stellar Infinity carries in the list and the panel.
 */
export function InfinitySourceTag({ meta, compact = false }) {
    const m = meta || {};
    // A centre's login IS its client code, so one of the two is enough.
    const sameAsUser = m.clientCode && m.username && m.clientCode.toLowerCase() === m.username.toLowerCase();
    const where = [sameAsUser ? null : m.clientCode, m.region || m.state || m.city].filter(Boolean).join(' · ');
    return (
        <span className="mreq-src" title={`Raised from Stellar Infinity by ${m.displayName || m.username || 'an Infinity user'}${where ? ` · ${where}` : ''}`}>
            <InfinityMark className="mreq-src-mark" />
            <span>Infinity</span>
            {!compact && m.username && <span className="mreq-src-who">{m.username}</span>}
            {!compact && where && <span className="mreq-src-where">{where}</span>}
        </span>
    );
}
