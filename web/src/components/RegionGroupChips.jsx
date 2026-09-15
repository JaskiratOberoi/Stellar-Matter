/**
 * Regions: temporary sub-units defined in the server's business-unit-groups
 * file. Each chip runs an explicit client-code list through the by-codes SP;
 * a residual chip (`residual: true`) runs its parent unit minus its sibling
 * regions. Selection is kept apart from the BU chips so "All" up there never
 * double-counts a parent and its regions.
 *
 * @param {{
 *   groups: { id: string, label: string, name: string|null, parent: string|null, codeCount: number, residual?: boolean, subtract?: string[] }[],
 *   selected: Set<string>,
 *   onToggle: (id: string) => void,
 *   onSelectAll: () => void,
 *   onClear: () => void,
 * }} props
 */
export function RegionGroupChips({ groups, selected, onToggle, onSelectAll, onClear }) {
    if (!groups.length) return null;
    const title = (g) => {
        const n = g.codeCount || 0;
        if (g.residual) {
            return `${g.name || g.label}\n${g.parent} minus ${(g.subtract || []).join(', ')} (${n} client codes taken out)`;
        }
        return `${g.name || g.label}\n${n} client code${n === 1 ? '' : 's'}${g.parent ? ` · part of ${g.parent}` : ''}`;
    };
    return (
        <div className="field-block bu-field-block region-group-field-block">
            <div className="row-between bu-chip-toolbar">
                <span className="eyebrow-lite field-label">Regions</span>
                <div className="chip-tool-group">
                    <button type="button" className="chip chip-tool" onClick={onSelectAll}>
                        All
                    </button>
                    <button type="button" className="chip chip-tool" disabled={selected.size === 0} onClick={onClear}>
                        Clear
                    </button>
                </div>
            </div>
            <div className="chip-grid" role="group" aria-label="Region chips">
                {groups.map((g) => (
                    <button
                        key={g.id}
                        type="button"
                        className={`chip bu-chip region-group-chip${g.residual ? ' is-residual' : ''}`}
                        aria-pressed={selected.has(g.id) ? 'true' : 'false'}
                        title={title(g)}
                        onClick={() => onToggle(g.id)}
                    >
                        {g.label}
                        {g.residual && <span className="region-group-tag">rest of {g.parent}</span>}
                    </button>
                ))}
            </div>
        </div>
    );
}
