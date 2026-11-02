/**
 * A phone and a browser on one account (slice G3): two devices, each with its own pairs and neither knowing the other, on one
 * global. Run through the file both apps run, against a stand-in for global that holds what the real one holds: an id is one row
 * for good, a remove leaves it cancelled, an edit of a cancelled row is refused, and a read by id shows a cancelled row only for an
 * event (packages/beanpool-engine posts.ts): a removed Offer or Need reads as nothing and still holds its id, which a create
 * hears as a code. The phone's own suite runs this file against real nodes
 * (apps/native utils/__tests__/show-on-global-e2e.test.ts), and the browser's in Chromium (apps/pwa e2e/global-tick-check.mjs).
 */
import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { COPY_IDS_LOOKED_AT, copyIdOf, ed25519Signer, makeCopyKeeper, POST_ID_TAKEN_CODE, toEd25519Pkcs8, type CopyDeps, type CopyPair, type CopyStore, type HomeEvent } from '../index.js';

const seed = new Uint8Array(32).fill(7);
const pkcs8 = toEd25519Pkcs8(seed);
const publicKey = bytesToHex(ed25519.getPublicKey(seed));
const identity = { publicKey };
const sign = ed25519Signer(seed);

const GLOBAL = 'https://global.test';
const HOME = 'https://home.test';

interface Row { id: string; type: string; status: string; hiddenByReportsAt?: string; title: string }

/** What a read by id shows of a row: `active = 1`, or a cancelled event. */
const readable = (r: Row) => r.status === 'active' || (r.status === 'cancelled' && r.type === 'event');

/** `noCode`: a global from before the id-taken refusal carried one. */
function world({ noCode = false }: { noCode?: boolean } = {}) {
    const rows = new Map<string, Row>();
    let creates = 0;
    let sends = 0;
    let photoFetches = 0;
    let busyOn = 0;
    let holiday = false;
    let onRefused: (() => Promise<unknown>) | null = null;
    let silentRead: ((q: URLSearchParams) => boolean) | null = null;
    let lostRead = false;
    let onRead: (() => Promise<unknown> | void) | null = null;
    let removeAnswer: ((id: string) => Response | null) | null = null;
    const reads: string[][] = [];
    const removes: string[] = [];
    const home: HomeEvent = {
        id: 'home-1', type: 'offer', category: 'food', title: 'Tomatoes', credits: 20, priceType: 'fixed', authorPublicKey: publicKey, audienceScope: 'public',
        lat: -28.68731, lng: 153.52219, photos: [], status: 'active', active: true,
    };
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const deps: CopyDeps = {
        global: GLOBAL,
        async get(url, path) {
            const q = new URL(`${url}${path}`).searchParams;
            if (url === HOME) return path.startsWith('/api/members/preferences') ? json({ holiday_mode: String(holiday) }) : json([home]);
            const ids = q.get('ids')?.split(',') ?? [q.get('id') as string];
            reads.push(ids);
            if (lostRead) throw new TypeError('Network request failed');
            if (silentRead?.(q)) return json({ error: 'Busy' }, 503);
            const answer = json(ids.flatMap((id) => { const row = rows.get(id); return row && readable(row) ? [row] : []; }));
            await onRead?.();
            return answer;
        },
        async post(_url, path, body: any) {
            if (path === '/api/marketplace/posts') {
                sends++;
                if (busyOn > 0 && --busyOn === 0) return json({ error: 'Busy' }, 503);
                if (rows.has(body.id)) {
                    await onRefused?.();
                    return json({ error: 'A new post needs an id nothing else has.', ...(noCode ? {} : { code: POST_ID_TAKEN_CODE }) }, 400);
                }
                creates++;
                rows.set(body.id, { id: body.id, type: body.type, status: 'active', title: body.title });
                return json({ success: true, post: { shownCopy: true, shownFrom: { host: 'home.test' } } });
            }
            const row = rows.get(body.id);
            if (path.endsWith('/remove')) {
                removes.push(body.id);
                const answer = removeAnswer?.(body.id);
                if (answer) return answer;
                if (!row) return json({ error: 'Post not found' }, 404);
                row.status = 'cancelled';
                return json({ success: true });
            }
            if (!row || row.status === 'cancelled') return json({ error: 'Post not found' }, 404);
            row.title = body.title;
            return json({ success: true, post: {} });
        },
        del: async () => json({ success: true }),
        fetchPhoto: async () => { photoFetches++; return { failed: 'gone' as const }; },
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
    return {
        rows, home, deps, device, creates: () => creates, sends: () => sends, photoFetches: () => photoFetches,
        /** The nth create from now answers 503. */
        busyOn: (n: number) => { busyOn = n; },
        /** The member's holiday at home, which is what rests an event. */
        setHoliday: (on: boolean) => { holiday = on; },
        /** Runs as a create is refused, before its answer lands. */
        onRefused: (run: () => Promise<unknown>) => { onRefused = run; },
        /** Global gives no answer to the reads this picks out; null, it answers them all. */
        silentOn: (pick: ((q: URLSearchParams) => boolean) | null) => { silentRead = pick; },
        /** Reads of global fail on the way, as with no network: what a phone's fetch throws. */
        loseReads: (lost: boolean) => { lostRead = lost; },
        /** Runs while the answer to a read of global is on its way: that answer says what stood before this ran. */
        onRead: (run: (() => Promise<unknown> | void) | null) => { onRead = run; },
        /** Global answers a remove with this instead of doing it; null, it does them all. */
        removeAnswers: (answer: ((id: string) => Response | null) | null) => { removeAnswer = answer; },
        /** The ids of each read of global, and of each remove, in order. */
        reads, removes,
        json,
        up: () => [...rows.values()].filter((r) => r.status === 'active'),
    };
}

/** Holds every id of `home-1` up to `count` as a down copy, as many rests or Stops would. */
async function downIds(w: ReturnType<typeof world>, count: number): Promise<void> {
    for (let g = 0; g < count; g++) {
        const id = await copyIdOf('home-1', g, sign);
        w.rows.set(id, { id, type: 'offer', status: 'cancelled', title: 'Earlier' });
    }
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

    it('two ticks at once after a Stop are one row', async () => {
        const w = world();
        const phone = w.device();
        const browser = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        await phone.stopShowing('home-1', identity);
        expect(await Promise.all([phone.showOnGlobal(w.home, HOME, identity), browser.showOnGlobal(w.home, HOME, identity)])).toEqual(['shown', 'shown']);
        expect(w.up()).toHaveLength(1);
        expect(phone.pairs()[0].copyId).toBe(browser.pairs()[0].copyId);
    });

    it('a second device finds the copy past its 30-day-old forerunners, a pair from before these ids keeps its own', async () => {
        const w = world();
        const phone = w.device();
        const browser = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        w.home.status = 'paused';
        await phone.tendCopies(identity);
        w.home.status = 'active';
        await phone.tendCopies(identity);
        expect(await browser.showOnGlobal(w.home, HOME, identity)).toBe('shown');
        expect(w.up()).toHaveLength(1);
        expect(browser.pairs()[0].copyId).toBe(phone.pairs()[0].copyId);
    });
});

