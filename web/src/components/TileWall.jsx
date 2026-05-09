import { Tile } from './Tile.jsx';

// Strict tab scoping. Letter Heads + Envelopes show only general runs; each
// specialty tab (Urine / EDTA / Citrate / S.Heparin / L.Heparin) shows only
// its own mode tiles. The general tabs explicitly exclude every specialty mode.
const SPECIALTY_MODES = new Set([
    'urine_containers',
    'edta_vials',
    'citrate_vials',
    's_heparin',
    'l_heparin'
]);

function tileMatchesTab(tile, kind) {
    const mode = tile.mode || 'general';
    if (SPECIALTY_MODES.has(kind)) return mode === kind;
    return !SPECIALTY_MODES.has(mode);
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
                    ) : kind === 's_heparin' ? (
                        <>
                            <p className="tile-empty-lead">
                                No <strong>S.Heparin</strong> runs yet. Start one from the run panel — the run will
                                auto-pin <code>ky004, cp3257</code> and count each SID once.
                            </p>
                            <p className="muted small">Two parallel Listec calls per BU, unioned by SID.</p>
                        </>
                    ) : kind === 'l_heparin' ? (
                        <>
                            <p className="tile-empty-lead">
                                No <strong>L.Heparin</strong> runs yet. Start one from the run panel — the run will
                                auto-pin <code>ms091</code> through the SID-dedup pipeline.
                            </p>
                            <p className="muted small">One Listec call per BU; same dedup contract as the multi-code modes.</p>
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
