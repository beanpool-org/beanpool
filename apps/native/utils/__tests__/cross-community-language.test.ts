/**
 * THE GUARD (#3271 review 4590770483, closing the class): every request the phone sends to a community server's API
 * carries the member's language (`X-Language`, the one header apps/server member-words.ts reads), whichever community it
 * goes to, so a refusal from another community reaches the member in their language as their own community's does.
 *
 * The phone puts the language on in ONE place, the fetch wrapper (utils/node-request-signing.ts isCommunityApiRequest),
 * installed as the app loads. So:
 *
 * 1. **The rule.** Each kind of request the phone sends to a community other than its own (a knock, its status and its
 *    cancel, the note for the worldwide forum, the forum there, the directory, mail, a group's guests, contacts, an
 *    address list, a copy on the worldwide community) gets it, signed or not, beside the headers its helper set, with or
 *    without a community on the phone. A host that is no community's API (a store's lookup, a platform's API, a picture)
 *    never does.
 * 2. **The helpers that sign for another community themselves** (node-post.ts signedGet, signedPost, signedDelete; the
 *    worldwide forum's note request, utils/forum-label.ts) reach it through the wrapper with it.
 * 3. **The way around.** A request misses it only by going around the wrapper's header: a Headers object or a Request it
 *    can't add to, XMLHttpRequest, a file download or upload, a socket, the fetch the wrapper kept from before it, or a
 *    request marked to go without it (utils/request-language.ts). Every such call in the phone's code is listed in
 *    AROUND_THE_WRAPPER, by file, with why it needs no language; a new one fails here until it is listed (or goes through
 *    fetch). The one marked on purpose: a copy on the worldwide community names nobody (#2731), so it carries the signature's
 *    headers alone, as the web's does. And the wrapper is installed at load (app/_layout.tsx).
 *
 * Nothing here contacts a node.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (n: number) => new Uint8Array(randomBytes(n)) };
});
const mem = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.delete(k); }),
    },
}));
const who = vi.hoisted(() => ({ identity: null as null | { publicKey: string; privateKey: string; callsign: string; createdAt: string } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => who.identity) }));
// The forum's own requests (the community in front) are db.ts's, which names the language itself; only the note's is here.
vi.mock('../db', () => ({ signedRequestWithMethod: vi.fn(async () => ({ show: 'none', community: null, lapsesAt: null, label: null, why: null })) }));
vi.mock('../nodes', () => ({ getSavedNodes: vi.fn(async () => []) }));

import { ed25519 } from '@noble/curves/ed25519.js';
import { setLanguage } from '@beanpool/core';
import { installNodeRequestSigning, isCommunityApiRequest } from '../node-request-signing';
import { signedDelete, signedGet, signedPost } from '../node-post';
import { setForumLabel } from '../forum-label';

const SEED = new Uint8Array(32).fill(5);
const IDENTITY = { publicKey: Buffer.from(ed25519.getPublicKey(SEED)).toString('hex'), privateKey: Buffer.from(SEED).toString('hex'), callsign: 'Ana', createdAt: '' };

const underlying = vi.fn(async (_input: unknown, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({}) } as unknown as Response));
(globalThis as any).fetch = underlying;
installNodeRequestSigning();

const OWN = 'https://riverside.example';
const OTHER = 'https://hillside.example';
const WORLDWIDE = 'https://worldwide.example';

/** The requests sent, without the wrapper's own health read (node-version-gate.ts: public, no words). */
const sent = () => underlying.mock.calls.filter(([input]) => !String(input).endsWith('/api/community/health'));
const languageOf = (i: number) => {
    const headers = (sent()[i]?.[1]?.headers ?? {}) as Record<string, string>;
    return Object.entries(headers).find(([k]) => k.toLowerCase() === 'x-language')?.[1];
};

beforeEach(() => {
    underlying.mockClear();
    mem.clear();
    mem.set('beanpool_anchor_url', OWN);
    who.identity = IDENTITY;
    setLanguage('es');
});
afterEach(() => setLanguage('en'));

