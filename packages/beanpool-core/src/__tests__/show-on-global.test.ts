/**
 * A phone and a browser on one account (slice G3): two devices, each with its own pairs and neither knowing the other, on one
 * global. Run through the file both apps run, against a stand-in for global that holds what the real one holds: an id is one row,
 * a remove leaves it cancelled, an edit of a cancelled row is refused. The phone's own suite runs this file against real nodes
 * (apps/native utils/__tests__/show-on-global-e2e.test.ts), and the browser's in Chromium (apps/pwa e2e/global-tick-check.mjs).
 */
import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { copyIdOf, ed25519Signer, makeCopyKeeper, toEd25519Pkcs8, type CopyDeps, type CopyPair, type CopyStore, type HomeEvent } from '../index.js';

const seed = new Uint8Array(32).fill(7);
const pkcs8 = toEd25519Pkcs8(seed);
const publicKey = bytesToHex(ed25519.getPublicKey(seed));
const identity = { publicKey };
const sign = ed25519Signer(seed);

const GLOBAL = 'https://global.test';
const HOME = 'https://home.test';

interface Row { id: string; status: string; hiddenByReportsAt?: string; title: string }

function world() {
    const rows = new Map<string, Row>();
    let creates = 0;
    const home: HomeEvent = {
        id: 'home-1', type: 'offer', category: 'food', title: 'Tomatoes', credits: 20, priceType: 'fixed', authorPublicKey: publicKey, audienceScope: 'public',
        lat: -28.68731, lng: 153.52219, photos: [], status: 'active', active: true,
    };
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const deps: CopyDeps = {
        global: GLOBAL,
        async get(url, path) {
            const q = new URL(`${url}${path}`).searchParams;
            if (url === HOME) return path.startsWith('/api/members/preferences') ? json({}) : json([home]);
            const ids = q.get('ids')?.split(',') ?? [q.get('id') as string];
            return json(ids.flatMap((id) => (rows.has(id) ? [rows.get(id)] : [])));
        },
        async post(_url, path, body: any) {
            if (path === '/api/marketplace/posts') {
                if (rows.has(body.id)) return json({ error: 'That id is taken' }, 400);
                creates++;
                rows.set(body.id, { id: body.id, status: 'active', title: body.title });
                return json({ success: true, post: { shownCopy: true, shownFrom: { host: 'home.test' } } });
            }
            const row = rows.get(body.id);
            if (path.endsWith('/remove')) {
                if (row) row.status = 'cancelled';
                return json({ success: true });
            }
            if (!row || row.status === 'cancelled') return json({ error: 'Post not found' }, 404);
            row.title = body.title;
            return json({ success: true, post: {} });
        },
        del: async () => json({ success: true }),
        fetchPhoto: async () => ({ failed: 'gone' as const }),
        hostOf: () => 'home.test',
    };
    const device = () => {
        let pairs: CopyPair[] = [];
        const store: CopyStore = { read: async () => pairs, change: async (edit) => { pairs = edit(pairs); } };
        return {
            ...makeCopyKeeper({ store, deps, copyId: (homeId, generation) => copyIdOf(homeId, generation, sign), plainOrigin: (url) => url, isEventEnded: () => false }),
            pairs: () => pairs,
        };
    };
    return { rows, home, deps, device, creates: () => creates, up: () => [...rows.values()].filter((r) => r.status !== 'cancelled') };
}