describe('a new tick after a Stop', () => {
    it('an Offer: global reads the old copy as nothing, and the id it holds sends the tick on to the next', async () => {
        const w = world();
        const phone = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        const first = phone.pairs()[0].copyId;
        await phone.stopShowing('home-1', identity);
        expect(await phone.showOnGlobal(w.home, HOME, identity)).toBe('shown');
        expect(phone.pairs()[0].copyId).not.toBe(first);
        expect(phone.pairs()[0].generation).toBe(1);
        expect(phone.pairs()[0].sent).not.toBe('');
        expect(phone.pairs()[0].earlierIds).toEqual([first]);
        expect(w.up()).toHaveLength(1);
        expect(w.sends()).toBe(3);
    });

    it('and again, each from the start of the ids, and a Stop then still ends the copy it found', async () => {
        const w = world();
        const phone = w.device();
        for (let i = 0; i < 3; i++) {
            expect(await phone.showOnGlobal(w.home, HOME, identity)).toBe('shown');
            expect(phone.pairs()[0].generation).toBe(i);
            await phone.stopShowing('home-1', identity);
            expect(w.up()).toHaveLength(0);
        }
    });

    it('an Offer after a rest and its return: the tick goes past both ids', async () => {
        const w = world();
        const phone = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        w.home.status = 'paused';
        await phone.tendCopies(identity);
        w.home.status = 'active';
        await phone.tendCopies(identity);
        expect(phone.pairs()[0].generation).toBe(1);
        await phone.stopShowing('home-1', identity);
        expect(await phone.showOnGlobal(w.home, HOME, identity)).toBe('shown');
        expect(phone.pairs()[0].generation).toBe(2);
        expect(w.up()).toHaveLength(1);
    });

    it('an event: its cancelled copy reads, so the tick goes to the next id with no refusal to hear', async () => {
        const w = world();
        Object.assign(w.home, { type: 'event', category: 'community', eventStartAt: '2030-01-01T10:00:00Z', eventEndAt: '2030-01-01T11:00:00Z' });
        const phone = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        await phone.stopShowing('home-1', identity);
        expect(await phone.showOnGlobal(w.home, HOME, identity)).toBe('shown');
        expect(phone.pairs()[0].generation).toBe(1);
        expect(w.sends()).toBe(2);
    });

    it('an event past its 30 days: its row no longer reads and still holds the id', async () => {
        const w = world();
        Object.assign(w.home, { type: 'event', category: 'community', eventStartAt: '2030-01-01T10:00:00Z', eventEndAt: '2030-01-01T11:00:00Z' });
        const phone = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        const first = phone.pairs()[0].copyId;
        await phone.stopShowing('home-1', identity);
        w.rows.get(first)!.status = 'completed';
        expect(await phone.showOnGlobal(w.home, HOME, identity)).toBe('shown');
        expect(phone.pairs()[0].generation).toBe(1);
    });

    it('fetches its photos once, however many ids it tries', async () => {
        const w = world();
        w.home.photos = ['/api/marketplace/posts/home-1/photos/0'];
        await downIds(w, 3);
        await w.device().showOnGlobal(w.home, HOME, identity);
        expect(w.sends()).toBe(4);
        expect(w.photoFetches()).toBe(1);
    });

    it('stops after the ids a send looks at, in plain words, and keeps no pair', async () => {
        const w = world();
        await downIds(w, COPY_IDS_LOOKED_AT);
        const phone = w.device();
        expect(await phone.showOnGlobal(w.home, HOME, identity)).toEqual({ refused: "The global community can't show this yet." });
        expect(w.sends()).toBe(COPY_IDS_LOOKED_AT);
        expect(phone.pairs()).toEqual([]);
    });

    it('finds room on the last id it may try', async () => {
        const w = world();
        await downIds(w, COPY_IDS_LOOKED_AT - 1);
        const phone = w.device();
        expect(await phone.showOnGlobal(w.home, HOME, identity)).toBe('shown');
        expect(phone.pairs()[0].generation).toBe(COPY_IDS_LOOKED_AT - 1);
    });

    it('waiting part way, it keeps the id it reached and the next tend goes on from there', async () => {
        const w = world();
        await downIds(w, 3);
        const phone = w.device();
        w.busyOn(2);
        expect(await phone.showOnGlobal(w.home, HOME, identity)).toBe('later');
        expect(phone.pairs()[0].generation).toBe(1);
        expect(phone.pairs()[0].sent).toBe('');
        await phone.tendCopies(identity);
        expect(phone.pairs()[0].generation).toBe(3);
        expect(phone.pairs()[0].sent).not.toBe('');
        expect(w.up()).toHaveLength(1);
    });

    it('a Stop while it steps stands: nothing more is sent', async () => {
        const w = world();
        await downIds(w, 2);
        const phone = w.device();
        let stopped = false;
        w.onRefused(async () => {
            if (stopped) return;
            stopped = true;
            await phone.stopShowing('home-1', identity);
        });
        expect(await phone.showOnGlobal(w.home, HOME, identity)).toBe('later');
        expect(w.sends()).toBe(1);
        expect(w.up()).toHaveLength(0);
        expect(phone.pairs()).toEqual([]);
    });

    it('a tick made while the listing is off the board is no return from a rest: back on the board, it goes up', async () => {
        const w = world();
        await downIds(w, 1);
        const phone = w.device();
        w.home.status = 'paused';
        expect(await phone.showOnGlobal(w.home, HOME, identity)).toBe('later');
        expect(phone.pairs()[0].resting).toBe(true);
        w.home.status = 'active';
        await phone.tendCopies(identity);
        expect(w.up()).toHaveLength(1);
        expect(phone.pairs()[0].generation).toBe(1);
    });

    it('a global that sends no code yet is as it was: one send, its words, and the pair goes', async () => {
        const w = world({ noCode: true });
        const phone = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        await phone.stopShowing('home-1', identity);
        expect(await phone.showOnGlobal(w.home, HOME, identity)).toEqual({ refused: 'A new post needs an id nothing else has.' });
        expect(w.sends()).toBe(2);
        expect(phone.pairs()).toEqual([]);
    });
});

