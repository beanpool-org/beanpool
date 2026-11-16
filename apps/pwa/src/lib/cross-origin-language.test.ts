/**
 * THE GUARD (#3271 review 4590770780, closing the class): every request the web app sends that can bring back a community's
 * sentence carries the member's language (`X-Language`, the one header apps/server member-words.ts reads), whichever
 * community it goes to, where that route lets it through from another origin.
 *
 * 1. **The helpers that send it**, called for real over a stub fetch: to another community (signedFetchAt: an "ask to join",
 *    its status and cancel, the note for the worldwide forum; sendSignedAt: the push it asked for), and to this web app's
 *    own (request, signedFetch, signedFetchWithKey, signedMailFetch, getHome). The note request of "Beside my name on the
 *    worldwide forum" carries it (the finding).
 * 2. **CORS lets it through** each route the web app sends it to from another origin (apps/server https-server.ts names
 *    `x-language` for the signed "ask to join" routes and the note, and for an operator's listed origins). The one door
 *    that lets no language through, a copy on the worldwide community's (copy-cors.ts), is the one helper that sends none.
 * 3. **Every request the web app sends** (each `fetch(` in its code) is listed in FETCH_SITES, by file: the helper that
 *    sends the language, or why that request needs none. A new one fails here until it says which.
 *
 * Nothing here contacts a node: fetch is a stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { setLanguage } from '@beanpool/core';
vi.mock('./identity', async () => ({ ...(await vi.importActual('./identity')), loadIdentity: vi.fn(async () => null) }));
import { loadIdentity, type BeanPoolIdentity } from './identity';
import { resetNodeVersionGateForTests } from './node-version-gate';
import { getHome, request, sendSignedAt, signedCopyFetch, signedFetch, signedFetchAt, signedFetchWithKey, signedMailFetch } from './api';
import { setForumLabel } from './forum-label';

const seed = '09'.repeat(32);
const ana = { publicKey: bytesToHex(ed25519.getPublicKey(hexToBytes(seed))), privateKey: seed, callsign: 'Ana' } as BeanPoolIdentity;
const OTHER = 'https://hillside.example';
const WORLDWIDE = 'https://worldwide.example';

let sent: Array<{ url: string; headers: Record<string, string> }> = [];
const languageTo = (url: string) => {
    const hit = sent.find((s) => s.url === url);
    expect(hit, `no request to ${url}`).toBeTruthy();
    return Object.entries(hit!.headers).find(([k]) => k.toLowerCase() === 'x-language')?.[1];
};

beforeEach(() => {
    sent = [];
    localStorage.clear();
    resetNodeVersionGateForTests();
    vi.mocked(loadIdentity).mockResolvedValue(ana);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), window.location.origin).toString();
        sent.push({ url, headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
        if (url.endsWith('/api/community/health')) return new Response(JSON.stringify({ version: '1.4.0' }), { status: 200 });
        // The member's community refuses the note in its own words (the finding's case).
        if (url.endsWith('/api/membership/note')) return new Response(JSON.stringify({ error: 'no' }), { status: 409 });
        return new Response('{}', { status: 200 });
    }));
    setLanguage('es');
});
afterEach(() => {
    setLanguage('en');
    vi.unstubAllGlobals();
});

describe('1. the helpers that send it', () => {
    it('to another community: an "ask to join", its status and cancel, the note, the push it asked for', async () => {
        await signedFetchAt('POST', OTHER, '/api/join/knock', '{}', ana);
        await signedFetchAt('GET', OTHER, '/api/join/knock/status', '', ana);
        await signedFetchAt('POST', OTHER, '/api/join/knock/cancel', '{}', ana);
        await signedFetchAt('GET', OTHER, '/api/membership/note', '', ana);
        await sendSignedAt('DELETE', OTHER, '/api/web-push', '{}', ana);
        await vi.waitFor(() => expect(sent.some((s) => s.url === `${OTHER}/api/web-push`)).toBe(true));
        for (const path of ['/api/join/knock', '/api/join/knock/status', '/api/join/knock/cancel', '/api/membership/note', '/api/web-push']) {
            expect(languageTo(`${OTHER}${path}`), path).toBe('es');
        }
        // Signed as before: the language rides outside the signed bytes.
        expect(sent.find((s) => s.url === `${OTHER}/api/join/knock`)?.headers['x-signature'] ?? sent.find((s) => s.url === `${OTHER}/api/join/knock`)?.headers['X-Signature']).toBeTruthy();
    });

    it('the note for "Beside my name on the worldwide forum" (the finding): asked in the member\'s language', async () => {
        const done = await setForumLabel({ show: 'community', address: `${OTHER}/` });
        expect(done.ok).toBe(false);
        expect(languageTo(`${OTHER}/api/membership/note`)).toBe('es');
    });

    it('to this web app\'s own community, by every helper that reads a refusal', async () => {
        const here = window.location.origin;
        await request('GET', '/api/a').catch(() => null);
        await signedFetch('GET', '/api/b');
        await signedFetchWithKey('GET', '/api/c', undefined, ana.privateKey, ana.publicKey);
        await signedMailFetch('GET', here, '/api/mail', undefined, ana);
        await getHome().catch(() => null);
        for (const path of ['/api/a', '/api/b', '/api/c', '/api/mail']) expect(languageTo(`${here}${path}`), path).toBe('es');
        expect(languageTo(sent.find((s) => s.url.startsWith(`${here}/api/home`))!.url)).toBe('es');
    });

    it('never the pseudo-locale', async () => {
        setLanguage('xx');
        await signedFetchAt('GET', OTHER, '/api/join/knock/status', '', ana);
        expect(languageTo(`${OTHER}/api/join/knock/status`)).toBeUndefined();
    });

    it('a copy on the worldwide community names nobody (#2731): no language, Accept-Language pinned to English', async () => {
        await signedCopyFetch('POST', WORLDWIDE, '/api/marketplace/posts', { a: 1 }, ana);
        expect(languageTo(`${WORLDWIDE}/api/marketplace/posts`)).toBeUndefined();
        expect(sent.find((s) => s.url === `${WORLDWIDE}/api/marketplace/posts`)?.headers['Accept-Language']).toBe('en');
    });
});

// ── 2. CORS ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const server = (file: string) => readFileSync(join(ROOT, 'apps/server/src', file), 'utf8');
const headersOf = (text: string, name: string) => {
    const m = new RegExp(`const ${name} = '([^']*)'`).exec(text);
    expect(m, `${name} not found`).toBeTruthy();
    return m![1].toLowerCase().split(',').map((h) => h.trim());
};

describe('2. CORS lets it through where the web app sends it from another origin', () => {
    const https = server('https-server.ts');

    it('the signed "ask to join" routes, the push and the note allow x-language, and so does an operator\'s listed origin', () => {
        expect(headersOf(https, 'SIGNED_KNOCK_HEADERS')).toContain('x-language');
        expect(headersOf(https, 'ALLOWED_REQUEST_HEADERS')).toContain('x-language');
        const knockRoutes = /const SIGNED_KNOCK_CORS[\s\S]*?\]\);/.exec(https)?.[0] ?? '';
        for (const path of ['/api/join/knock', '/api/join/knock/status', '/api/join/knock/cancel', '/api/web-push', '/api/membership/note']) {
            expect(knockRoutes, path).toContain(`'${path}'`);
        }
    });

    it('the copy door lets no language through, and the copy helper sends none: change the two together', () => {
        expect(headersOf(server('copy-cors.ts'), 'SIGNED_COPY_HEADERS')).not.toContain('x-language');
    });
});

// ── 3. Every request the web app sends ───────────────────────────────────────────────────────────────────────────────────

/** A request that carries the language: the helper, checked in part 1. */
const SENDS = (helper: string) => `SENDS: ${helper}`;

