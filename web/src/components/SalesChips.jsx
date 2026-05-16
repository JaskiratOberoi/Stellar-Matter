/**
 * @param {{
 *   users: { userId: number, label: string, codeCount?: number }[],
 *   loading: boolean,
 *   lookupError: string | null,
 *   selectedIds: Set<string>,
 *   onToggle: (userId: string, label: string) => void,
 *   onClear: () => void,
 * }} props
 */
export function SalesChips({ users, loading, lookupError, selectedIds, onToggle, onClear }) {
    return (
        <div className="field-block bu-field-block sales-field-block">
            <div className="row-between bu-chip-toolbar">
                <span className="eyebrow-lite field-label">Sales (Sales &amp; Marketing)</span>
                <div className="chip-tool-group">
                    <button
                        type="button"
                        className="chip chip-tool"
                        disabled={selectedIds.size === 0}
                        onClick={onClear}
                    >
                        Clear
                    </button>
                </div>
            </div>
            {loading && <p className="muted small">Loading sales users…</p>}
            {!loading && users.length > 0 && (
                <div className="chip-grid" role="group" aria-label="Salesperson chips">
                    {users.map((u) => {
                        const id = String(u.userId);
                        const sel = selectedIds.has(id);
                        const cc = u.codeCount != null ? ` ${u.codeCount}` : '';
                        return (
                            <button
                                key={id}
                                type="button"
                                className={`chip bu-chip${sel ? ' is-selected' : ''}`}
                                aria-pressed={sel ? 'true' : 'false'}
                                onClick={() => onToggle(id, u.label)}
                                title={`Mapped client codes:${cc}`}
                            >
                                {u.label}
                                {u.codeCount != null ? (
                                    <span className="region-chip-count">{u.codeCount}</span>
                                ) : null}
                            </button>
                        );
                    })}
                </div>
            )}
            {!loading && !lookupError && users.length === 0 && (
                <p className="muted small">No Sales and Marketing users with mapped codes.</p>
            )}
            {lookupError && (
                <p className="muted small bu-lookup-msg">
                    Could not load sales users ({lookupError}).
                </p>
            )}
        </div>
    );
}