describe('a rest\'s return never steps: it can\'t tell who took a copy down', () => {
    const bothResting = async () => {
        const w = world();
        const phone = w.device();
        const browser = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        await browser.showOnGlobal(w.home, HOME, identity);
        w.home.status = 'paused';
        await Promise.all([phone.tendCopies(identity), browser.tendCopies(identity)]);
        expect(browser.pairs()[0].resting).toBe(true);
        w.home.status = 'active';
        await phone.tendCopies(identity);
        expect(w.up()).toHaveLength(1);
        return { w, phone, browser };
    };

    it('a Stop after the other device came back stands', async () => {
        const { w, phone, browser } = await bothResting();
        await phone.stopShowing('home-1', identity);
        await browser.tendCopies(identity);
        expect(w.up()).toHaveLength(0);
        expect(browser.pairs()).toEqual([]);
        expect(w.creates()).toBe(2);
    });

    it('so does a moderator\'s takedown', async () => {
        const { w, browser } = await bothResting();
        w.up()[0].status = 'cancelled';
        await browser.tendCopies(identity);
        expect(w.up()).toHaveLength(0);
        expect(browser.pairs()).toEqual([]);
    });

    it('an event\'s neither, though its cancelled copy reads and an id past it looks free', async () => {
        const w = world();
        Object.assign(w.home, { type: 'event', category: 'community', eventStartAt: '2030-01-01T10:00:00Z', eventEndAt: '2030-01-01T11:00:00Z' });
        const phone = w.device();
        const browser = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        await browser.showOnGlobal(w.home, HOME, identity);
        w.setHoliday(true);
        await Promise.all([phone.tendCopies(identity), browser.tendCopies(identity)]);
        expect(browser.pairs()[0].resting).toBe(true);
        w.setHoliday(false);
        await phone.tendCopies(identity);
        expect(w.up()).toHaveLength(1);
        await phone.stopShowing('home-1', identity);
        await browser.tendCopies(identity);
        expect(w.up()).toHaveLength(0);
        expect(browser.pairs()).toEqual([]);
    });

    it('a copy up at a later id is taken up, not let go: the other device has been round a rest without it', async () => {
        const { w, phone, browser } = await bothResting();
        w.home.status = 'paused';
        await phone.tendCopies(identity);
        w.home.status = 'active';
        await phone.tendCopies(identity);
        expect(phone.pairs()[0].generation).toBe(2);
        expect(w.up()).toHaveLength(1);
        await browser.tendCopies(identity);
        expect(browser.pairs()[0].copyId).toBe(phone.pairs()[0].copyId);
        expect(browser.pairs()[0].sent).not.toBe('');
        expect(w.up()).toHaveLength(1);
    });

    it('its own next id free, it comes back as ever', async () => {
        const w = world();
        const phone = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        w.home.status = 'paused';
        await phone.tendCopies(identity);
        w.home.status = 'active';
        await phone.tendCopies(identity);
        expect(phone.pairs()[0].sent).not.toBe('');
        expect(w.up()).toHaveLength(1);
    });
});

/** Both tick, and the phone goes round a rest and its return while the browser isn't opened: the phone holds id 1, the browser id 0. */
async function browserFellBehind(w: ReturnType<typeof world>) {
    const phone = w.device();
    const browser = w.device();
    await phone.showOnGlobal(w.home, HOME, identity);
    await browser.showOnGlobal(w.home, HOME, identity);
    w.home.status = 'paused';
    await phone.tendCopies(identity);
    w.home.status = 'active';
    await phone.tendCopies(identity);
    expect(browser.pairs()[0].generation).toBe(0);
    expect(phone.pairs()[0].generation).toBe(1);
    expect(w.up()).toHaveLength(1);
    return { phone, browser };
}

/** An event round the same rest, by the member's holiday, since a pause is an Offer's or a Need's. */
async function eventFellBehind(w: ReturnType<typeof world>) {
    Object.assign(w.home, { type: 'event', category: 'community', eventStartAt: '2030-01-01T10:00:00Z', eventEndAt: '2030-01-01T11:00:00Z' });
    const phone = w.device();
    const browser = w.device();
    await phone.showOnGlobal(w.home, HOME, identity);
    await browser.showOnGlobal(w.home, HOME, identity);
    w.setHoliday(true);
    await phone.tendCopies(identity);
    w.setHoliday(false);
    await phone.tendCopies(identity);
    expect(phone.pairs()[0].generation).toBe(1);
    expect(w.up()).toHaveLength(1);
    return { phone, browser };
}

