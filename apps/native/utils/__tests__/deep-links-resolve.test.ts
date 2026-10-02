/**
 * Every link into the app's screens still lands on one (slice H2: Home took the tabs' first route, `index`, and the
 * Market moved to `market`). A grep over the app's own source, run in CI with the rest of the native suite:
 *
 * - every route the code names (`router.push/replace/navigate('…')`, `pathname: '…'`, `href`, and any literal starting
 *   `/(tabs)`) resolves to a file under app/, as expo-router matches them (groups like `(tabs)` may be left out of a
 *   path; `[id]` is any segment);
 * - every link that opens the Market's deals (`tab: 'deals'`) goes to the Market, or to `/`, which Home passes on;
 * - nothing still points at the Market by the tabs' first route.
 *
 * app/(tabs)/map.tsx is protected and left as it is: its "My deals" link to `/` is the one Home passes on.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { APP, ROOT, resolves } from './route-resolve';

function sources(): { file: string; text: string }[] {
    const out: { file: string; text: string }[] = [];
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name === '__tests__' || e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (/\.(ts|tsx)$/.test(e.name)) out.push({ file: path.relative(ROOT, full).split(path.sep).join('/'), text: fs.readFileSync(full, 'utf-8') });
        }
    };
    for (const d of ['app', 'components', 'utils', 'services']) walk(path.join(ROOT, d));
    return out;
}

/** The routes a file names, each with its line. Template parts (`${…}`) become one dynamic segment. */
function routesIn(text: string): { route: string; line: number }[] {
    const found: { route: string; line: number }[] = [];
    const patterns = [
        /router\.(?:push|replace|navigate)\(\s*(['`])([^'`]+)\1/g,
        /pathname:\s*(['`])([^'`]+)\1/g,
        /href[=:]\s*\{?\s*(['`"])(\/[^'`"]*)\1/g,
        /(['`])(\/\(tabs\)[^'`]*)\1/g,
        /navigate\(\s*(['`])(\/[^'`]*)\1/g,
    ];
    for (const re of patterns) {
        for (const m of text.matchAll(re)) {
            const route = m[2];
            if (!route.startsWith('/') || route.startsWith('//') || /^\/api\//.test(route)) continue;
            found.push({ route, line: text.slice(0, m.index).split('\n').length });
        }
    }
    return found;
}

const all = sources();
const links = all.flatMap(({ file, text }) => routesIn(text).map(r => ({ file, ...r })));

describe('every link into the app lands on a screen', () => {
    it('the grep finds the links (the check is not passing on nothing)', () => {
        expect(links.length).toBeGreaterThan(60);
        expect(links.filter(l => l.route.startsWith('/(tabs)')).length).toBeGreaterThan(25);
    });

    it('every route the code names resolves to a file under app/', () => {
        const broken = links.filter(l => !resolves(l.route)).map(l => `${l.file}:${l.line} ${l.route}`);
        expect(broken).toEqual([]);
    });

    it('every `/(tabs)…` link lands on a screen of the tab navigator', () => {
        const outside = links.filter(l => l.route.startsWith('/(tabs)'))
            .filter(l => !(resolves(l.route) ?? '').includes(`${path.sep}(tabs)${path.sep}`))
            .map(l => `${l.file}:${l.line} ${l.route}`);
        expect(outside).toEqual([]);
    });

    it('`/` and `/(tabs)` are Home now; the Market is `/(tabs)/market`', () => {
        expect(resolves('/(tabs)')).toBe(path.join(APP, '(tabs)', 'index.tsx'));
        expect(resolves('/(tabs)/')).toBe(path.join(APP, '(tabs)', 'index.tsx'));
        expect(resolves('/(tabs)/market')).toBe(path.join(APP, '(tabs)', 'market.tsx'));
        expect(resolves('/post/[id]')).toBe(path.join(APP, 'post', '[id].tsx'));
        expect(resolves('/chat/${conv.id}')).toBe(path.join(APP, 'chat', '[id].tsx'));
        expect(resolves('/no-such-screen')).toBeNull();
        expect(fs.readFileSync(path.join(APP, '(tabs)', 'index.tsx'), 'utf-8')).toMatch(/export default function HomeScreen/);
        expect(fs.readFileSync(path.join(APP, '(tabs)', 'market.tsx'), 'utf-8')).toMatch(/export default function MarketScreen/);
    });
});

describe('links that mean the Market go to the Market', () => {
    it('every "open the deals" link goes to the Market, or to `/` (the map\'s, which Home passes on)', () => {
        const deals = all.flatMap(({ file, text }) => [...text.matchAll(/pathname:\s*'([^']+)',\s*params:\s*\{\s*tab:\s*'deals'/g)]
            .map(m => ({ file, route: m[1] })));
        expect(deals.length).toBeGreaterThanOrEqual(3);
        for (const d of deals) {
            if (d.file === 'app/(tabs)/map.tsx') expect(d.route, d.file).toBe('/');
            else expect(d.route, d.file).toBe('/(tabs)/market');
        }
        // Home passes `/` with the deals on to the Market.
        const home = fs.readFileSync(path.join(APP, '(tabs)', 'index.tsx'), 'utf-8');
        expect(home).toMatch(/const forward = marketForward\(params\);[\s\S]*router\.navigate\(\{ pathname: '\/\(tabs\)\/market', params: forward \}\)/);
        // The Market still opens the deals sheet from those params.
        const market = fs.readFileSync(path.join(APP, '(tabs)', 'market.tsx'), 'utf-8');
        expect(market).toMatch(/if \(params\.tab === 'deals'\) \{\s*setShowDealsSheet\(true\);/);
    });

    it('nothing names the Market as the tabs\' first route any more ("Browse Market", "Create a Post", the header\'s My deals)', () => {
        const chats = fs.readFileSync(path.join(APP, '(tabs)', 'chats.tsx'), 'utf-8');
        expect(chats).toMatch(/onPress=\{\(\) => router\.push\('\/\(tabs\)\/market'\)\}[\s\S]{0,300}Browse Market/);
        const sheet = fs.readFileSync(path.join(ROOT, 'components', 'MyDealsSheet.tsx'), 'utf-8');
        expect(sheet).toMatch(/router\.push\('\/\(tabs\)\/market'\); \}\}[\s\S]{0,200}\+ Create a Post/);
        const needs = fs.readFileSync(path.join(ROOT, 'utils', 'needs-you.ts'), 'utf-8');
        expect(needs).toContain("case 'my-deals': return { pathname: '/(tabs)/market', params: { tab: 'deals' } };");
        const icons = fs.readFileSync(path.join(ROOT, 'components', 'NeedsYouIcons.tsx'), 'utf-8');
        expect(icons).toContain('return router.push(needsTargetHref(target));');
    });
});
