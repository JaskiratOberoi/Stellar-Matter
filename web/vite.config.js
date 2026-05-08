import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo root (parent of /web) — env at the root drives both server and SPA proxy.
const repoRoot = path.join(__dirname, '..');

function buildApiProxy(env) {
    const port = String(env.MATTER_APP_PORT || env.PORT || env.VITE_API_PORT || '4378').trim() || '4378';
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
    const env = loadEnv(mode, repoRoot, '');
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
