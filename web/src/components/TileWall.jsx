import { Tile } from './Tile.jsx';

// Strict tab scoping. Letter Heads + Envelopes show only general runs; Urine
// and EDTA tabs show only their specialty mode tiles.
function tileMatchesTab(tile, kind) {
    const mode = tile.mode || 'general';
    if (kind === 'urine_containers') return mode === 'urine_containers';
    if (kind === 'edta_vials') return mode === 'edta_vials';
    if (kind === 'citrate_vials') return mode === 'citrate_vials';
    return mode !== 'urine_containers' && mode !== 'edta_vials' && mode !== 'citrate_vials';
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
                    ) : kind === 'edta_vials' ? (
                        <>
                            <p className="tile-empty-lead">
                                No <strong>EDTA vial</strong> runs yet. Start one from the run panel — the run will
                                auto-pin <code>he011, he022, he006, he055, bi127</code> and count each SID once across
                                all five assays.
                            </p>
                            <p className="muted small">
                                Five parallel Listec calls per BU, unioned by SID.
                            </p>
                        </>
                    ) : kind === 'citrate_vials' ? (
                        <>
                            <p className="tile-empty-lead">
                                No <strong>Citrate</strong> runs yet. Start one from the run panel — the run will
                                auto-pin <code>he030, he004, he016, hem001</code> and count each SID once.
                            </p>
                            <p className="muted small">Four parallel Listec calls per BU, unioned by SID.</p>
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
