import { Tile } from './Tile.jsx';

// Strict tab scoping. Letter Heads + Envelopes show only general (mode='general'
// or undefined for legacy artefacts) runs; Urine Containers shows only runs
// produced by the urine-container mode (POST /api/run with mode=urine_containers,
// which auto-pins testCode = cp004 OR mb034 in lib/sql-source.js).
function tileMatchesTab(tile, kind) {
    const mode = tile.mode || 'general';
    if (kind === 'urine_containers') return mode === 'urine_containers';
    return mode !== 'urine_containers';
}

export function TileWall({ tiles, kind, hiddenCount, onRestoreHidden, onOpen, clientPagesByNorm }) {
    const filtered = tiles.filter((t) => tileMatchesTab(t, kind));
    if (!filtered.length) {
        return (
            <div className="tile-wall">
                <div className="tile-empty nexus-card">
                    {kind === 'envelopes' ? (
                        <>
                            <p className="tile-empty-lead">
                                No runs in view. <strong>Envelopes</strong> count one per package occurrence — <em>big</em>{' '}
                                when pages-per-report &gt; 10, <em>small</em> otherwise.
                            </p>
                            <p className="muted small">
                                Same source data as Letter Heads, different lens. Click any tile for the per-package
                                envelope breakdown.
                            </p>
                        </>
                    ) : kind === 'urine_containers' ? (
                        <>
                            <p className="tile-empty-lead">
                                No <strong>urine container</strong> runs yet. Start one from the run panel — the run will
                                auto-pin <code>testCode = cp004 OR mb034</code> and count one container per unique SID.
                            </p>
                            <p className="muted small">
                                Two parallel Listec calls per BU, unioned by SID so a patient who ordered both tests
                                still counts as one container.
                            </p>
                        </>
                    ) : (
                        <>
                            <p className="tile-empty-lead">
                                No runs in view. Start a <strong>SQL</strong> or <strong>package scrape</strong> run — each
                                completed job becomes a Letter Head tile here.
                            </p>
                            <p className="muted small">
                                Tiles are rebuilt from <code>out/run-*</code> on every load. Tile big number = total
                                printed pages across all packages.
                            </p>
                        </>
                    )}
                    {hiddenCount > 0 && (
                        <p className="restore-hidden-wrap">
                            <button type="button" className="chip chip-tool" onClick={onRestoreHidden}>
                                Restore {hiddenCount} hidden run{hiddenCount === 1 ? '' : 's'}
                            </button>
                        </p>
                    )}
                </div>
            </div>
        );
    }
    return (
        <div className="tile-wall">
            <div className="tile-grid">
                {filtered.map((tile, i) => (
                    <Tile
                        key={tile.id}
                        tile={tile}
                        kind={kind}
                        indexFromOne={i + 1}
                        clientPagesByNorm={clientPagesByNorm}
                        onOpen={onOpen}
                    />
                ))}
            </div>
            {hiddenCount > 0 && (
                <p className="restore-hidden-wrap">
                    <button type="button" className="chip chip-tool" onClick={onRestoreHidden}>
                        Restore {hiddenCount} hidden run{hiddenCount === 1 ? '' : 's'}
                    </button>
                </p>
            )}
        </div>
    );
}
