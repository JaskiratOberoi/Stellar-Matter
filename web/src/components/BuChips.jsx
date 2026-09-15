/**
 * @param {{ id: string, label: string, parent: string|null, name: string|null, codeCount: number }} g
 */
function groupTitle(g) {
    const head = g.name || `${g.label} group`;
    const n = g.codeCount || 0;
    return `${head}\n${n} client code${n === 1 ? '' : 's'}${g.parent ? ` · nested under ${g.parent}` : ''}\nNot included in "All" — the parent unit already covers these clients.`;
}

export function BuChips({
    source,
    options,
    selected,
    onToggle,
    onSelectAll,
    onClear,
    lookupError,
    freeTextField,
    groups = [],
    groupSelected = new Set(),
    onToggleGroup
}) {
    const wantSql = source === 'sql';
    const showFallback = !wantSql || options.length === 0;
    // Groups sit right after their parent chip; a parent that is not in the
    // list (renamed unit, or lookups down) still shows its groups at the end.
    const parentLabels = new Set(options.map((o) => o.label));
    const groupsByParent = new Map();
    const orphanGroups = [];
    for (const g of groups) {
        if (g.parent && parentLabels.has(g.parent)) {
            if (!groupsByParent.has(g.parent)) groupsByParent.set(g.parent, []);
            groupsByParent.get(g.parent).push(g);
        } else {
            orphanGroups.push(g);
        }
    }
    const renderGroup = (g) => (
        <button
            key={`group:${g.id}`}
            type="button"
            className="chip bu-chip bu-group-chip"
            aria-pressed={groupSelected.has(g.id) ? 'true' : 'false'}
            title={groupTitle(g)}
            onClick={() => onToggleGroup && onToggleGroup(g.id)}
        >
            <span className="bu-group-arrow" aria-hidden="true">↳</span>
            {g.label}
            <span className="bu-group-tag">temp</span>
        </button>
    );
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
                    {options.map((opt) => [
                        <button
                            key={opt.id}
                            type="button"
                            className="chip bu-chip"
                            aria-pressed={selected.has(opt.label) ? 'true' : 'false'}
                            title={opt.title}
                            onClick={() => onToggle(opt.label)}
                        >
                            {opt.label}
                        </button>,
                        ...(groupsByParent.get(opt.label) || []).map(renderGroup)
                    ])}
                    {orphanGroups.map(renderGroup)}
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
