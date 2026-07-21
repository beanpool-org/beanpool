import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@beanpool/core': path.resolve(__dirname, '../../packages/beanpool-core/src/index.ts'),
        }
    },
    server: {
        port: 3001,
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
    }
});
