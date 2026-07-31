/** App mark — inventory stock grid (matches public/favicon.svg). */
export function BrandMark({ size = 32, className, title = 'Stellar Matter' }) {
    const s = Number(size) || 32;
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 32 32"
            width={s}
            height={s}
            fill="none"
            className={className}
            role="img"
            aria-label={title}
        >
            <rect width="32" height="32" rx="7" fill="#0A0A0A"/>
            <path d="M7 22.5h18" stroke="#D4FF3A" strokeWidth="1.75" strokeLinecap="round"/>
            <rect x="8" y="15" width="6.5" height="7" rx="1.25" stroke="#D4FF3A" strokeWidth="1.65"/>
            <rect x="16.5" y="11" width="6.5" height="11" rx="1.25" stroke="#D4FF3A" strokeWidth="1.65"/>
            <path
                d="M10.2 18.2l1.3 1.3 2.4-2.4"
                stroke="#D4FF3A"
                strokeWidth="1.45"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <path
                d="M19 14.2v2.2M19 18.4v2.2"
                stroke="#D4FF3A"
                strokeWidth="1.35"
                strokeLinecap="round"
                opacity="0.9"
            />
        </svg>
    );
}
