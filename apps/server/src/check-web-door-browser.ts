/**
 * The app document's policy in a real browser, whatever the spelling (design G11 §5.1): headless Chromium opens the
 * web app at every spelling test-web-door.ts sends and checks that an inline script in it never runs. The CSP belongs
 * to the document, so a spelling that served the web app under the older header would run it, and would keep the
 * member under that header for the whole session (the web app has no URL routes).
 *
 * The node serves a stand-in public/ folder: an index.html with one script from the node (it must run) and one
 * inline script (it must not), and stand-ins for the pages that keep the older header, each with an inline script
 * that must still run there. /app is the control: the inline script is blocked AND the browser reports it, so
 * "didn't run" is never a page that simply didn't load.
 *
 * Not in scripts/test-all.sh: it needs Playwright's Chromium, which the web app's package brings
 * (pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium, once).
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/check-web-door-browser.ts
 */
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';

const PORT = 8736;
const BASE = `https://localhost:${PORT}`;
const PWA_PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../pwa/package.json');

/** Every spelling test-web-door.ts sends that could be the web app, as a browser can ask for it. */
const SPELLINGS = [
    '/a/..%2findex.html', '/assets/..%2findex.html', '/settings/..%2findex.html', '/manager/..%2findex.html',
    '/manager/..%2f..%2findex.html', '/auth/..%2findex.html', '/settings-legacy/..%2findex.html',
    '/apple-probe/..%2findex.html', '/app/..%2findex.html', '/settings/..%2fsettings%2f..%2findex.html',
    '/a/..%2Findex.html', '/a/..%252findex.html', '/a/..%255cindex.html', '/a/..%5cindex.html', '/a/..%5Cindex.html',
    '/a\\..\\index.html', '/./index.html', '/.%2findex.html', '/%2e/index.html', '/a/../index.html',
    '/a/%2e%2e/index.html', '/settings/../index.html', '//index.html', '//app',
    '/assets/..%2findex.html?post=123', '/a/..%2findex.html#profile=abc',
    '/INDEX.HTML', '/Index.html', '/index.html/', '/index.html?x=1', '/index.html#frag', '/index.html', '/app', '/app/',
    '/app/profile', '/', '/ws/..%2findex.html', '/ws/%2e%2e/index.html', '/api/..%2findex.html',
];

/** The little of Playwright used here; it is the web app's dependency, not the node's, so it is loaded from there. */
interface Page {
    on(event: 'console', listener: (message: { text(): string }) => void): void;
    goto(url: string, options: { waitUntil: 'load' }): Promise<{ status(): number; headers(): Record<string, string> } | null>;
    evaluate<T>(fn: () => T): Promise<T>;
    close(): Promise<void>;
}
interface Browser {
    newContext(options: { ignoreHTTPSErrors: boolean }): Promise<{ newPage(): Promise<Page> }>;
    close(): Promise<void>;
}

/** The pages that keep the older header: their inline script must still run. */
const OLDER_HEADER_PAGES = ['/settings', '/settings/members', '/manager', '/auth/github.html'];

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

async function main(): Promise<void> {
    const { chromium } = createRequire(PWA_PACKAGE)('playwright') as { chromium: { launch(): Promise<Browser> } };

    const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-web-door-browser-'));
    const publicDir = path.join(webRoot, 'public');
    for (const dir of ['settings', 'manager', 'auth', 'assets']) fs.mkdirSync(path.join(publicDir, dir), { recursive: true });
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>BeanPool</title><div id="root">the web app</div>'
        + '<script src="/assets/probe.js"></script><script>window.inlineRan = true</script>');
    fs.writeFileSync(path.join(publicDir, 'assets', 'probe.js'), 'window.externalRan = true;');
    for (const [file, title] of [['settings/index.html', 'Settings'], ['manager/index.html', 'Manager'], ['auth/github.html', 'GitHub return']]) {
        fs.writeFileSync(path.join(publicDir, file), `<!doctype html><title>${title}</title><script>window.inlineRan = true</script>`);
    }
    process.chdir(webRoot);

    await initTls();
    initStateEngine();
    const { startHttpsServer } = await import('./https-server.js');
    await startHttpsServer(PORT);

    const browser = await chromium.launch();
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    async function open(spelling: string) {
        const page = await context.newPage();
        const blocked: string[] = [];
        page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) blocked.push(m.text()); });
        const response = await page.goto(`${BASE}${spelling}`, { waitUntil: 'load' });
        const seen = await page.evaluate(() => ({
            inline: (window as { inlineRan?: boolean }).inlineRan === true,
            external: (window as { externalRan?: boolean }).externalRan === true,
            app: document.body?.textContent?.includes('the web app') ?? false,
            path: location.pathname,
        }));
        await page.close();
        return { status: response?.status() ?? 0, csp: response?.headers()['content-security-policy'] ?? null, blocked, ...seen };
    }

    try {
        console.log('\n── the web app at every spelling ──');
        let appLoads = 0;
        for (const spelling of SPELLINGS) {
            const r = await open(spelling);
            if (r.app) appLoads++;
            const policy = r.csp === null ? 'no CSP' : (/script-src 'self';/.test(r.csp) ? "script-src 'self'" : 'script-src with unsafe-inline');
            assert(!r.inline, `${spelling.padEnd(44)} → ${String(r.status).padEnd(3)} ${r.path.padEnd(22)} ${r.app ? 'web app' : 'no app '}  `
                + `inline script ran: ${r.inline}  (${policy})`);
            if (r.app) {
                assert(r.external && r.blocked.length > 0,
                    `    ...the app loaded its own script and the browser reported the inline one blocked (external ${r.external}, ${r.blocked.length} report(s))`);
            }
        }
        assert(appLoads >= 8, `the web app did load at the canonical spellings, so the checks above watched it run (${appLoads} loads)`);

        console.log('\n── the pages that keep the older header ──');
        for (const pagePath of OLDER_HEADER_PAGES) {
            const r = await open(pagePath);
            assert(r.inline && r.blocked.length === 0, `${pagePath}: its inline script still runs, nothing blocked (ran ${r.inline}, ${r.blocked.length} report(s))`);
        }
        const invite = await open('/?invite=BP-TEST-0003');
        assert(invite.status === 200 && invite.blocked.length === 0, `/?invite=: the install page's inline script is not blocked (${invite.blocked.length} report(s))`);
    } finally {
        await browser.close();
        fs.rmSync(webRoot, { recursive: true, force: true });
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ In Chromium, no spelling runs an inline script in the web app; the pages that need one still run theirs.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌', e); process.exit(1); });