describe('Stop showing goes after the listing, whichever device stops it', () => {
    it.each([['An Offer', 'offer'], ['A Need', 'need']])('%s: the device that missed a rest and its return takes down the copy at the later id', async (_kind, type) => {
        const w = world();
        w.home.type = type;
        const { phone, browser } = await browserFellBehind(w);
        expect(await browser.stopShowing('home-1', identity)).toBe(true);
        expect(w.up()).toEqual([]);
        expect(browser.pairs()).toEqual([]);
        // The phone hears of it at its next edit, and lets go: it stands.
        w.home.title = 'Edited on the phone';
        await phone.tendCopies(identity);
        expect(w.up()).toEqual([]);
        expect(phone.pairs()).toEqual([]);
    });

    it('an event: its cancelled copy reads, and the later one still goes', async () => {
        const w = world();
        const { browser } = await eventFellBehind(w);
        expect(await browser.stopShowing('home-1', identity)).toBe(true);
        expect(w.up()).toEqual([]);
    });

    it('a Stop and a new tick on one device, then a Stop on the other', async () => {
        const w = world();
        const phone = w.device();
        const browser = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        await browser.showOnGlobal(w.home, HOME, identity);
        await browser.stopShowing('home-1', identity);
        expect(await browser.showOnGlobal(w.home, HOME, identity)).toBe('shown');
        expect(browser.pairs()[0].generation).toBe(1);
        expect(await phone.stopShowing('home-1', identity)).toBe(true);
        expect(w.up()).toEqual([]);
        expect(phone.pairs()).toEqual([]);
    });

    it('the listing removed at home, which is the same Stop', async () => {
        const w = world();
        const { browser } = await browserFellBehind(w);
        Object.assign(w.home, { status: 'cancelled', active: false });
        expect(await browser.stopShowing('home-1', identity)).toBe(true);
        expect(w.up()).toEqual([]);
    });

    it('the listing gone at home, found by a tend on the device that fell behind', async () => {
        const w = world();
        const { browser } = await browserFellBehind(w);
        Object.assign(w.home, { status: 'cancelled', active: false });
        await browser.tendCopies(identity);
        expect(w.up()).toEqual([]);
        expect(browser.pairs()).toEqual([]);
    });

    it('a resting device reads too: the other came back at the very id it is waiting on', async () => {
        const w = world();
        const phone = w.device();
        const browser = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        await browser.showOnGlobal(w.home, HOME, identity);
        w.home.status = 'paused';
        await Promise.all([phone.tendCopies(identity), browser.tendCopies(identity)]);
        w.home.status = 'active';
        await phone.tendCopies(identity);
        expect(browser.pairs()[0].resting).toBe(true);
        expect(browser.pairs()[0].copyId).toBe(phone.pairs()[0].copyId);
        expect(await browser.stopShowing('home-1', identity)).toBe(true);
        expect(w.up()).toEqual([]);
        expect(browser.pairs()).toEqual([]);
    });

    it('a read with no answer keeps the pair leaving and says so; the tend finishes it', async () => {
        const w = world();
        const { browser } = await browserFellBehind(w);
        w.silentOn(() => true);
        expect(await browser.stopShowing('home-1', identity)).toBe(false);
        expect(browser.pairs()[0].leaving).toBe(true);
        expect(await browser.pairOf('home-1', publicKey)).toBeNull();
        expect(w.up()).toHaveLength(1);
        w.silentOn(null);
        await browser.tendCopies(identity);
        expect(w.up()).toEqual([]);
        expect(browser.pairs()).toEqual([]);
    });

    it('a read lost on the way is the same: it answers false, never a throw', async () => {
        const w = world();
        const { browser } = await browserFellBehind(w);
        w.loseReads(true);
        await expect(browser.stopShowing('home-1', identity)).resolves.toBe(false);
        expect(browser.pairs()[0].leaving).toBe(true);
        w.loseReads(false);
        await browser.tendCopies(identity);
        expect(w.up()).toEqual([]);
    });

    it('a resting pair whose read gets no answer can\'t tell either: it says it will come down, and the tend finishes it', async () => {
        const w = world();
        const phone = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        w.home.status = 'paused';
        await phone.tendCopies(identity);
        w.silentOn(() => true);
        expect(await phone.stopShowing('home-1', identity)).toBe(false);
        expect(await phone.pairOf('home-1', publicKey)).toBeNull();
        w.silentOn(null);
        w.home.status = 'active';
        await phone.tendCopies(identity);
        expect(phone.pairs()).toEqual([]);
        expect(w.up()).toEqual([]);
        expect(w.creates()).toBe(1);
    });

    it('the later id\'s remove unanswered: not done, and the tend finishes it', async () => {
        const w = world();
        const { phone, browser } = await browserFellBehind(w);
        const later = phone.pairs()[0].copyId;
        w.removeAnswers((id) => (id === later ? w.json({ error: 'Busy' }, 503) : null));
        expect(await browser.stopShowing('home-1', identity)).toBe(false);
        expect(browser.pairs()[0].leaving).toBe(true);
        expect(w.up()).toHaveLength(1);
        w.removeAnswers(null);
        await browser.tendCopies(identity);
        expect(w.up()).toEqual([]);
        expect(browser.pairs()).toEqual([]);
    });

    it('a remove refused with the copy still up: not done, on one device too', async () => {
        const w = world();
        const phone = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        w.removeAnswers(() => w.json({ error: 'Not now' }, 403));
        expect(await phone.stopShowing('home-1', identity)).toBe(false);
        expect(w.up()).toHaveLength(1);
        expect(phone.pairs()[0].leaving).toBe(true);
        w.removeAnswers(null);
        await phone.tendCopies(identity);
        expect(w.up()).toEqual([]);
        expect(phone.pairs()).toEqual([]);
    });

    it('a second Stop on a pair still leaving asks again: a Stop out of sight is no Stop done', async () => {
        const w = world();
        const { browser } = await browserFellBehind(w);
        w.silentOn(() => true);
        expect(await browser.stopShowing('home-1', identity)).toBe(false);
        expect(await browser.stopShowing('home-1', identity)).toBe(false);
        w.silentOn(null);
        expect(await browser.stopShowing('home-1', identity)).toBe(true);
        expect(w.up()).toEqual([]);
        expect(browser.pairs()).toEqual([]);
    });

    it('a new tick on this device outlives the Stop still leaving: the retry doesn\'t take down what was asked for since', async () => {
        const w = world();
        const { phone } = await eventFellBehind(w);
        // The remove lands and the read goes unanswered, so id 1 stays leaving; the tick then finds ids 0 and 1 down and goes to 2.
        const leaving = phone.pairs()[0].copyId;
        w.silentOn(() => true);
        expect(await phone.stopShowing('home-1', identity)).toBe(false);
        w.silentOn(null);
        expect(await phone.showOnGlobal(w.home, HOME, identity)).toBe('shown');
        const live = phone.pairs().find((p) => !p.leaving)!;
        expect(live.generation).toBe(2);
        expect(phone.pairs().find((p) => p.leaving)?.copyId).toBe(leaving);
        await phone.tendCopies(identity);
        expect(w.up().map((r) => r.id)).toEqual([live.copyId]);
        expect(phone.pairs().map((p) => p.copyId)).toEqual([live.copyId]);
    });

    it('only a live pair counts as that tick: another on its way out doesn\'t stop a Stop going after the listing', async () => {
        const w = world();
        const { phone } = await eventFellBehind(w);
        w.silentOn(() => true);
        await phone.stopShowing('home-1', identity);
        w.silentOn(null);
        await phone.showOnGlobal(w.home, HOME, identity);
        // A third device moves the copy on past both of the phone's pairs.
        const tablet = w.device();
        expect(await tablet.showOnGlobal(w.home, HOME, identity)).toBe('shown');
        w.setHoliday(true);
        await tablet.tendCopies(identity);
        w.setHoliday(false);
        await tablet.tendCopies(identity);
        expect(w.up()).toHaveLength(1);
        expect(await phone.stopShowing('home-1', identity)).toBe(true);
        expect(w.up()).toEqual([]);
    });
});

