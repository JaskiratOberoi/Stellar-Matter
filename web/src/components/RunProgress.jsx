export function RunProgress({ payload, fallbackText }) {
    if (!payload && !fallbackText) return null;
    return (
        <div className="run-progress-wrap">
            <div className="run-progress-bar" aria-hidden="true" />
            <div className="run-progress-strip eyebrow-lite" aria-live="polite">
                {payload ? <FanOutLine payload={payload} /> : fallbackText}
            </div>
        </div>
    );
}

function FanOutLine({ payload }) {
    const items = Array.isArray(payload.items) ? payload.items : [];
    const total = items.length;
    const done = items.filter((it) => it.state === 'done').length;
    const cells = items
        .map((it) => {
            const mark =
                it.state === 'done'
                    ? '\u2713'
                    : it.state === 'running'
                      ? '\u23f3'
                      : it.state === 'failed'
                        ? '\u00d7'
                        : '\u2026';
            return `${it.bu || '\u2014'} ${mark}`;
        })
        .join(' \u00b7 ');
    return (
        <span>
            {`${done}/${total}`} {cells}
        </span>
    );
}
