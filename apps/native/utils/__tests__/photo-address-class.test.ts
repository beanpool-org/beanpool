/**
 * Source guard: a Learn or listing picture's path gets the address of the community it came from, never the one in use as it is drawn
 * (utils/photo-address.ts; review of #3355 at 84e1d902, where the Pulse's card asked one community's server for another's picture, its
 * key in the address). The behaviour is pinned place by place in learn-pictures-drawn-render.test.ts; this fails the next place written
 * the old way.
 *
 * 1. utils/db.ts: a function that makes a photo's address takes the copy and its address together (chatCopyForRequest, or the community
 *    it was handed): it reads neither 'beanpool_anchor_url' nor getDb()/waitForInit() itself. Read with the TypeScript parser.
 * 2. useNodeUri (the address in use as the page opens) is the shops' alone: a page that reads its shop as it opens.
 * 3. What draws a Learn or listing picture reads no address: it is handed one, or whole addresses.
 * 4. Home hands its cards the address of the answer they are drawn from (StoredHome.url).
 * 5. No other file puts an address in front of a path by hand, the faces' own aside (utils/image-processing.ts's kind of picture).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

const APP = path.join(__dirname, '..', '..');
const read = (file: string) => fs.readFileSync(path.join(APP, file), 'utf8');

/** Every source file of the app, tests aside, by its path from apps/native. */
function sources(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(path.join(APP, dir), { withFileTypes: true })) {
            const at = path.posix.join(dir, e.name);
            if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(at); }
            else if (/\.tsx?$/.test(e.name)) out.push(at);
        }
    };
    for (const dir of ['app', 'components', 'utils', 'services', 'tools']) walk(dir);
    return out;
}
/** A file's code with its comments blanked: what a guard reads is what runs. */
function code(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/** Each top-level function of a source that makes a photo's address, with what it reads of the copy and the address itself. */
function makers(source: string): Array<{ name: string; reads: string[] }> {
    const sf = ts.createSourceFile('db.ts', source, ts.ScriptTarget.Latest, true);
    const found: Array<{ name: string; reads: string[] }> = [];
    for (const st of sf.statements) {
        if (!ts.isFunctionDeclaration(st) || !st.name) continue;
        let makes = false;
        const reads = new Set<string>();
        const visit = (n: ts.Node): void => {
            if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
                if (n.expression.text === 'photoOnCommunity' || n.expression.text === 'onCommunity') makes = true;
                if (n.expression.text === 'getDb' || n.expression.text === 'waitForInit') reads.add(`${n.expression.text}()`);
            }
            if (ts.isStringLiteral(n) && n.text === 'beanpool_anchor_url') reads.add('beanpool_anchor_url');
            ts.forEachChild(n, visit);
        };
        visit(st);
        if (makes) found.push({ name: st.name.text, reads: [...reads] });
    }
    return found;
}

describe('a Learn or listing picture is asked of the community it came from', () => {
    it('1. every read of the copy that makes a photo\'s address takes the copy and its address together', () => {
        const all = makers(read('utils/db.ts'));
        expect(all.filter((f) => f.reads.length)).toEqual([]);
        // The readers it is about are among them, so the rule is not vacuous.
        expect(all.map((f) => f.name)).toEqual(expect.arrayContaining([
            'getPosts', 'getMyPosts', 'getPost', 'getMemberPosts', 'getConversations', 'getMarketplaceTransactions', 'refreshPostForPhoto',
            'getHeldConversations', 'knowledgePageOf',
        ]));
        // And it sees the old way.
        expect(makers("async function getPosts() { const database = await getDb(); const a = await AsyncStorage.getItem('beanpool_anchor_url'); return photoOnCommunity(a, 'x'); }"))
            .toEqual([{ name: 'getPosts', reads: ['getDb()', 'beanpool_anchor_url'] }]);
    });

    it('2. useNodeUri is the shops\' alone', () => {
        const callers = sources().filter((f) => f !== 'utils/node-uri.ts' && /\buseNodeUri\(/.test(code(read(f))));
        expect(callers.sort()).toEqual(['app/shop/mine.tsx', 'components/DefaultBanner.tsx', 'components/shopfront/Manage.tsx', 'components/shopfront/Shopfront.tsx']);
    });

    it('3. what draws a Learn or listing picture reads no address itself', () => {
        const DRAWS = [
            'components/ListPhoto.tsx', 'components/PhotoCarousel.tsx', 'components/PulseKnowledgeCard.tsx', 'components/PulseFeedCard.tsx',
            'components/learn/KnowledgeRowCard.tsx', 'components/learn/MarketLearnLine.tsx', 'components/learn/learn-keep.ts', 'components/home/LearnBody.tsx',
            'components/home/MarketTiles.tsx', 'components/home/HomeParts.tsx', 'app/(tabs)/pulse.tsx', 'utils/photo-address.ts', 'utils/learn-copy.ts',
        ];
        const READS = /\banchorUrl\(|\bgetCachedAnchorUrl\(|beanpool_anchor_url|\buseNodeUri\(/;
        expect(DRAWS.filter((f) => READS.test(code(read(f))))).toEqual([]);
        // A page and its form read it only to ask with it, never to draw: their pictures are drawn on the page's own (`nodeUrl`).
        for (const f of ['components/learn/KnowledgeDetail.tsx', 'app/learn/new.tsx']) {
            const src = code(read(f));
            expect((src.match(/\bpagePhotoUri\(/g) ?? []).length, f).toBe(1);
            expect(src, f).toMatch(/pagePhotoUri\(\w+, (page|opened\?)\.nodeUrl\)/);
            expect(src, f).not.toMatch(/use(NodeUri|CommunityAddress)\(/);
        }
    });

    it('4. Home draws its cards from the address of the answer they are in', () => {
        const home = code(read('app/(tabs)/index.tsx'));
        expect(home).toMatch(/const answeredBy = stored\?\.url \?\? null;/);
        for (const card of ['MarketBody', 'AskedBody', 'LearnBody', 'PulseBody', 'SearchBody']) {
            const props = home.match(new RegExp(`<${card}\\b[\\s\\S]*?/>`))?.[0] ?? '';
            expect(props, card).toMatch(/nodeUrl=\{answeredBy\}/);
        }
        // The two that draw no picture from it: each asks the community with it (a place to watch, the member's role).
        const rest = [...home.matchAll(/<(\w+)\b(?:(?!<\w)[\s\S])*?nodeUrl=\{url\}/g)].map((m) => m[1]);
        expect(rest.sort()).toEqual(['CommunityWelcomeCard', 'FindCommunityBody']);
    });

    it('5. no other file puts an address in front of a path by hand', () => {
        const BY_HAND = /startsWith\(['"]\/['"]\)\s*\?\s*`\$\{/;
        // Faces, whose own rule is utils/image-processing.ts avatarUri: a card's face on the community its request came from, and a
        // profile copied from the community it is read in.
        const FACES = ['components/MessageRequestsPane.tsx', 'utils/profile-copy.ts'];
        expect(sources().filter((f) => BY_HAND.test(code(read(f)))).sort()).toEqual(FACES);
    });
});
