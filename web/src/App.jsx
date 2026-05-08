/**
 * Phase-2 scaffold placeholder. The full TileWall / RunSidebar / RunModal
 * port from scripts/lis-nav-bot/public/{index.html,app.js,styles.css}
 * happens in the next todo (`react-vite-port`). This shell exists so the
 * Vite dev server boots and the auth context can resolve.
 */
export function App() {
    return (
        <main style={{ padding: '2rem', maxWidth: 880, margin: '0 auto' }}>
            <h1 style={{ fontWeight: 700, letterSpacing: '-0.02em' }}>Stellar Matter</h1>
            <p style={{ color: 'rgb(var(--nx-ink-2))' }}>
                React + Vite scaffold. The legacy editorial dashboard is still served at
                {' '}<code>/</code> via <code>scripts/lis-nav-bot/server.js</code> until the next
                phase ports the components into <code>web/src/components</code>.
            </p>
            <p style={{ color: 'rgb(var(--nx-ink-3))', fontSize: '0.85rem' }}>
                Tokens loaded:
                {' '}
                <span style={{ color: 'rgb(var(--nx-accent))' }}>--nx-accent</span> ·
                <span style={{ color: 'rgb(var(--nx-ink-2))' }}> --nx-ink-2</span>
            </p>
        </main>
    );
}