describe('the id of a copy', () => {
    it('is the same from a raw seed and from PKCS8: a phone holds one and a browser the other', async () => {
        const fromPhone = await copyIdOf('home-1', 0, ed25519Signer(seed));
        expect(await copyIdOf('home-1', 0, ed25519Signer(pkcs8))).toBe(fromPhone);
        expect(fromPhone).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('holds still across versions: it is what two builds on one account have to agree on', async () => {
        expect(await copyIdOf('home-1', 0, sign)).toBe('3b4f24a2-7451-40ce-aeab-2a2317ba5be9');
    });

    it('differs by listing, by generation and by key, and nobody can work it out from what is public', async () => {
        const id = await copyIdOf('home-1', 0, sign);
        expect(await copyIdOf('home-2', 0, sign)).not.toBe(id);
        expect(await copyIdOf('home-1', 1, sign)).not.toBe(id);
        expect(await copyIdOf('home-1', 0, ed25519Signer(new Uint8Array(32).fill(8)))).not.toBe(id);
        // The public key and the home id alone: what a reader of a copy has. The id is none of the plain ways to mix them.
        const { sha256 } = await import('@noble/hashes/sha2.js');
        const asPlainHash = bytesToHex(sha256(new TextEncoder().encode(`${publicKey}home-1`))).slice(0, 8);
        expect(id.slice(0, 8)).not.toBe(asPlainHash);
    });
});

describe('a phone and a browser on one account', () => {
    it('the second tick takes up the first one\'s copy: one row, and both tend it', async () => {
        const w = world();
        const phone = w.device();
        const browser = w.device();
        expect(await phone.showOnGlobal(w.home, HOME, identity)).toBe('shown');
        expect(await browser.showOnGlobal(w.home, HOME, identity)).toBe('shown');
        expect(w.creates()).toBe(1);
        expect(browser.pairs()[0].copyId).toBe(phone.pairs()[0].copyId);
        expect(browser.pairs()[0].sent).not.toBe('');

        w.home.title = 'Ripe tomatoes';
        await browser.tendCopies(identity);
        await phone.tendCopies(identity);
        expect(w.up().map((r) => r.title)).toEqual(['Ripe tomatoes']);
    });

    it('two first ticks at once are one row', async () => {
        const w = world();
        const phone = w.device();
        const browser = w.device();
        const answers = await Promise.all([phone.showOnGlobal(w.home, HOME, identity), browser.showOnGlobal(w.home, HOME, identity)]);
        expect(answers).toEqual(['shown', 'shown']);
        expect(w.creates()).toBe(1);
        expect(w.up()).toHaveLength(1);
    });

    it('a rest and its return are one copy, whichever device gets there first, and all at once', async () => {
        const w = world();
        const phone = w.device();
        const browser = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        await browser.showOnGlobal(w.home, HOME, identity);
        w.home.status = 'paused';
        await Promise.all([phone.tendCopies(identity), browser.tendCopies(identity)]);
        expect(w.up()).toHaveLength(0);
        w.home.status = 'active';
        await Promise.all([phone.tendCopies(identity), browser.tendCopies(identity)]);
        await Promise.all([phone.tendCopies(identity), browser.tendCopies(identity)]);
        expect(w.up()).toHaveLength(1);
        expect(w.creates()).toBe(2);
        expect(phone.pairs()[0].copyId).toBe(browser.pairs()[0].copyId);
    });

    it('a device that was asleep through a rest finds the copy down and leaves it to the one that holds it', async () => {
        const w = world();
        const phone = w.device();
        const browser = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        await browser.showOnGlobal(w.home, HOME, identity);
        w.home.status = 'paused';
        await phone.tendCopies(identity);
        await browser.tendCopies(identity);
        expect(browser.pairs()).toEqual([]);
        expect(phone.pairs()[0].resting).toBe(true);
        w.home.status = 'active';
        await browser.tendCopies(identity);
        await phone.tendCopies(identity);
        expect(w.up()).toHaveLength(1);
        expect(w.creates()).toBe(2);
    });

    it('a Stop showing on one stands on the other: its next edit finds the copy down, and it lets go', async () => {
        const w = world();
        const phone = w.device();
        const browser = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        await browser.showOnGlobal(w.home, HOME, identity);
        expect(await browser.stopShowing('home-1', identity)).toBe(true);
        expect(w.up()).toHaveLength(0);
        w.home.title = 'Edited on the phone';
        await phone.tendCopies(identity);
        expect(w.up()).toHaveLength(0);
        expect(phone.pairs()).toEqual([]);
        expect(w.creates()).toBe(1);
    });

    it('a Stop showing on one stands through the other\'s rest', async () => {
        const w = world();
        const phone = w.device();
        const browser = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        await browser.showOnGlobal(w.home, HOME, identity);
        await browser.stopShowing('home-1', identity);
        w.home.status = 'paused';
        await phone.tendCopies(identity);
        w.home.status = 'active';
        await phone.tendCopies(identity);
        expect(w.up()).toHaveLength(0);
        expect(phone.pairs()).toEqual([]);
    });

    it('what can\'t cross: a Stop on one while both hold a rest. It comes back once, reads Shown, and a Stop there stands', async () => {
        const w = world();
        const phone = w.device();
        const browser = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        await browser.showOnGlobal(w.home, HOME, identity);
        w.home.status = 'paused';
        await Promise.all([phone.tendCopies(identity), browser.tendCopies(identity)]);
        await browser.stopShowing('home-1', identity);
        w.home.status = 'active';
        await phone.tendCopies(identity);
        expect(w.up()).toHaveLength(1);
        expect(await phone.pairOf('home-1', publicKey)).not.toBeNull();
        await phone.stopShowing('home-1', identity);
        await phone.tendCopies(identity);
        await browser.tendCopies(identity);
        expect(w.up()).toHaveLength(0);
        expect(w.creates()).toBe(2);
    });

    it('a new tick after a Stop is a new copy under the next id, on either device', async () => {
        const w = world();
        const phone = w.device();
        const browser = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        await phone.stopShowing('home-1', identity);
        expect(await browser.showOnGlobal(w.home, HOME, identity)).toBe('shown');
        expect(w.up()).toHaveLength(1);
        expect(w.creates()).toBe(2);
        expect(browser.pairs()[0].generation).toBe(1);
    });

    it('a second device finds the copy past its 30-day-old forerunners, a pair from before these ids keeps its own', async () => {
        const w = world();
        const phone = w.device();
        const browser = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        const first = phone.pairs()[0].copyId;
        w.home.status = 'paused';
        await phone.tendCopies(identity);
        w.home.status = 'active';
        await phone.tendCopies(identity);
        w.rows.delete(first); // gone from global after its 30 days
        expect(await browser.showOnGlobal(w.home, HOME, identity)).toBe('shown');
        expect(w.up()).toHaveLength(1);
        expect(browser.pairs()[0].copyId).toBe(phone.pairs()[0].copyId);
    });
});
