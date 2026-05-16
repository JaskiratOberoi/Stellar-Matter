import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo root (parent of /web) — env at the root drives both server and SPA proxy.
const repoRoot = path.join(__dirname, '..');

function buildApiProxy(env) {
    // Phase 2 still proxies to the legacy CommonJS server (default :4377). Once
    // Phase 4 lands, the Docker app container exposes :4378 and we read
    // MATTER_APP_PORT instead — that override path is honoured here.
    const port = String(env.MATTER_APP_PORT || env.LIS_UI_PORT || env.PORT || env.VITE_API_PORT || '4377').trim() || '4377';
    const target = `http://127.0.0.1:${port}`;
    return {
        '/api': {
            target,
            changeOrigin: true,
            secure: false
        }
    };
}

export default defineConfig(({ mode }) => {
    // Root `.env` (DATABASE_URL, etc.) + `web/.env*` so devs can set MATTER_APP_PORT
    // in web/.env.development when the Matter API runs in Docker on :4378 instead of :4377.
    const env = { ...loadEnv(mode, repoRoot, ''), ...loadEnv(mode, __dirname, '') };
    const apiProxy = buildApiProxy(env);

    return {
        plugins: [react()],
        server: {
            port: 5174,
            fs: { allow: ['..'] },
            proxy: apiProxy
        },
        // `vite preview` does not inherit `server.proxy` unless restated here — without it /api/* 404s.
        preview: {
            proxy: apiProxy
        },
        build: {
            outDir: 'dist',
            emptyOutDir: true
        }
    };
});
