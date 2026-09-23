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
        emptyOutDir: false,
    },
    test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: './src/setupTests.ts',
        // CI runs four suites across two cores, and a test that takes 400 ms here has been
        // measured 17x slower under that contention (#1063). Both limits are set well above
        // the worst time measured under load — the slowest passing test in the suite is 427 ms
        // — rather than trimmed to fit it, because the point is headroom, not a tighter fit.
        // The wait that actually expires on CI is React Testing Library's, not this one; see
        // asyncUtilTimeout in src/setupTests.ts. This pair is the backstop behind it, and is
        // deliberately larger so a genuinely stuck wait still fails with RTL's message and DOM
        // dump instead of a bare "test timed out" that says nothing about what was missing.
        testTimeout: 30_000,
        hookTimeout: 30_000,
        alias: {
            'react': path.resolve(__dirname, '../../node_modules/react'),
            'react-dom': path.resolve(__dirname, '../../node_modules/react-dom'),
        },
        // CI only. One four-vCPU runner hosts build, lint, test and typecheck at once, and vitest
        // otherwise sizes its pool from the machine's cores — five packages each doing that is what
        // starved these suites into failing on a stopwatch. See scripts/test-all.sh. Uncapped locally.
        minWorkers: process.env.CI ? 1 : undefined,
        maxWorkers: process.env.CI ? 2 : undefined,
    }
});