describe('a rest goes by the listing too: a copy moved on is this device\'s to take up and rest', () => {
    it('the listing paused, the device behind takes up the copy the other holds, and rests it', async () => {
        const w = world();
        const { phone, browser } = await browserFellBehind(w);
        const later = phone.pairs()[0].copyId;
        w.home.status = 'paused';
        await browser.tendCopies(identity);
        expect(w.up()).toEqual([]);
        expect(browser.pairs()[0].resting).toBe(true);
        expect(browser.pairs()[0].generation).toBe(2);
        expect(browser.pairs()[0].earlierIds).toContain(later);
        // Its return is one copy, and the phone that slept through it all can still stop it.
        w.home.status = 'active';
        await browser.tendCopies(identity);
        expect(w.up()).toHaveLength(1);
        expect(await phone.stopShowing('home-1', identity)).toBe(true);
        expect(w.up()).toEqual([]);
    });

    it('nothing up at any id: the pair lets go, as it did', async () => {
        const w = world();
        const { phone, browser } = await browserFellBehind(w);
        await phone.stopShowing('home-1', identity);
        expect(w.up()).toEqual([]);
        w.home.status = 'paused';
        await browser.tendCopies(identity);
        expect(browser.pairs()).toEqual([]);
        w.home.status = 'active';
        await browser.tendCopies(identity);
        expect(w.up()).toEqual([]);
    });

    it('its read unanswered, the rest waits: a rest past a copy it couldn\'t see leaves that copy up', async () => {
        const w = world();
        const { browser } = await browserFellBehind(w);
        const before = browser.pairs()[0];
        w.home.status = 'paused';
        w.silentOn((q) => q.has('ids'));
        await browser.tendCopies(identity);
        expect(browser.pairs()).toEqual([before]);
        expect(w.up()).toHaveLength(1);
        w.silentOn(null);
        await browser.tendCopies(identity);
        expect(w.up()).toEqual([]);
    });

    it('a copy global\'s reports hold at the later id: the rest waits on that one, and the pair stays with it', async () => {
        const w = world();
        const { phone, browser } = await browserFellBehind(w);
        w.up()[0].hiddenByReportsAt = '2030-01-01T00:00:00Z';
        w.home.status = 'paused';
        await browser.tendCopies(identity);
        expect(w.up()).toHaveLength(1);
        expect(browser.pairs()[0].copyId).toBe(phone.pairs()[0].copyId);
        expect(browser.pairs()[0].resting).toBeFalsy();
    });

    it('an edit on the device that fell behind follows the copy, so a removal at home there still reaches it', async () => {
        const w = world();
        const { phone, browser } = await browserFellBehind(w);
        w.home.title = 'Edited in the browser';
        await browser.tendCopies(identity);
        expect(browser.pairs()[0]?.copyId).toBe(phone.pairs()[0].copyId);
        await browser.tendCopies(identity);
        expect(w.up().map((r) => r.title)).toEqual(['Edited in the browser']);
        Object.assign(w.home, { status: 'cancelled', active: false });
        expect(await browser.stopShowing('home-1', identity)).toBe(true);
        expect(w.up()).toEqual([]);
    });

    it('its own copy up, it rests as it did, one device or two', async () => {
        const w = world();
        const phone = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        w.home.status = 'paused';
        await phone.tendCopies(identity);
        expect(w.up()).toEqual([]);
        expect(phone.pairs()[0].resting).toBe(true);
        expect(phone.pairs()[0].generation).toBe(1);
    });
});

/** A tick left waiting for global, on its first answer. */
async function tickWaiting(w: ReturnType<typeof world>) {
    const device = w.device();
    w.busyOn(1);
    expect(await device.showOnGlobal(w.home, HOME, identity)).toBe('later');
    expect(device.pairs()[0].sent).toBe('');
    return device;
}

/** The first send landed and its answer never came: the row is up, and the pair has nothing in `sent`. */
async function tickLandedUnheard(w: ReturnType<typeof world>) {
    const device = await tickWaiting(w);
    const id = device.pairs()[0].copyId;
    w.rows.set(id, { id, type: w.home.type as string, status: 'active', title: w.home.title });
    return device;
}

/** Runs `then` during the read a rest of a waiting tick adds, the second of a tend's on global, after `restMustWait`'s. */
function duringTheTicksRead(w: ReturnType<typeof world>, then: () => Promise<unknown> | void) {
    let reads = 0;
    w.onRead(async () => {
        if (++reads === 2) await then();
    });
}

