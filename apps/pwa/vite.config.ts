import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';
import fs from 'node:fs';

// The version the bundle displays when the node's /api/community/health is unreachable.
// Order matters: the CI build arg wins, then the workspace root package.json (the single
// source of truth the release bump moves), then this app's own package.json. No hardcoded
// literal here — one would silently bake a stale version into every later release.
function resolvePkgVersion(pkgPath: string): string | undefined {
    try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        return typeof pkg.version === 'string' ? pkg.version : undefined;
    } catch {
        return undefined;
    }
}

const resolvedVersion =
    process.env.APP_VERSION ||
    resolvePkgVersion(path.resolve(__dirname, '../../package.json')) ||
    resolvePkgVersion(path.resolve(__dirname, 'package.json')) ||
    '0.0.0';

export default defineConfig({
    define: {
        __APP_VERSION__: JSON.stringify(resolvedVersion),
    },
    plugins: [
        react(),
        VitePWA({
            registerType: 'autoUpdate',
            selfDestroying: true, // Disable service worker until offline caching is properly configured
            includeAssets: ['favicon.svg'],
            manifest: {
                name: 'BeanPool — Federated Mesh',
                short_name: 'BeanPool',
                description: 'Local-first independent community marketplace',
                theme_color: '#0a0a0a',
                background_color: '#0a0a0a',
                display: 'standalone',
                start_url: '/',
                icons: [
                    {
                        src: '/icon-192x192.png',
                        sizes: '192x192',
                        type: 'image/png',
                        purpose: 'any',
                    },
                    {
                        src: '/icon-512x512.png',
                        sizes: '512x512',
                        type: 'image/png',
                        purpose: 'any maskable',
                    },
                ],
            },
        }),
    ],
    server: {
        host: true,
        proxy: {
            '/api': {
                target: 'https://localhost:8443',
                secure: false,
                changeOrigin: true
            },
            '/ws': {
                target: 'wss://localhost:8443',
                secure: false,
                ws: true,
                changeOrigin: true
            }
        }
    },
    build: {
        outDir: path.resolve(__dirname, '../server/public'),
        emptyOutDir: true,
    },
    test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: './src/setupTests.ts',
    }
});