describe('1. the rule: every community\'s API, whichever community', () => {
    /** Each kind of request the phone sends to another community, as its helper sends it. */
    const OTHER_COMMUNITY_REQUESTS: Array<[string, string, RequestInit?]> = [
        ['a knock', `${OTHER}/api/join/knock`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': 's' }, body: '{}' }],
        ['its status', `${OTHER}/api/join/knock/status`, { headers: { 'X-Signature': 's' } }],
        ['its cancel', `${OTHER}/api/join/knock/cancel`, { method: 'POST', headers: { 'X-Signature': 's' }, body: '{}' }],
        ['the note for the worldwide forum', `${OTHER}/api/membership/note`, { headers: { 'X-Signature': 's' } }],
        ['the worldwide forum', `${WORLDWIDE}/api/forum/topics`, { headers: { 'X-Signature': 's' } }],
        ['the directory', `${WORLDWIDE}/api/global/communities?q=hill`],
        ['mail at the community that holds it', `${OTHER}/api/mail/send`, { method: 'POST', headers: { 'X-Signature': 's' }, body: '{}' }],
        ['a group\'s guests', `${OTHER}/api/groups/g1/guests`, { headers: { 'X-Signature': 's' } }],
        ['contacts', `${OTHER}/api/contacts/copy`, { method: 'POST', headers: { 'X-Signature': 's' }, body: '{}' }],
        ['an address list', `${OTHER}/api/node/addresses`],
        ['a copy on the worldwide community', `${WORLDWIDE}/api/marketplace/posts`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': 's' }, body: '{}' }],
    ];

    it.each(OTHER_COMMUNITY_REQUESTS)('%s carries it, beside its own headers', async (_what, url, init) => {
        await fetch(url, init);
        expect(languageOf(0)).toBe('es');
        for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
            expect((sent()[0][1]?.headers as Record<string, string>)[k]).toBe(v);
        }
    });

    it('with no community on the phone yet (a join) as well', async () => {
        mem.clear();
        await fetch(`${OTHER}/api/join/knock`, { method: 'POST', body: '{}' });
        expect(languageOf(0)).toBe('es');
    });

    it('a host that is no community\'s API never gets it', async () => {
        const NOT_A_COMMUNITY_API = [
            'https://itunes.apple.com/lookup?bundleId=x',
            'https://open.tiktokapis.com/v2/oauth/token/',
            'https://graph.instagram.com/v21.0/me/media',
            `${OTHER}/logo.png`,
            `${OTHER}/apiary`,
        ];
        for (const url of NOT_A_COMMUNITY_API) {
            expect(isCommunityApiRequest(url), url).toBe(false);
            await fetch(url);
        }
        for (let i = 0; i < NOT_A_COMMUNITY_API.length; i++) expect(languageOf(i), NOT_A_COMMUNITY_API[i]).toBeUndefined();
    });
});

describe('2. the helpers that sign for another community themselves', () => {
    it('signedGet, signedPost and signedDelete to another community carry it', async () => {
        await signedGet(OTHER, '/api/join/knock/status', IDENTITY);
        await signedPost(OTHER, '/api/join/knock/cancel', {}, IDENTITY);
        await signedDelete(OTHER, '/api/web-push', IDENTITY);
        expect([languageOf(0), languageOf(1), languageOf(2)]).toEqual(['es', 'es', 'es']);
        // Signed as before: the language rides outside the signed bytes.
        expect((sent()[0][1]?.headers as Record<string, string>)['X-Signature']).toBeTruthy();
    });

    it('one asked to go without it (a copy on the worldwide community, #2731) carries none, and is signed as before', async () => {
        await signedPost(WORLDWIDE, '/api/marketplace/posts', {}, IDENTITY, undefined, { language: false });
        await signedGet(WORLDWIDE, '/api/marketplace/posts?id=x', IDENTITY, undefined, undefined, { language: false });
        await signedDelete(WORLDWIDE, '/api/events/x/skip', IDENTITY, undefined, { language: false });
        expect([languageOf(0), languageOf(1), languageOf(2)]).toEqual([undefined, undefined, undefined]);
        expect((sent()[0][1]?.headers as Record<string, string>)['X-Signature']).toBeTruthy();
    });

    it('the worldwide forum\'s note request to the member\'s community carries it (the finding)', async () => {
        await setForumLabel({ show: 'community', address: OTHER });
        const note = sent().findIndex(([input]) => String(input) === `${OTHER}/api/membership/note`);
        expect(note).toBeGreaterThanOrEqual(0);
        expect(languageOf(note)).toBe('es');
    });
});

// ── 3. The way around the wrapper ─────────────────────────────────────────────────────────────────────────────────────

const NATIVE = join(__dirname, '..', '..');
const DIRS = ['app', 'components', 'utils', 'hooks', 'services', 'tools', 'contexts'];
const SKIP = /(^|\/)(__tests__|__mocks__|node_modules)(\/|$)|\.test\.tsx?$|\.d\.ts$/;

/** A request sent where the wrapper can't put a header on: none of these goes through fetch with a plain headers object. */
const AROUND = /\bnew Headers\s*\(|\bnew Request\s*\(|\bXMLHttpRequest\b|\.(?:downloadAsync|uploadAsync|createDownloadResumable)\s*\(|\bnew WebSocket\s*\(|\bnew EventSource\s*\(|\boriginalFetch\s*\(|\bwithoutLanguage\s*\(|\blanguage:\s*false\b/g;

/** Every such call, by file: how many, and why it needs no language. A new one is listed here with its reason, or goes through fetch. */
const AROUND_THE_WRAPPER: Record<string, { count: number; why: string }> = {
    'utils/node-request-signing.ts': { count: 1, why: 'the wrapper\'s own send, once its headers (the language among them) are on' },
    'utils/beans-sign.ts': { count: 1, why: 'the community\'s logo picture for a printed sign: a file, no words' },
    'services/ws-client.ts': { count: 1, why: 'the sync socket to the member\'s own community: change doorbells (a type and ids), no sentence a member reads' },
    'utils/node-post.ts': { count: 1, why: 'marks a signed request only when its caller asks (SignedSendOptions language: false), each caller listed here' },
    'utils/show-on-global.ts': { count: 1, why: 'a copy on the worldwide community names nobody (#2731): the signature\'s headers alone, as the web\'s (apps/server copy-cors.ts allows nothing else); its refusals stay English, as they were' },
};

function sources(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const rel = relative(NATIVE, full);
        if (SKIP.test(rel)) continue;
        if (statSync(full).isDirectory()) sources(full, out);
        else if (/\.tsx?$/.test(name)) out.push(rel);
    }
    return out;
}

/** The code of a file, its comments left out (a line or block comment can name any of these). */
function codeOf(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

describe('3. a request can only miss it by going around the wrapper, and every such call says why', () => {
    const files = DIRS.map((d) => join(NATIVE, d)).filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } })
        .flatMap((d) => sources(d));

    it('the walk reads the phone\'s code', () => {
        expect(files.length).toBeGreaterThan(200);
        expect(files).toContain('utils/node-request-signing.ts');
    });

    it('every call around the wrapper is listed, by file, with its reason', () => {
        const found: Record<string, number> = {};
        for (const rel of files) {
            const n = (codeOf(readFileSync(join(NATIVE, rel), 'utf8')).match(AROUND) ?? []).length;
            if (n) found[rel] = n;
        }
        const listed = Object.fromEntries(Object.entries(AROUND_THE_WRAPPER).map(([f, v]) => [f, v.count]));
        expect(found, 'a request sent around the fetch wrapper: send it through fetch with a plain headers object, or list it in AROUND_THE_WRAPPER with why it needs no language').toEqual(listed);
        for (const [file, { why }] of Object.entries(AROUND_THE_WRAPPER)) expect(why.length, file).toBeGreaterThan(20);
    });

    it('the copy keeper sends every one of its requests that way, and nothing else on the phone asks for it', () => {
        const copies = codeOf(readFileSync(join(NATIVE, 'utils', 'show-on-global.ts'), 'utf8'));
        expect(copies.match(/\bsigned(?:Get|Post|Delete)\([^)]*\bA_COPY\)/g)?.length).toBe(3);
        expect(copies.match(/\bsigned(?:Get|Post|Delete)\(/g)?.length).toBe(3);
    });

    it('the wrapper is installed as the app loads, before any screen sends anything', () => {
        expect(readFileSync(join(NATIVE, 'app', '_layout.tsx'), 'utf8')).toMatch(/^installNodeRequestSigning\(/m);
    });
});
