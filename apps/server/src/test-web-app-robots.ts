/**
 * What the web app's page tells search engines (web-app-robots.ts), over REAL HTTPS through the real middleware. Search
 * Console listed 6,050 pages as "Duplicate without user-selected canonical": the web app on a community's own server at
 * /app?lang=it, ?lang=tr, ?lang= ..., the same page each time with nothing to say which one to list.
 *
 *   1. the table, on a server with no public address: every path below × (canonical present and its href, meta robots,
 *      X-Robots-Tag) is what the row says. The front door (/app, any query, /app/) carries no canonical, as the server
 *      has no address to name, and no noindex; every deeper path (/app/<anything>, and a path that falls through to the
 *      page) carries both noindex forms; /index.html the header; /api, a file, the service worker, robots.txt, `/`,
 *      Settings and the community's info carry none of them, as before
 *   2. the same table with a public address set (a stored hostname): the front door names `https://<that address>/app`,
 *      once, in the head of the HTML as served; everything else as in 1. Then with a port and a trailing slash, with
 *      CF_RECORD_NAME alone, and with a stored hostname that is not an address (no canonical, nothing of it in the page)
 *   3. the page itself is unchanged but for the one tag (its own head and body, byte for byte, around it)
 *   4. the rules underneath: which paths are the front door, where a tag goes in a page with and without a head, which
 *      public/ file is the page
 *
 * The node serves a stand-in web app from a temporary public/ folder (process.chdir before https-server loads), as
 * test-web-door.ts does. Neutral addresses only (riverside.example, hills.example).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-web-app-robots.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { initTls } from './services/tls.js';
import { initStateEngine, updateNodeConfig } from './state-engine.js';
import { forgetOwnAddresses } from './engine/own-addresses.js';
import { isWebAppEntryPath, isWebAppPageFile, webAppPageFor, withHeadTag } from './web-app-robots.js';

let PORT = 0;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const MARKER = 'the web app';
const HEAD = '<head>\n    <meta charset="UTF-8" />\n    <title>BeanPool</title>\n';
const BODY = `</head>\n<body><div id="root">${MARKER}</div><script type="module" src="/assets/app.js"></script></body>\n</html>\n`;
const INDEX_HTML = `<!DOCTYPE html>\n<html lang="en">\n${HEAD}${BODY}`;

interface Answer { status: number; type: string; robotsHeader: string | null; location: string | null; body: string }

/** A GET with the path sent exactly as written, and a browser's Accept. */
function get(rawPath: string, headers: Record<string, string> = {}): Promise<Answer> {
    return new Promise((resolve, reject) => {
        const req = https.request({
            host: 'localhost', port: PORT, path: rawPath, method: 'GET', rejectUnauthorized: false,
            headers: { Accept: 'text/html,*/*', ...headers },
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode ?? 0,
                type: String(res.headers['content-type'] ?? ''),
                robotsHeader: (res.headers['x-robots-tag'] as string | undefined) ?? null,
                location: (res.headers.location as string | undefined) ?? null,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        req.on('error', reject);
        req.end();
    });
}

/** Every `<link rel="canonical" href="…">` in a page, by its href. */
function canonicals(html: string): string[] {
    return [...html.matchAll(/<link\s+rel="canonical"\s+href="([^"]*)"\s*\/?>/gi)].map((m) => m[1]);
}
/** Every `<meta name="robots" content="…">` in a page, by its content. */
function metaRobots(html: string): string[] {
    return [...html.matchAll(/<meta\s+name="robots"\s+content="([^"]*)"\s*\/?>/gi)].map((m) => m[1]);
}
/** Whether `needle` sits in the page's head (before `</head>`). */
function inHead(html: string, needle: string): boolean {
    const at = html.indexOf(needle);
    const end = html.search(/<\/head\s*>/i);
    return at >= 0 && end >= 0 && at < end;
}

/**
 * What each path's answer is: `entry` the front door (the canonical when there is an address, no noindex), `member` a
 * deeper page (both noindex forms, no canonical), `file` public/index.html by name (the header only), `other` none of the
 * three, as before.
 */
type Kind = 'entry' | 'member' | 'file' | 'other';
interface Row { path: string; kind: Kind; status: number; headers?: Record<string, string>; contains?: string }
const ROWS: Row[] = [
    { path: '/app', kind: 'entry', status: 200 },
    { path: '/app?lang=it', kind: 'entry', status: 200 },
    { path: '/app?lang=tr', kind: 'entry', status: 200 },
    { path: '/app?lang=', kind: 'entry', status: 200 },
    { path: '/app?lang=zh-Hans', kind: 'entry', status: 200 },
    { path: '/app?lang=ru&door=ask', kind: 'entry', status: 200 },
    { path: '/app/', kind: 'entry', status: 200 },
    { path: '/app/?lang=it', kind: 'entry', status: 200 },
    { path: '/app/post/x', kind: 'member', status: 200 },
    { path: '/app/chat?y=1', kind: 'member', status: 200 },
    { path: '/app/post/x?lang=it', kind: 'member', status: 200 },
    { path: '/app/profile', kind: 'member', status: 200 },
    { path: '/app/auth/google', kind: 'member', status: 200 },
    // Not the web app's path, but it falls through to the page today (https-server.ts's SPA fallback: startsWith('/app')).
    { path: '/apps', kind: 'member', status: 200 },
    { path: '/index.html', kind: 'file', status: 200 },
    { path: '/index.html?lang=it', kind: 'file', status: 200 },
    { path: '/api/version', kind: 'other', status: 200, contains: '"version"' },
    { path: '/api/community/info', kind: 'other', status: 200 },
    { path: '/assets/app.js', kind: 'other', status: 200, contains: 'window.app' },
    { path: '/sw.js', kind: 'other', status: 200, contains: 'self.addEventListener' },
    { path: '/robots.txt', kind: 'other', status: 404 },
    // `/` is the community's card for a stranger, and a redirect to /app (query and all) for a browser that keeps an account.
    { path: '/', kind: 'other', status: 200, contains: 'data-testid="community-card"' },
    { path: '/?lang=it', kind: 'other', status: 200, contains: 'data-testid="community-card"' },
    { path: '/?lang=it', kind: 'other', status: 302, headers: { Cookie: 'bp_account_here=1' } },
    { path: '/settings', kind: 'other', status: 200, contains: 'window.page = "settings"' },
];

async function table(label: string, canonical: string | null): Promise<void> {
    console.log(`\n── ${label} ──`);
    for (const row of ROWS) {
        const res = await get(row.path, row.headers);
        const where = `${label}: GET ${row.path}${row.headers ? ' (with an account cookie)' : ''}`;
        const links = canonicals(res.body);
        const metas = metaRobots(res.body);
        assert(res.status === row.status, `${where} answers ${row.status} (got ${res.status})`);
        if (row.contains) assert(res.body.includes(row.contains), `${where} is the same answer as before (holds ${row.contains})`);
        if (row.path.startsWith('/?') && row.status === 302) {
            assert(res.location === `/app${row.path.slice(1)}`, `${where} still redirects to /app with its query (got ${res.location})`);
        }
        if (row.kind === 'entry') {
            assert(res.body.includes(MARKER) && res.type.includes('text/html'), `${where} serves the web app's page`);
            if (canonical) {
                assert(links.length === 1 && links[0] === canonical, `${where} names ${canonical} as its canonical, once (got ${JSON.stringify(links)})`);
                assert(inHead(res.body, '<link rel="canonical"'), `${where}: the canonical is in the head of the HTML as served`);
            } else {
                assert(links.length === 0, `${where}: no public address, so no canonical (got ${JSON.stringify(links)})`);
            }
            assert(metas.length === 0 && res.robotsHeader === null,
                `${where}: the front door stays findable: no meta robots, no X-Robots-Tag (got ${JSON.stringify(metas)}, ${res.robotsHeader})`);
        } else if (row.kind === 'member') {
            assert(res.body.includes(MARKER) && res.type.includes('text/html'), `${where} serves the web app's page`);
            assert(res.robotsHeader === 'noindex', `${where}: X-Robots-Tag: noindex (got ${res.robotsHeader})`);
            assert(metas.length === 1 && metas[0] === 'noindex' && inHead(res.body, '<meta name="robots"'),
                `${where}: one <meta name="robots" content="noindex"> in its head (got ${JSON.stringify(metas)})`);
            assert(links.length === 0, `${where}: no canonical on a member's page (got ${JSON.stringify(links)})`);
        } else if (row.kind === 'file') {
            assert(res.body.includes(MARKER), `${where} serves the web app's page, as the static server does`);
            assert(res.robotsHeader === 'noindex', `${where}: X-Robots-Tag: noindex, as every path of the web app but the front door (got ${res.robotsHeader})`);
            assert(links.length === 0, `${where}: no canonical (got ${JSON.stringify(links)})`);
        } else {
            assert(res.robotsHeader === null && links.length === 0 && metas.length === 0,
                `${where}: untouched: no X-Robots-Tag, canonical or meta robots (got ${res.robotsHeader}, ${JSON.stringify(links)}, ${JSON.stringify(metas)})`);
            assert(!res.body.includes(MARKER), `${where} is not the web app's page`);
        }
    }
}

function setAddress(publicAddress: unknown, cfRecordName: string | null): void {
    updateNodeConfig({ publicAddress } as any);
    if (cfRecordName === null) delete process.env.CF_RECORD_NAME;
    else process.env.CF_RECORD_NAME = cfRecordName;
    forgetOwnAddresses();
}

async function main(): Promise<void> {
    console.log('\n=== The web app\'s page and search engines: one front door, members\' pages unlisted ===\n');

    const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-web-app-robots-'));
    const publicDir = path.join(webRoot, 'public');
    for (const dir of ['settings', 'assets']) fs.mkdirSync(path.join(publicDir, dir), { recursive: true });
    fs.writeFileSync(path.join(publicDir, 'index.html'), INDEX_HTML);
    fs.writeFileSync(path.join(publicDir, 'settings', 'index.html'), '<!doctype html><title>Settings</title><script>window.page = "settings"</script>');
    fs.writeFileSync(path.join(publicDir, 'assets', 'app.js'), 'window.app = 1;');
    fs.writeFileSync(path.join(publicDir, 'sw.js'), "self.addEventListener('push', () => {});");
    process.chdir(webRoot);

    await initTls();
    initStateEngine();
    const { startHttpsServer } = await import('./https-server.js');
    PORT = await startHttpsServer(0);

    // ── 1. no public address ──
    setAddress(null, null);
    await table('1. no public address', null);

    // ── 2. a public address, every way it is stored ──
    setAddress({ mode: 'own', hostname: 'riverside.example' }, null);
    await table('2a. a stored hostname', 'https://riverside.example/app');

    console.log('\n── 2b–2d. other stored forms, at the front door ──');
    const forms: Array<[string, unknown, string | null, string | null]> = [
        ['a port and a trailing slash', { mode: 'own', hostname: 'riverside.example:8443/' }, null, 'https://riverside.example:8443/app'],
        ['a scheme', { mode: 'own', hostname: 'https://riverside.example' }, null, 'https://riverside.example/app'],
        ['CF_RECORD_NAME alone', null, 'hills.example', 'https://hills.example/app'],
        ['a stored hostname that is not an address', { mode: 'own', hostname: 'riverside.example"><script>alert(1)</script>' }, null, null],
    ];
    for (const [name, publicAddress, cf, expected] of forms) {
        setAddress(publicAddress, cf);
        for (const p of ['/app', '/app?lang=it']) {
            const res = await get(p);
            const links = canonicals(res.body);
            assert(res.status === 200 && JSON.stringify(links) === JSON.stringify(expected ? [expected] : []),
                `${name}: GET ${p} → ${expected ? `canonical ${expected}` : 'no canonical'} (got ${res.status} ${JSON.stringify(links)})`);
            assert(!res.body.includes('alert(1)') && !res.body.includes('<script>alert'), `${name}: GET ${p}: nothing of the stored value but an address reaches the page`);
            assert(res.robotsHeader === null && metaRobots(res.body).length === 0, `${name}: GET ${p}: still no noindex at the front door`);
        }
        const deep = await get('/app/post/x');
        assert(deep.robotsHeader === 'noindex' && canonicals(deep.body).length === 0, `${name}: GET /app/post/x stays noindex with no canonical`);
    }

    // ── 3. the page is unchanged but for the one tag ──
    console.log('\n── 3. the page is the page, with one tag added ──');
    setAddress({ mode: 'own', hostname: 'riverside.example' }, null);
    const entry = await get('/app?lang=it');
    assert(entry.body === INDEX_HTML.replace('</head>', '<link rel="canonical" href="https://riverside.example/app">\n</head>'),
        'GET /app?lang=it is public/index.html with the canonical before </head>, nothing else changed');
    const member = await get('/app/post/x');
    assert(member.body === INDEX_HTML.replace('</head>', '<meta name="robots" content="noindex">\n</head>'),
        'GET /app/post/x is public/index.html with the meta robots before </head>, nothing else changed');
    const file = await get('/index.html');
    assert(file.body === INDEX_HTML, 'GET /index.html is the file as it is on disk (the static server streams it)');

    // ── 4. the rules underneath ──
    console.log('\n── 4. the rules underneath ──');
    for (const p of ['/app', '/app/', '/APP', '/App/']) assert(isWebAppEntryPath(p), `${p} is the front door`);
    for (const p of ['/', '/app/x', '/app//', '/apps', '/application', '/app/post/x', '/index.html', '/api/app']) {
        assert(!isWebAppEntryPath(p), `${p} is not the front door`);
    }
    const tag = '<meta name="robots" content="noindex">';
    assert(withHeadTag('<html><head><title>x</title></HEAD><body></body></html>', tag) === `<html><head><title>x</title>${tag}\n</HEAD><body></body></html>`,
        'a tag goes before </head>, in any case');
    assert(withHeadTag('<!doctype html><title>x</title><div>y</div>', tag) === `<!doctype html>${tag}<title>x</title><div>y</div>`,
        'a page that leaves its head implied: straight after the doctype');
    assert(withHeadTag('<title>x</title>', tag) === `${tag}<title>x</title>`, 'no doctype, no head: first');
    const noAddress = webAppPageFor(INDEX_HTML, '/app', null);
    assert(noAddress.html === INDEX_HTML && !noAddress.noindex, 'the front door with no address: the page exactly as it is');
    const quoted = webAppPageFor(INDEX_HTML, '/app', 'https://riverside.example/app?a="b"&c');
    assert(canonicals(quoted.html)[0] === 'https://riverside.example/app?a=&quot;b&quot;&amp;c', 'a canonical is written as an attribute, escaped');
    for (const f of ['index.html', 'index.html.gz', 'index.html.br']) assert(isWebAppPageFile(f), `public/${f} is the web app's page`);
    for (const f of ['settings/index.html', 'manager/index.html', 'auth/facebook.html', 'assets/index.html', 'index.htm', 'sw.js']) {
        assert(!isWebAppPageFile(f), `public/${f} is not`);
    }

    setAddress(null, null);
    fs.rmSync(webRoot, { recursive: true, force: true });
    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ The web app: one front door named for search engines, every member\'s page unlisted, nothing else touched.');
}

main().then(() => process.exit(0)).catch((e) => { console.error('❌ Test failed:', e); process.exit(1); });
