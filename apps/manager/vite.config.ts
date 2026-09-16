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
        },
        dedupe: ['react', 'react-dom'],
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
                        const rawAuthority = match[2].toLowerCase();
                        const cleanHost = rawAuthority.startsWith('[')
                            ? (rawAuthority.match(/^\[([^\]]+)\]/)?.[1] || rawAuthority)
                            : rawAuthority.split(':')[0];

                        // Block the cloud instance-metadata endpoints, which is the SSRF target
                        // that actually matters here: link-local (169.254.0.0/16 covers AWS/GCP/
                        // Azure metadata, 100.100.100.100 covers Alibaba Cloud metadata) plus the
                        // metadata hostnames and IPv6/mapped variants.
                        //
                        // Loopback and RFC1918 are deliberately NOT blocked. Every node the
                        // manager talks to that is not its own origin goes through this proxy
                        // (see resolveNodeApiUrl), and the default profile is the local node at
                        // https://localhost:8443 — blocking those makes the dashboard unable to
                        // reach the local node or any node on the operator's LAN.
                        const isBlocked = cleanHost.includes('169.254.') ||
                            cleanHost === '100.100.100.100' ||
                            cleanHost === 'metadata.google.internal' ||
                            cleanHost === 'metadata' ||
                            cleanHost.endsWith('.internal');
                        if (isBlocked) {
                            return 'http://localhost';
                        }
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
