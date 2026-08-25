import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
    base: './',
    build: {
        outDir: '../server/public/manager',
        emptyOutDir: true,
    },
    plugins: [react()],
    resolve: {
        alias: {
            '@beanpool/core': path.resolve(__dirname, '../../packages/beanpool-core/src/index.ts'),
        }
    },
    server: {
        port: 3001,
        proxy: {
            '^/proxy/(https?)/([^/]+)/(.*)': {
                target: 'http://localhost',
                changeOrigin: true,
                router: (req) => {
                    const match = req.url?.match(/^\/proxy\/(https?)\/([^/]+)\/(.*)/);
                    if (match) {
                        return `${match[1]}://${match[2]}`;
                    }
                    return 'http://localhost';
                },
                rewrite: (path) => path.replace(/^\/proxy\/(https?)\/([^/]+)\//, '/'),
            },
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
    test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: './src/setupTests.ts',
    }
});
