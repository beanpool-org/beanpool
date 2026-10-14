/**
 * Where a link into the app lands, as expo-router finds it, for the link checks (deep-links-resolve.test.ts and the Home
 * screen's table of links, home-screen-render.test.ts): the screen file under app/, and the params that screen reads.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const ROOT = path.resolve(__dirname, '../..');
export const APP = path.join(ROOT, 'app');

/** Does expo-router find a screen for this path? Groups may be left out; `[x]` files take any one segment. */
export function resolves(route: string): string | null {
    const clean = route.replace(/\$\{[^}]*\}/g, '__dyn__').split(/[?#]/)[0].replace(/\/+$/, '') || '/';
    const segs = clean === '/' ? [] : clean.slice(1).split('/');
    const walk = (dir: string, rest: string[]): string | null => {
        if (!fs.existsSync(dir)) return null;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        if (rest.length === 0) {
            if (fs.existsSync(path.join(dir, 'index.tsx'))) return path.join(dir, 'index.tsx');
        }
        // A group folder may be skipped in the path.
        for (const g of entries.filter(e => e.isDirectory() && /^\(.+\)$/.test(e.name))) {
            const hit = walk(path.join(dir, g.name), rest[0] === g.name ? rest.slice(1) : rest);
            if (hit) return hit;
        }
        if (rest.length === 0) return null;
        const [head, ...tail] = rest;
        const exact = head === '__dyn__' ? [] : [head];
        const dynamic = entries.map(e => e.name.replace(/\.tsx$/, '')).filter(n => /^\[.+\]$/.test(n));
        for (const name of [...exact, ...(head.startsWith('[') ? [head] : []), ...dynamic]) {
            if (tail.length === 0 && fs.existsSync(path.join(dir, `${name}.tsx`))) return path.join(dir, `${name}.tsx`);
            if (fs.existsSync(path.join(dir, name)) && fs.statSync(path.join(dir, name)).isDirectory()) {
                const hit = walk(path.join(dir, name), tail);
                if (hit) return hit;
            }
        }
        return null;
    };
    return walk(APP, segs);
}

/** The tab a route opens, when it is one of the tab navigator's screens ('market', 'projects', …); null otherwise. */
export function tabOf(route: string): string | null {
    const file = resolves(route);
    const tabs = `${path.sep}(tabs)${path.sep}`;
    if (!file || !file.includes(tabs)) return null;
    return path.basename(file, '.tsx');
}

/** The params a screen reads: the keys of each `useLocalSearchParams<{ … }>()` in its file. */
export function paramsRead(file: string): Set<string> {
    const text = fs.readFileSync(file, 'utf-8');
    const keys = new Set<string>();
    for (const m of text.matchAll(/useLocalSearchParams<\{([\s\S]*?)\}>/g)) {
        for (const k of m[1].matchAll(/(\w+)\??\s*:/g)) keys.add(k[1]);
    }
    return keys;
}