/** Every `fetch(` in the web app's code, by file: the helper that sends the language, or why the request needs none. */
const FETCH_SITES: Record<string, string[]> = {
    'src/lib/api.ts': [
        'testNodeConnection: a community\'s /api/community/info, read for its name; the app says its own words',
        SENDS('request'),
        SENDS('signedFetch'),
        SENDS('signedFetchWithKey'),
        'fetchMembershipAt: "am I a member there?", read for isMember alone; no sentence shown',
        SENDS('signedFetchAt'),
        SENDS('sendSignedAt'),
        'signedCopyFetch: a copy on the worldwide community names nobody (#2731), and its CORS allows no language (copy-cors.ts)',
        SENDS('signedMailFetch'),
        'getNodeInfo: another community\'s counts, read; the app says its own words',
        'getRemotePosts: another community\'s listings, read; the app says its own words',
        'sendRemoteTransfer: no caller in the app',
        'getRemoteBalance: no caller in the app',
        SENDS('getHome'),
        'the pairing poll: read for a status word the app turns into its own',
        'the pairing send: read for its status code alone',
        'the pairing confirm: read for a result word the app turns into its own',
    ],
    'src/components/NodeApkLink.tsx': ['the website\'s APK page, no community'],
    'src/lib/forum-public.ts': ['the visitors\' forum on this web app\'s own community, public JSON: a refusal is the app\'s own words'],
    'src/lib/guide.ts': ['the members\' guide from the website, in the reader\'s language already', 'a language\'s guide pages from the website'],
    'src/lib/handoff.ts': ['a profile picture from this web app\'s own community: a file'],
    'src/lib/main-address-proof.ts': ['a community\'s signed address proof: public, its CORS allows no request header, no words'],
    'src/lib/node-version-gate.ts': ['the health read: public, its CORS allows no request header, no words'],
    'src/lib/outside-mail.ts': ['this community\'s /api/community/info, read for its address'],
    'src/lib/show-on-global.ts': ['a listing photo\'s bytes from the member\'s own community: a file'],
    'src/lib/takeover-unlock.ts': [
        'an owner unlock\'s lookup: an operator route (/api/local/), whose words stay English (member-words.ts, M8), and its CORS allows Content-Type alone',
        'an owner unlock\'s approval: the same route',
    ],
    'src/lib/web-join.ts': ['a name\'s availability, read for `available` alone'],
    'src/lib/web-push.ts': ['a community\'s web push key, read for the key alone'],
};

