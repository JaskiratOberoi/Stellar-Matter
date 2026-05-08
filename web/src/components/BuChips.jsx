export function BuChips({ source, options, selected, onToggle, onSelectAll, onClear, lookupError, freeTextField }) {
    const wantSql = source === 'sql';
    const showFallback = !wantSql || options.length === 0;
    return (
        <div className="field-block bu-field-block">
            <div className="row-between bu-chip-toolbar">
                <span className="eyebrow-lite field-label">Business units</span>
                <div className="chip-tool-group">
                    <button
                        type="button"
                        className="chip chip-tool"
                        disabled={!wantSql || !options.length}
                        onClick={onSelectAll}
                    >
                        All
                    </button>
                    <button
                        type="button"
                        className="chip chip-tool"
                        disabled={!wantSql || selected.size === 0}
                        onClick={onClear}
                    >
                        Clear
                    </button>
                </div>
            </div>
            {wantSql && options.length > 0 && (
                <div className="chip-grid" role="group" aria-label="Business unit chips">
                    {options.map((opt) => (
                        <button
                            key={opt.id}
                            type="button"
                            className="chip bu-chip"
                            aria-pressed={selected.has(opt.label) ? 'true' : 'false'}
                            onClick={() => onToggle(opt.label)}
                        >
                            {opt.label}
                        </button>
                    ))}
                </div>
            )}
            {lookupError && (
                <p className="muted small bu-lookup-msg">
                    Could not reach Listec lookups ({lookupError}); using free-text BU.
                </p>
            )}
            {showFallback && (
                <label className="bu-fallback-label">
                    BU (text) {freeTextField}
                </label>
            )}
        </div>
    );
}
