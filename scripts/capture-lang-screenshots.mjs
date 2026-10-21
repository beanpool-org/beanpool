import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const WEBSITE_DIR = path.join(REPO_ROOT, 'apps', 'website');
const SCREENSHOT_DIR = path.join(REPO_ROOT, 'docs', 'screenshots', 'website-lang-button');

const require = createRequire(path.join(REPO_ROOT, 'apps/pwa/package.json'));
const { chromium } = require('playwright');

const TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
    '.json': 'application/json'
};

async function main() {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

    const server = http.createServer((req, res) => {
        let p = path.join(WEBSITE_DIR, decodeURIComponent(new URL(req.url, 'http://x').pathname));
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
        if (!fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
        fs.createReadStream(p).pipe(res);
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const browser = await chromium.launch({ headless: true });

    const configs = [
        { lang: 'en', path: 'index.html' },
        { lang: 'ar', path: 'ar/index.html' },
        { lang: 'ja', path: 'ja/index.html' }
    ];

    try {
        for (const config of configs) {
            for (const theme of ['light', 'dark']) {
                const context = await browser.newContext({
                    viewport: { width: 360, height: 720 },
                    colorScheme: theme
                });
                const page = await context.newPage();
                await page.goto(`http://127.0.0.1:${port}/${config.path}`, { waitUntil: 'load' });

                // Open the phone menu
                await page.locator('.nav-menu > summary').click();
                await page.waitForTimeout(100);

                // Open the phone language menu
                await page.locator('.phone-lang-menu > summary').click();
                await page.waitForTimeout(150);

                const outPath = path.join(SCREENSHOT_DIR, `360px-${config.lang}-${theme}.png`);
                await page.screenshot({ path: outPath, fullPage: false });
                console.log(`Saved screenshot: ${outPath}`);
                await context.close();
            }
        }
    } finally {
        await browser.close();
        server.close();
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
