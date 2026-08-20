import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const testingLibPath = path.dirname(require.resolve('@testing-library/react/package.json'));
const reactPath = path.dirname(require.resolve('react/package.json', { paths: [testingLibPath] }));
const reactDomPath = path.dirname(require.resolve('react-dom/package.json', { paths: [testingLibPath] }));

export default defineConfig({
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
    resolve: {
        dedupe: ['react', 'react-dom'],
        alias: {
            '@beanpool/core': path.resolve(__dirname, '../../packages/beanpool-core/src/index.ts'),
            'react': reactPath,
            'react-dom': reactDomPath,
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
        server: {
            deps: {
                inline: ['react', 'react-dom', '@testing-library/react'],
            },
        },
    },
});