const PWA = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SKIP = /(^|\/)(__tests__|__mocks__|node_modules)(\/|$)|\.test\.tsx?$|\.test-support\.tsx?$|\.d\.ts$/;
const FETCH = /(?<![.\w])fetch\s*\(/g;

function codeFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const rel = relative(PWA, full);
        if (SKIP.test(rel)) continue;
        if (statSync(full).isDirectory()) codeFiles(full, out);
        else if (/\.tsx?$/.test(name)) out.push(rel);
    }
    return out;
}

/** A file's code, its comments left out. */
function codeOf(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

describe('3. every request the web app sends says whether it carries the language, and why not', () => {
    const files = codeFiles(join(PWA, 'src'));

    it('the walk reads the web app\'s code', () => {
        expect(files.length).toBeGreaterThan(200);
        expect(files).toContain('src/lib/api.ts');
    });

    it('each fetch is listed, by file', () => {
        const found: Record<string, number> = {};
        for (const rel of files) {
            const n = (codeOf(readFileSync(join(PWA, rel), 'utf8')).match(FETCH) ?? []).length;
            if (n) found[rel] = n;
        }
        const listed = Object.fromEntries(Object.entries(FETCH_SITES).map(([f, v]) => [f, v.length]));
        expect(found, 'a new request: send the language through one of the helpers in part 1, or list it in FETCH_SITES with why it needs none').toEqual(listed);
    });

    it('each helper listed as sending it names the language in its request', () => {
        const api = codeOf(readFileSync(join(PWA, 'src/lib/api.ts'), 'utf8'));
        const sends = FETCH_SITES['src/lib/api.ts'].filter((s) => s.startsWith('SENDS: ')).map((s) => s.slice('SENDS: '.length));
        for (const helper of sends) {
            const body = new RegExp(`export async function ${helper}\\b[\\s\\S]*?\\n}\\n`).exec(api)?.[0] ?? '';
            expect(body, helper).toMatch(/\b(?:languageHeaders|crossOriginLanguageHeaders)\(/);
        }
    });
});