/** The phone's tick waits, the phone tends with the listing off the board, the listing is back, and the browser ticks. */
async function tickRestedWaiting(w: ReturnType<typeof world>, off: (on: boolean) => void) {
    const phone = await tickWaiting(w);
    const browser = w.device();
    off(true);
    await phone.tendCopies(identity);
    expect(phone.pairs()[0].resting).toBe(true);
    off(false);
    expect(await browser.showOnGlobal(w.home, HOME, identity)).toBe('shown');
    expect(w.up()).toHaveLength(1);
    return { phone, browser };
}

describe('a tick that never landed rests where it is: nothing took its id, and the other device\'s first tick lands there', () => {
    const listings = [['An Offer', 'offer'], ['A Need', 'need']];
    const paused = (w: ReturnType<typeof world>) => (on: boolean) => { w.home.status = on ? 'paused' : 'active'; };

    it.each(listings)('%s: back from the rest, it takes up that copy, so one listing is one row', async (_kind, type) => {
        const w = world();
        w.home.type = type;
        const { phone, browser } = await tickRestedWaiting(w, paused(w));
        await phone.tendCopies(identity);
        await browser.tendCopies(identity);
        expect(w.up()).toHaveLength(1);
        expect(phone.pairs()[0].copyId).toBe(browser.pairs()[0].copyId);
        expect(phone.pairs()[0].sent).not.toBe('');
        expect(w.creates()).toBe(1);
    });

    it.each(listings)('%s: back from the rest, a Stop on it takes down all there is', async (_kind, type) => {
        const w = world();
        w.home.type = type;
        const { phone } = await tickRestedWaiting(w, paused(w));
        await phone.tendCopies(identity);
        expect(await phone.stopShowing('home-1', identity)).toBe(true);
        expect(w.up()).toEqual([]);
    });

    it.each(listings)('%s: a Stop while it rests finds that copy, and is true only once it is down', async (_kind, type) => {
        const w = world();
        w.home.type = type;
        const { phone } = await tickRestedWaiting(w, paused(w));
        expect(await phone.stopShowing('home-1', identity)).toBe(true);
        expect(w.up()).toEqual([]);
        expect(phone.pairs()).toEqual([]);
    });

    it('an event, by a holiday, the same', async () => {
        const w = world();
        Object.assign(w.home, { type: 'event', category: 'community', eventStartAt: '2030-01-01T10:00:00Z', eventEndAt: '2030-01-01T11:00:00Z' });
        const { phone, browser } = await tickRestedWaiting(w, (on) => w.setHoliday(on));
        await phone.tendCopies(identity);
        expect(w.up()).toHaveLength(1);
        expect(phone.pairs()[0].copyId).toBe(browser.pairs()[0].copyId);
        expect(await phone.stopShowing('home-1', identity)).toBe(true);
        expect(w.up()).toEqual([]);
    });

    it('the control: the same two ticks with no rest between are one row', async () => {
        const w = world();
        const phone = await tickWaiting(w);
        expect(await w.device().showOnGlobal(w.home, HOME, identity)).toBe('shown');
        await phone.tendCopies(identity);
        expect(w.up()).toHaveLength(1);
        expect(w.creates()).toBe(1);
    });

    it('a tick on a row left stale rests the same way: it sits in the rest, not the tend', async () => {
        const w = world();
        const phone = await tickWaiting(w);
        const browser = w.device();
        const id = phone.pairs()[0].copyId;
        w.home.status = 'paused';
        expect(await phone.showOnGlobal(w.home, HOME, identity)).toBe('later');
        expect(phone.pairs()[0]).toMatchObject({ resting: true, copyId: id });
        w.home.status = 'active';
        await browser.showOnGlobal(w.home, HOME, identity);
        await phone.tendCopies(identity);
        expect(w.up()).toHaveLength(1);
        expect(phone.pairs()[0].sent).not.toBe('');
    });

    it('one device on its own comes back as ever: one send, one row, and a Stop ends it', async () => {
        const w = world();
        const phone = await tickWaiting(w);
        w.home.status = 'paused';
        await phone.tendCopies(identity);
        expect(w.up()).toEqual([]);
        w.home.status = 'active';
        await phone.tendCopies(identity);
        expect(w.up()).toHaveLength(1);
        expect(w.creates()).toBe(1);
        expect(phone.pairs()[0].sent).not.toBe('');
        expect(await phone.stopShowing('home-1', identity)).toBe(true);
        expect(w.up()).toEqual([]);
    });

    it('a first answer lost reads as up: that copy comes down, and the pair moves on as any rest does', async () => {
        const w = world();
        const phone = await tickLandedUnheard(w);
        const id = phone.pairs()[0].copyId;
        w.home.status = 'paused';
        await phone.tendCopies(identity);
        expect(w.up()).toEqual([]);
        expect(w.removes).toEqual([id]);
        expect(phone.pairs()[0]).toMatchObject({ resting: true, generation: 1 });
        expect(phone.pairs()[0].leaving).toBeFalsy();
        w.home.status = 'active';
        await phone.tendCopies(identity);
        expect(w.up()).toHaveLength(1);
        expect(phone.pairs()[0].sent).not.toBe('');
    });

    it('that remove landing and its answer lost: the retry doesn\'t stop to read, or the pair is stuck leaving', async () => {
        const w = world();
        const phone = await tickLandedUnheard(w);
        const id = phone.pairs()[0].copyId;
        w.removeAnswers(() => {
            w.rows.get(id)!.status = 'cancelled';
            return w.json({ error: 'Busy' }, 503);
        });
        w.home.status = 'paused';
        await phone.tendCopies(identity);
        expect(phone.pairs()[0]).toMatchObject({ resting: true, leaving: true, copyId: id });
        w.removeAnswers(null);
        await phone.tendCopies(identity);
        expect(phone.pairs()[0]).toMatchObject({ resting: true, generation: 1 });
        expect(phone.pairs()[0].leaving).toBeFalsy();
        w.home.status = 'active';
        await phone.tendCopies(identity);
        expect(w.up()).toHaveLength(1);
    });

    it('its read unanswered, it waits as it is, and the next tend rests it', async () => {
        const w = world();
        const phone = await tickWaiting(w);
        let reads = 0;
        w.silentOn(() => ++reads === 2);
        w.home.status = 'paused';
        await phone.tendCopies(identity);
        expect(reads).toBe(2);
        expect(phone.pairs()[0]).toMatchObject({ sent: '', generation: 0 });
        expect(phone.pairs()[0].resting).toBeFalsy();
        await phone.tendCopies(identity);
        expect(phone.pairs()[0]).toMatchObject({ resting: true, generation: 0 });
        expect(w.removes).toEqual([]);
    });

    it('that read lost on the way answers a tick with later, never a throw', async () => {
        const w = world();
        const phone = await tickWaiting(w);
        let reads = 0;
        w.onRead(() => {
            if (++reads === 2) throw new TypeError('Network request failed');
        });
        w.home.status = 'paused';
        await expect(phone.showOnGlobal(w.home, HOME, identity)).resolves.toBe('later');
        expect(phone.pairs()[0].resting).toBeFalsy();
    });

    it('a Stop landing during its read stands: the pair stays gone', async () => {
        const w = world();
        const phone = await tickWaiting(w);
        duringTheTicksRead(w, () => phone.stopShowing('home-1', identity));
        w.home.status = 'paused';
        await phone.tendCopies(identity);
        expect(phone.pairs()).toEqual([]);
        w.home.status = 'active';
        await phone.tendCopies(identity);
        expect(w.up()).toEqual([]);
    });

    it('a Stop still leaving when its read comes back stays a Stop: no rest takes it over, and nothing comes back', async () => {
        const w = world();
        const phone = await tickWaiting(w);
        duringTheTicksRead(w, async () => {
            w.silentOn((q) => q.has('ids'));
            expect(await phone.stopShowing('home-1', identity)).toBe(false);
            w.silentOn(null);
        });
        w.home.status = 'paused';
        await phone.tendCopies(identity);
        expect(phone.pairs()[0].leaving).toBe(true);
        expect(phone.pairs()[0].resting).toBeFalsy();
        w.home.status = 'active';
        await phone.tendCopies(identity);
        await phone.tendCopies(identity);
        expect(phone.pairs()).toEqual([]);
        expect(w.up()).toEqual([]);
    });

    it('a Stop landing during its read of a copy that is up stands too: the pair isn\'t written back', async () => {
        const w = world();
        const phone = await tickLandedUnheard(w);
        duringTheTicksRead(w, () => phone.stopShowing('home-1', identity));
        w.home.status = 'paused';
        await phone.tendCopies(identity);
        expect(phone.pairs()).toEqual([]);
        w.home.status = 'active';
        await phone.tendCopies(identity);
        expect(phone.pairs()).toEqual([]);
        expect(w.up()).toEqual([]);
        expect(w.creates()).toBe(0);
    });

    it('and a Stop still leaving over a copy that is up stays a Stop: the rest doesn\'t go on and take it over', async () => {
        const w = world();
        const phone = await tickLandedUnheard(w);
        duringTheTicksRead(w, async () => {
            w.silentOn((q) => q.has('ids'));
            expect(await phone.stopShowing('home-1', identity)).toBe(false);
            w.silentOn(null);
        });
        w.home.status = 'paused';
        await phone.tendCopies(identity);
        expect(phone.pairs()[0].leaving).toBe(true);
        expect(phone.pairs()[0].resting).toBeFalsy();
        w.home.status = 'active';
        await phone.tendCopies(identity);
        await phone.tendCopies(identity);
        expect(phone.pairs()).toEqual([]);
        expect(w.up()).toEqual([]);
    });

    it('the rest is that pair\'s alone: a waiting tick on another listing stays as it is', async () => {
        const w = world();
        const phone = await tickWaiting(w);
        const other = { ...w.home, id: 'home-2' };
        w.busyOn(1);
        expect(await phone.showOnGlobal(other, HOME, identity)).toBe('later');
        w.home.status = 'paused';
        expect(await phone.showOnGlobal(w.home, HOME, identity)).toBe('later');
        const byHome = (id: string) => phone.pairs().find((p) => p.homeId === id)!;
        expect(byHome('home-1').resting).toBe(true);
        expect(byHome('home-2').resting).toBeFalsy();
    });

    it('a send landing during its read isn\'t rested as if it had none: its copy comes down at the next tend', async () => {
        const w = world();
        const phone = await tickWaiting(w);
        duringTheTicksRead(w, async () => {
            w.home.status = 'active';
            expect(await phone.showOnGlobal(w.home, HOME, identity)).toBe('shown');
            w.home.status = 'paused';
        });
        w.home.status = 'paused';
        await phone.tendCopies(identity);
        expect(phone.pairs()[0].sent).not.toBe('');
        expect(phone.pairs()[0].resting).toBeFalsy();
        w.onRead(null);
        await phone.tendCopies(identity);
        expect(w.up()).toEqual([]);
        expect(phone.pairs()[0]).toMatchObject({ resting: true, generation: 1 });
    });
});

