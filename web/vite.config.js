import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo root (parent of /web) — env at the root drives both server and SPA proxy.
const repoRoot = path.join(__dirname, '..');

function buildApiProxy(env) {
    // Phase 2 still proxies to the legacy CommonJS server (default :4377). Once
    // Phase 4 lands, the Docker app container exposes :4378 and we read
    // MATTER_APP_PORT instead — that override path is honoured here.
    const port = String(env.MATTER_APP_PORT || env.LIS_UI_PORT || env.PORT || env.VITE_API_PORT || '4377').trim() || '4377';
    const target = `http://127.0.0.1:${port}`;
    const opts = { target, changeOrigin: true, secure: false };
    return {
        '/api': opts,
        // Inventory proof-of-goods photos are served by the backend at this
        // top-level path (not under /api), so the dev proxy needs it too or
        // <img src="/inventory-photos/..."> would 404 against Vite.
        '/inventory-photos': opts,
        // Purchase-order PI PDFs, same arrangement.
        '/inventory-docs': opts
    };
}

export default defineConfig(({ mode }) => {
    // Root `.env` (DATABASE_URL, etc.) + `web/.env*` so devs can set MATTER_APP_PORT
    // in web/.env.development when the Matter API runs in Docker on :4378 instead of :4377.
    const env = { ...loadEnv(mode, repoRoot, ''), ...loadEnv(mode, __dirname, '') };
    const apiProxy = buildApiProxy(env);

    return {
        plugins: [
            react(),
            VitePWA({
                registerType: 'prompt',
                includeAssets: [
                    'favicon.svg',
                    'apple-touch-icon.png',
                    'pwa-192x192.png',
                    'pwa-512x512.png',
                    'pwa-512x512-maskable.png'
                ],
                manifest: {
                    name: 'Stellar Matter',
                    short_name: 'Inventory',
                    description: 'Inventory tracker and Tracer for Qugen Pathlabs materials.',
                    theme_color: '#0A0A0A',
                    background_color: '#0A0A0A',
                    display: 'standalone',
                    orientation: 'any',
                    scope: '/',
                    start_url: '/',
                    lang: 'en',
                    categories: ['business', 'productivity'],
                    icons: [
                        {
                            src: 'pwa-192x192.png',
                            sizes: '192x192',
                            type: 'image/png'
                        },
                        {
                            src: 'pwa-512x512.png',
                            sizes: '512x512',
                            type: 'image/png'
                        },
                        {
                            src: 'pwa-512x512-maskable.png',
                            sizes: '512x512',
                            type: 'image/png',
                            purpose: 'maskable'
                        }
                    ]
                },
                workbox: {
                    navigateFallback: '/index.html',
                    // Skip auth endpoints so login never serves a stale offline response.
                    navigateFallbackDenylist: [/^\/api\//],
                    globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,webmanifest}']
                    // Do not runtime-cache cross-origin API calls — Workbox NetworkFirst
                    // turns timeouts and offline states into opaque "no-response" failures
                    // that surface as NetworkError / CORS in the console on mobile.
                },
                devOptions: {
                    // Keep SW off in `vite` HMR; enable only for production builds /
                    // `vite preview` so installability can be verified there.
                    enabled: false
                }
            })
        ],
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
