import { Tile } from './Tile.jsx';

export function TileWall({ tiles, kind, hiddenCount, onRestoreHidden, onOpen, clientPagesByNorm }) {
    if (!tiles.length) {
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
                {tiles.map((tile, i) => (
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