describe('what stays, each pinned so a change to it is seen', () => {
    it('a Stop still leaving on one device takes down a tick the other made since: that Stop came first, and the other reads Shown', async () => {
        const w = world();
        const phone = w.device();
        const browser = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        w.silentOn(() => true);
        expect(await phone.stopShowing('home-1', identity)).toBe(false);
        w.silentOn(null);
        expect(await browser.showOnGlobal(w.home, HOME, identity)).toBe('shown');
        expect(w.up()).toHaveLength(1);
        await phone.tendCopies(identity);
        expect(w.up()).toEqual([]);
        expect(await browser.pairOf('home-1', publicKey)).not.toBeNull();
    });

    it('a device with no pair asks nothing, so a removal at home there leaves the copy the other holds until that one opens', async () => {
        const w = world();
        const phone = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        Object.assign(w.home, { status: 'cancelled', active: false });
        expect(await w.device().stopShowing('home-1', identity)).toBe(true);
        expect(w.up()).toHaveLength(1);
        await phone.tendCopies(identity);
        expect(w.up()).toEqual([]);
    });

    it('a resting device reads nothing at a tend: a copy the other brought back, and paused again here, waits for that device', async () => {
        const w = world();
        const phone = w.device();
        const browser = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        await browser.showOnGlobal(w.home, HOME, identity);
        w.home.status = 'paused';
        await Promise.all([phone.tendCopies(identity), browser.tendCopies(identity)]);
        w.home.status = 'active';
        await phone.tendCopies(identity);
        w.home.status = 'paused';
        await browser.tendCopies(identity);
        expect(w.up()).toHaveLength(1);
        await phone.tendCopies(identity);
        expect(w.up()).toEqual([]);
    });

    it('a tick on a row left stale rests by its own id, with no look: only a tend goes by the listing', async () => {
        const w = world();
        const { browser } = await browserFellBehind(w);
        w.home.status = 'paused';
        expect(await browser.showOnGlobal(w.home, HOME, identity)).toBe('later');
        expect(browser.pairs()[0].resting).toBe(true);
        expect(w.up()).toHaveLength(1);
    });

    it('a tick still waiting comes back past a takedown it can\'t see, a moderator\'s as a Stop: it reads Shown, and a Stop there stands', async () => {
        const w = world();
        const { phone } = await tickRestedWaiting(w, (on) => { w.home.status = on ? 'paused' : 'active'; });
        w.up()[0].status = 'cancelled';
        await phone.tendCopies(identity);
        expect(w.up()).toHaveLength(1);
        expect(phone.pairs()[0].generation).toBe(1);
        expect(await phone.stopShowing('home-1', identity)).toBe(true);
        expect(w.up()).toEqual([]);
    });

    it('a return whose answer was lost, then a pause: the copy stays up until the listing is back, and a Stop still finds it', async () => {
        const w = world();
        const phone = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        w.home.status = 'paused';
        await phone.tendCopies(identity);
        w.home.status = 'active';
        w.busyOn(1);
        await phone.tendCopies(identity);
        const id = phone.pairs()[0].copyId;
        w.rows.set(id, { id, type: 'offer', status: 'active', title: w.home.title });
        w.home.status = 'paused';
        await phone.tendCopies(identity);
        expect(w.up()).toHaveLength(1);
        expect(await phone.stopShowing('home-1', identity)).toBe(true);
        expect(w.up()).toEqual([]);
    });

    it('a tick over a Stop still leaving, the listing off the board: it takes the leaving pair\'s place, the copy waits for the listing, and a Stop still finds it', async () => {
        const w = world();
        const phone = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        w.removeAnswers(() => w.json({ error: 'Busy' }, 503));
        expect(await phone.stopShowing('home-1', identity)).toBe(false);
        w.removeAnswers(null);
        w.home.status = 'paused';
        expect(await phone.showOnGlobal(w.home, HOME, identity)).toBe('later');
        await phone.tendCopies(identity);
        expect(phone.pairs()).toHaveLength(1);
        expect(w.up()).toHaveLength(1);
        expect(await phone.stopShowing('home-1', identity)).toBe(true);
        expect(w.up()).toEqual([]);
    });

    it('a copy past the ids looked at isn\'t seen: a Stop there says done', async () => {
        const w = world();
        const phone = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        const past = await copyIdOf('home-1', COPY_IDS_LOOKED_AT, sign);
        w.rows.set(past, { id: past, type: 'offer', status: 'active', title: 'Far on' });
        expect(await phone.stopShowing('home-1', identity)).toBe(true);
        expect(w.up().map((r) => r.id)).toEqual([past]);
    });
});

