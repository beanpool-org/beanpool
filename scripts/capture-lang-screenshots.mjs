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
        { lang: 'pt', path: 'pt/index.html' },
        { lang: 'ta', path: 'ta/index.html' },
        { lang: 'ar', path: 'ar/index.html' }
    ];

    try {
        for (const config of configs) {
            for (const theme of ['light', 'dark']) {
                // 360px mobile screenshot
                const mobileContext = await browser.newContext({
                    viewport: { width: 360, height: 720 },
                    colorScheme: theme
                });
                const mobilePage = await mobileContext.newPage();
                await mobilePage.goto(`http://127.0.0.1:${port}/${config.path}`, { waitUntil: 'load' });

                // Open the phone menu
                await mobilePage.locator('.nav-menu > summary').click();
                await mobilePage.waitForTimeout(100);

                const mobileOutPath = path.join(SCREENSHOT_DIR, `360px-${config.lang}-${theme}.png`);
                await mobilePage.screenshot({ path: mobileOutPath, fullPage: false });
                console.log(`Saved screenshot: ${mobileOutPath}`);
                await mobileContext.close();

                // 1280px desktop screenshot
                const desktopContext = await browser.newContext({
                    viewport: { width: 1280, height: 800 },
                    colorScheme: theme
                });
                const desktopPage = await desktopContext.newPage();
                await desktopPage.goto(`http://127.0.0.1:${port}/${config.path}`, { waitUntil: 'load' });
                await desktopPage.waitForTimeout(100);

                const desktopOutPath = path.join(SCREENSHOT_DIR, `1280px-${config.lang}-${theme}.png`);
                await desktopPage.screenshot({ path: desktopOutPath, fullPage: false });
                console.log(`Saved screenshot: ${desktopOutPath}`);
                await desktopContext.close();
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
