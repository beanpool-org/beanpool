import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';
import fs from 'node:fs';

let resolvedVersion = process.env.APP_VERSION;
if (!resolvedVersion) {
    try {
        const rootPkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8'));
        resolvedVersion = rootPkg.version;
    } catch {
        resolvedVersion = '1.2.15';
    }
}

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