describe('what a Stop and a tend cost: the look is bounded, and only where something is on its way down', () => {
    it('one device, one Stop: the remove and one read of COPY_IDS_LOOKED_AT ids', async () => {
        const w = world();
        const phone = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        const id = phone.pairs()[0].copyId;
        w.reads.length = 0;
        w.removes.length = 0;
        expect(await phone.stopShowing('home-1', identity)).toBe(true);
        expect(w.removes).toEqual([id]);
        expect(w.reads.map((ids) => ids.length)).toEqual([COPY_IDS_LOOKED_AT]);
        expect(w.reads[0][0]).toBe(id);
    });

    it('fallen behind: one remove more, and no second read', async () => {
        const w = world();
        const { browser } = await browserFellBehind(w);
        w.reads.length = 0;
        w.removes.length = 0;
        await browser.stopShowing('home-1', identity);
        expect(w.removes).toHaveLength(2);
        expect(w.reads).toHaveLength(1);
    });

    it('a resting pair: the read and no remove', async () => {
        const w = world();
        const phone = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        w.home.status = 'paused';
        await phone.tendCopies(identity);
        w.reads.length = 0;
        w.removes.length = 0;
        await phone.stopShowing('home-1', identity);
        expect(w.removes).toEqual([]);
        expect(w.reads).toHaveLength(1);
    });

    it('no pair on this device: a Stop or a removal at home asks global nothing', async () => {
        const w = world();
        expect(await w.device().stopShowing('home-1', identity)).toBe(true);
        expect(w.reads).toEqual([]);
        expect(w.removes).toEqual([]);
    });

    it('a tend reads global for no landed pair that has nothing to do', async () => {
        const w = world();
        const phone = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        w.reads.length = 0;
        await phone.tendCopies(identity);
        await phone.tendCopies(identity);
        expect(w.reads).toEqual([]);
    });

    it('a rest reads global as many times as it did: the look replaces the one by its own id', async () => {
        const w = world();
        const phone = w.device();
        await phone.showOnGlobal(w.home, HOME, identity);
        w.reads.length = 0;
        w.home.status = 'paused';
        await phone.tendCopies(identity);
        expect(w.reads.map((ids) => ids.length)).toEqual([COPY_IDS_LOOKED_AT, 1]);
    });

    it('a tick that never landed reads its own id once more, at the one tend that rests it, and costs nothing after', async () => {
        const w = world();
        const phone = await tickWaiting(w);
        const id = phone.pairs()[0].copyId;
        w.reads.length = 0;
        w.home.status = 'paused';
        await phone.tendCopies(identity);
        expect(w.reads).toEqual([[id], [id]]);
        expect(w.removes).toEqual([]);
        w.reads.length = 0;
        await phone.tendCopies(identity);
        await phone.tendCopies(identity);
        expect(w.reads).toEqual([]);
    });
});
