import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const SHOTS_DIR = path.join(PWA_DIR, 'e2e', 'screenshots', 'header-alerts');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const ARTIFACTS_DIR = '/Users/marty/.gemini/antigravity-cli/brain/b66a755a-4cac-430e-bb0d-78502ff18dcc/screenshots';
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

const server = await createServer({
    configFile: path.join(PWA_DIR, 'vite.config.ts'),
    root: PWA_DIR,
    server: { port: 0 },
});
await server.listen();
const port = server.httpServer.address().port;
const baseUrl = `http://localhost:${port}/e2e/header-alerts-harness.html`;

const browser = await chromium.launch();

const CONFIGS = [
    { name: '320-130pct', width: 320, height: 400, textScale: 1.3 },
    { name: '1280', width: 1280, height: 400, textScale: 1.0 },
];

const THEMES = ['dark', 'light'];
const STATES = ['none', 'invite', 'several'];

console.log('Capturing header alerts screenshots...');

for (const config of CONFIGS) {
    for (const theme of THEMES) {
        for (const state of STATES) {
            const context = await browser.newContext({
                viewport: { width: config.width, height: config.height },
                colorScheme: theme,
            });
            const page = await context.newPage();
            await page.goto(`${baseUrl}?state=${state}`, { waitUntil: 'networkidle' });

            await page.evaluate(({ scale, mode }) => {
                document.documentElement.style.fontSize = `${scale * 100}%`;
                if (mode === 'dark') {
                    document.documentElement.classList.add('dark', 'dark-theme');
                    document.documentElement.classList.remove('light');
                } else {
                    document.documentElement.classList.add('light');
                    document.documentElement.classList.remove('dark', 'dark-theme');
                }
            }, { scale: config.textScale, mode: theme });

            await page.waitForTimeout(600);

            const shotFileName = `header-${config.name}-${theme}-${state}.png`;
            const shotPath = path.join(SHOTS_DIR, shotFileName);
            // Clip to header area
            await page.screenshot({
                path: shotPath,
                clip: { x: 0, y: 0, width: config.width, height: 180 },
            });
            fs.copyFileSync(shotPath, path.join(ARTIFACTS_DIR, shotFileName));
            console.log(`Saved ${shotFileName}`);
            await context.close();
        }
    }
}

await browser.close();
await server.close();
console.log('Done capturing screenshots!');
