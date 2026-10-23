/**
 * The Tool shed's four screens on the web (scratch/tools/DESIGN-tool-template-fable.md §3.1, §6 row T1.3: "the same in
 * vitest and a browser at 320 px"), drawn through the tools' covered page (pages/ToolsPage.tsx) with the tool as the
 * registry ships it (tools/index.ts), its document and photos in this browser's store (an in-memory IndexedDB), and the
 * community's server a stand-in that answers what these screens ask: the member's Offers and deals, pause and resume,
 * the price guide, the private copy.
 *
 * The phone's twin is apps/native/tools/things/__tests__/things-screens.test.ts, the same behaviours. Here too: every
 * screen with a real thing in it in the pseudo-locale `xx` (every word through t()), and every colour class with its dark
 * pair or a theme role (the template's generic test, tools/__tests__/tools-template.test.tsx, draws each screen with each
 * fixture at 320 px × 1.3 with axe). The real-browser check at 320 px is e2e/tool-shed-320.mjs.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
    THINGS, THINGS_DOC_BYTES, TOOL_LIMITS, backAroundIn, lendOutside, readThingsDoc, shedRoom, shedThings, thingCategory, toolDocBytes,
    type Thing, type ThingsDoc,
} from '@beanpool/core';
import { ToolsPage, type ToolsPageProps } from '../../../pages/ToolsPage';
import { TOOL_APPS } from '../../index';
import { ToolDocNotKept, ToolDocTooBig } from '../../builder';
import { openToolCopy, pageNode } from '../../node-copy';
import { readToolPhoto, readToolRecord, readToolSettings, resetToolStoreForTest, writeToolRecord } from '../../store';
import { keep as keepThings } from '../parts';
import { memoryIndexedDB, MemoryIDBKeyRange } from '../../../lib/memory-indexeddb';
import { resetAccountEpochForTest } from '../../../lib/account-epoch';
import { backToEnglish, bypassing, showIn } from '../../../words-xx.test-support';

/** The Tool shed's fixtures (never shipped): from core's sources, as the template's generic tests read them. */
let FIXTURES: { docs: { empty: ThingsDoc; small: ThingsDoc; full: ThingsDoc }; now: number };
beforeAll(async () => {
    const at = '../../../../../../packages/beanpool-core/src/tools/things/fixtures.ts';
    FIXTURES = (await import(/* @vite-ignore */ at)).FIXTURES;
    expect(FIXTURES.now).toBe(NOW);
});

const info = vi.hoisted(() => ({ value: { profile: 'local', features: { beans: true } } as { profile: string; features: Record<string, unknown> } | null }));
vi.mock('../../../lib/features', () => ({ useCommunityInfo: () => info.value }));

// The browser's file picker and canvas: a chosen picture, drawn at 800 px (jsdom has no canvas).
const picked = vi.hoisted(() => ({ count: 0, cancel: false, sizes: [] as number[], refs: [] as string[] }));
vi.mock('../../photos', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../photos')>();
    return {
        ...real,
        chooseImageFile: async () => (picked.cancel ? null : new File(['jpeg bytes'], 'picked.jpg', { type: 'image/jpeg' })),
        keepChosen: (owner: string, tool: string, file: File | null, ref: string) => real.keepChosen(owner, tool, file, ref, async () => {
            picked.refs.push(ref);
            picked.count++;
            picked.sizes.push(800);
            return { dataUrl: `data:image/jpeg;base64,cGhvdG8${picked.count}`, width: 800, height: 600 };
        }),
    };
});

// This browser's store, as when it can't keep a write (no IndexedDB, a full disk): `on` refuses the document's writes.
const storeFails = vi.hoisted(() => ({ on: false }));
vi.mock('../../store', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../store')>();
    return { ...real, keepToolDoc: async (...a: Parameters<typeof real.keepToolDoc>) => (storeFails.on ? false : real.keepToolDoc(...a)) };
});

const OWNER = 'things-web-owner';
const identity = { publicKey: OWNER, privateKey: '', callsign: 'Robin', createdAt: '2026-10-01T00:00:00.000Z' };
/** The fixtures' moment. */
const NOW = Date.parse('2026-10-20T09:00:00.000Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const thing = (id: string, name: string, extra: Partial<Thing> = {}): Thing => ({ id, name, category: 'tools', createdAt: iso(NOW - DAY), updatedAt: iso(NOW - DAY), ...extra });
const shed = (...things: Thing[]): ThingsDoc => ({ v: 1, things });

/**
 * The community's server, as these screens use it; `down` when it can't be reached, `dealsDown` when only the deals
 * can't be read, and `dealsGate` holds a read of the deals until it settles. `copy` is its own copy of the shed (from the
 * member's other device), none when null; `copyGate` holds a read of it and `marketGate` a pause or resume until each
 * settles; `puts` are the documents sent to it. Each pause or resume asked is in `asks`. `readGate` holds the next read
 * of one Offer, its answer as the Offer stood when asked, until it settles (a slow reply on a poor link). A shop closed for now
 * (`closeShop`) paused what is in `shopHeld` and refuses to put back up anything in `inClosedShop` (409 shop_paused); its
 * reopen puts back what it still holds.
 */
const server = {
    posts: new Map<string, Record<string, unknown>>(),
    asks: [] as string[],
    shopHeld: new Set<string>(),
    inClosedShop: new Set<string>(),
    deals: [] as Array<Record<string, unknown>>,
    guide: { items: [] as unknown[] },
    paused: [] as string[], resumed: [] as string[],
    requests: [] as string[],
    down: false,
    dealsDown: false,
    dealsGate: null as Promise<void> | null,
    copy: null as { doc: ThingsDoc; updatedAt: string } | null,
    /** The `max` the server answers for the shed's copy: none is today's stand-in; 65536 is a server from before 128 KB. */
    max: undefined as number | undefined,
    copyGate: null as Promise<void> | null,
    marketGate: null as Promise<void> | null,
    readGate: null as Promise<void> | null,
    puts: [] as unknown[],
};
function offer(id: string, title: string, status = 'active', extra: Record<string, unknown> = {}) {
    server.posts.set(id, { id, title, status, type: 'offer', authorPublicKey: OWNER, priceType: 'fixed', ...extra });
}
/** The member's shop "closed for now" on the server, holding these Offers (engine/shops.ts): the live ones are paused. */
function closeShop(...ids: string[]) {
    for (const id of ids) {
        const p = server.posts.get(id)!;
        if (p.status === 'active') { p.status = 'paused'; server.shopHeld.add(id); }
        server.inClosedShop.add(id);
    }
}
/** Reopened: what the shop paused and still holds is back up; the rest stays as it is. */
function reopenShop() {
    for (const id of server.shopHeld) { const p = server.posts.get(id); if (p?.status === 'paused') p.status = 'active'; }
    server.shopHeld.clear();
    server.inClosedShop.clear();
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
/** One page of a list, as the node pages one (clampLimit, clampOffset in https-server.ts): 50 rows unless asked, at most 200. */
function page<T>(rows: T[], url: URL): T[] {
    const asked = Math.floor(Number(url.searchParams.get('limit')));
    const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 200) : 50;
    const offset = Math.max(0, Math.floor(Number(url.searchParams.get('offset'))) || 0);
    return rows.slice(offset, offset + limit);
}
async function answer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input), 'https://mullum.example');
    const method = (init?.method ?? 'GET').toUpperCase();
    server.requests.push(`${method} ${url.pathname}`);
    if (server.down) throw new TypeError('Failed to fetch');
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    switch (`${method} ${url.pathname}`) {
        case 'GET /api/tools/things':
            if (server.copyGate) await server.copyGate;
            return json({ tool: 'things', doc: server.copy?.doc ?? null, updatedAt: server.copy?.updatedAt ?? null, ...(server.max ? { max: server.max } : {}) });
        case 'PUT /api/tools/things':
            server.puts.push(body.doc);
            return json({ success: true, tool: 'things', updatedAt: '2026-10-21T08:00:00.000Z', ...(server.max ? { max: server.max } : {}) });
        case 'GET /api/marketplace/posts': {
            const id = url.searchParams.get('id');
            const author = url.searchParams.get('author');
            const all = [...server.posts.values()];
            if (id && server.readGate) {
                const asked = all.filter((p) => p.id === id).map((p) => ({ ...p }));
                const gate = server.readGate;
                server.readGate = null;
                await gate;
                return json(asked);
            }
            return json(id ? all.filter((p) => p.id === id) : page(all.filter((p) => !author || p.authorPublicKey === author), url));
        }
        case 'GET /api/marketplace/transactions': {
            if (server.dealsGate) await server.dealsGate;
            if (server.dealsDown) throw new TypeError('Failed to fetch');
            const who = url.searchParams.get('publicKey');
            const status = url.searchParams.get('status');
            return json(page(server.deals.filter((d) => (d.sellerPublicKey === who || d.buyerPublicKey === who) && (!status || d.status === status)), url));
        }
        // As the node has them (posts.ts, routes/marketplace.ts): a live Offer is paused (`paused`), and the owner's pause of
        // one already paused is taken, making a shop's pause theirs; only a paused one is resumed, never one in a shop
        // closed for now (409 shop_paused); anything else is a 400.
        case 'POST /api/marketplace/posts/pause': {
            server.asks.push(`pause ${body.postId}`);
            if (server.marketGate) await server.marketGate;
            const p = server.posts.get(body.postId);
            if (p?.status === 'paused' && p.authorPublicKey === body.authorPublicKey) { server.shopHeld.delete(body.postId); return json({ success: true }); }
            if (p?.status !== 'active') return json({ success: false, error: 'Post not found, not active, or not owned by author' }, 400);
            server.paused.push(body.postId);
            p.status = 'paused';
            return json({ success: true });
        }
        case 'POST /api/marketplace/posts/resume': {
            server.asks.push(`resume ${body.postId}`);
            if (server.marketGate) await server.marketGate;
            const p = server.posts.get(body.postId);
            if (server.inClosedShop.has(body.postId)) {
                return json({ error: 'This is in a shop that is closed for now. Reopen the shop to put it back up.', code: 'shop_paused' }, 409);
            }
            if (p?.status !== 'paused') return json({ success: false, error: 'Post not found, not paused, or not owned by author' }, 400);
            server.resumed.push(body.postId);
            p.status = 'active';
            return json({ success: true });
        }
        case 'GET /api/pricing-guide': return json(server.guide);
        default: return json({ error: 'not here' }, 404);
    }
}

beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    vi.stubGlobal('IDBKeyRange', MemoryIDBKeyRange);
    vi.stubGlobal('fetch', vi.fn(answer));
    resetToolStoreForTest();
    resetAccountEpochForTest();
    server.posts.clear();
    server.asks.length = 0;
    server.shopHeld.clear();
    server.inClosedShop.clear();
    server.deals.length = 0;
    server.guide = { items: [] };
    server.paused.length = 0;
    server.resumed.length = 0;
    server.requests.length = 0;
    server.down = false;
    server.dealsDown = false;
    server.dealsGate = null;
    server.copy = null;
    server.max = undefined;
    server.copyGate = null;
    server.marketGate = null;
    server.readGate = null;
    server.puts.length = 0;
    storeFails.on = false;
    info.value = { profile: 'local', features: { beans: true } };
    picked.count = 0;
    picked.cancel = false;
    picked.sizes.length = 0;
    picked.refs.length = 0;
    // The clock held at the fixtures' moment, so "back around" never turns into "was due back" on a later run.
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});
afterEach(() => {
    cleanup();
    backToEnglish();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

async function keep(doc: ThingsDoc) {
    expect(await writeToolRecord(OWNER, 'things', { body: JSON.stringify(doc), updatedAt: iso(NOW - DAY), syncedAt: null })).toBe(true);
}
const kept = async () => readThingsDoc(JSON.parse((await readToolRecord(OWNER, 'things'))?.body ?? 'null'));
const keptThing = async (id: string) => (await kept()).things.find((t) => (t as Thing).id === id) as Thing | undefined;
/** A thing with every field at its bound (about 1.2 KB). */
const atCaps = (i: number) => thing(`b-${i}`, 'n'.repeat(80), { lendTerms: 't'.repeat(300), ownerNote: 'o'.repeat(500), replacementValue: 'r'.repeat(40) });
/** Things at their caps, as many as fit under `max`. */
function filledTo(max: number): Thing[] {
    const full: Thing[] = [];
    while (toolDocBytes(shed(...full, atCaps(full.length))) <= max) full.push(atCaps(full.length));
    return full;
}
/** The edit screen's fields typed to their bounds, as atCaps's. */
async function fillAtCaps() {
    await type('edit-name', 'n'.repeat(80));
    await type('edit-terms', 't'.repeat(300));
    await type('edit-note', 'o'.repeat(500));
    await type('edit-replacement', 'r'.repeat(40));
}
/** The shed full, as every screen says it: in words, never bytes. */
const FULL_LINE = 'Your Tool shed is full. Delete something you no longer have, or shorten some notes.';
/** What Your things says of the room in `doc` against `max` (core's shedRoom, drawn in English). */
function roomLine(doc: ThingsDoc, max: number): string {
    const n = shedRoom(doc, max);
    return n === 0 ? FULL_LINE : n === 1 ? 'Room for about 1 more thing' : `Room for about ${n} more things`;
}

/** The page at one of the Tool shed's screens, as App opens it. */
async function open(screenName: string, key: string | null = null, over: Partial<ToolsPageProps> = {}) {
    const props: ToolsPageProps = {
        identity, open: { id: 'things', screen: screenName, key }, onOpen: vi.fn(), onClose: vi.fn(), onComposer: vi.fn(), onGuide: vi.fn(), onAddHomeCard: vi.fn(),
        now: () => NOW, ...over,
    };
    const view = render(<ToolsPage {...props} />);
    await view.findByTestId('tools-page');
    // The tool's own chunk and its document are in: one of its screens, or the doors over an empty shed.
    await waitFor(() => expect(['things-main', 'thing-screen', 'thing-edit-screen', 'things-loans-screen', 'tool-doors'].some((id) => view.queryByTestId(id))).toBe(true));
    await settle();
    return { props, view };
}
/** The page in StrictMode, as main.tsx draws the app: each screen mounted twice. */
function drawStrict(screenName: string, key: string | null = null) {
    return render(
        <StrictMode>
            <ToolsPage identity={identity} open={{ id: 'things', screen: screenName, key }} onOpen={vi.fn()} onClose={vi.fn()} onComposer={vi.fn()}
                onGuide={vi.fn()} onAddHomeCard={vi.fn()} now={() => NOW} />
        </StrictMode>,
    );
}
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); }); };
const byTestId = (id: string) => screen.queryByTestId(id);
async function click(id: string) {
    const el = await screen.findByTestId(id);
    expect((el as HTMLButtonElement).disabled ?? false, `${id} is enabled`).toBe(false);
    await act(async () => { fireEvent.click(el); });
    await settle();
}
async function type(id: string, text: string) {
    const el = await screen.findByTestId(id);
    await act(async () => { fireEvent.change(el, { target: { value: text } }); });
}
/** An element's words, a row's icon (an emoji) and its chevron left out. */
const words = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/^\P{L}+/u, '').replace(/[\s›]+$/u, '');
const rows = () => screen.queryAllByTestId(/^thing-row-/).map((r) => words(r));

/** Colour classes with no dark pair on the same element: a theme role (bp-*) changes with the theme by itself. */
function noDarkPair(root: HTMLElement): string[] {
    const out: string[] = [];
    const COLOUR = /^(text|bg|border)-(nature|white|black|gray|stone|neutral|slate|zinc|red|green|amber|yellow|blue)(-|$)/;
    for (const e of [root, ...Array.from(root.querySelectorAll('*'))]) {
        const cls = (e.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
        for (const c of cls.filter((x) => COLOUR.test(x))) {
            const kind = c.split('-')[0];
            if (!cls.some((d) => d.startsWith(`dark:${kind}-`))) out.push(`${e.tagName.toLowerCase()} ${c}`);
        }
    }
    return out;
}

describe('the Tool shed on the web', () => {
    it('is registered: its web half is its own chunk and draws every screen its manifest names', async () => {
        expect(typeof TOOL_APPS.things).toBe('function');
        const app = (await TOOL_APPS.things()).default;
        expect(app.id).toBe('things');
        expect(Object.keys(app.screens()).sort()).toEqual([...THINGS.screens].sort());
    });

    it('each screen with a real thing in it, in xx: every word through t(), and every colour with its dark pair', async () => {
        offer('post-1', 'Cordless drill');
        server.deals.push({ id: 'tx1', postId: 'post-1', sellerPublicKey: OWNER, buyerPublicKey: 'b', status: 'requested', createdAt: iso(NOW - DAY) });
        const small: ThingsDoc = { ...FIXTURES.docs.small, things: FIXTURES.docs.small.things.map((t, i) => (i === 2 ? { ...(t as Thing), ownerNote: 'Under the house', replacementValue: '$80' } : t)) };
        const others = small.things.flatMap((t) => [(t as Thing).name, (t as Thing).lentTo?.name ?? '', (t as Thing).lendTerms ?? '', (t as Thing).replacementValue ?? '', (t as Thing).ownerNote ?? '']).filter(Boolean);
        await showIn('xx');
        for (const [screenName, key] of [['main', null], ['thing', 't-1'], ['thing', 't-2'], ['thing', 't-3'], ['edit', 't-3'], ['edit', null], ['loans', null]] as const) {
            await keep(small);
            const { view } = await open(screenName, key);
            const page = view.getByTestId('tools-page');
            const where = `${screenName} ${key ?? ''}`;
            expect(bypassing(page, { others }), where).toEqual([]);
            expect(noDarkPair(page), where).toEqual([]);
            view.unmount();
            resetToolStoreForTest();
            vi.stubGlobal('indexedDB', memoryIndexedDB());
        }
    });
});

describe('Your things', () => {
    it('newest first, each with its state; the filters narrow it; Add and Loans open their screens, and Back returns', async () => {
        offer('post-1', 'Cordless drill');
        await keep(FIXTURES.docs.small);
        await open('main');
        expect(rows()).toEqual(['Camping tentOn your shelf', expect.stringMatching(/^Step ladderDue \d{1,2} [A-Z][a-z]{2} · with Alice$/), 'Cordless drillIn your shop']);
        await click('things-filter-out');
        expect(rows().map((r) => r!.slice(0, 11))).toEqual(['Step ladder']);
        await click('things-filter-shop');
        expect(rows()).toEqual(['Cordless drillIn your shop']);
        await click('things-filter-shelf');
        expect(rows()).toEqual(['Camping tentOn your shelf']);
        await click('things-add');
        expect(byTestId('thing-edit-screen')).not.toBeNull();
        await click('tools-back');
        await click('things-loans');
        expect(byTestId('things-loans-screen')).not.toBeNull();
        await click('tools-back');
        await click('thing-row-t-3');
        expect(byTestId('thing-screen')).not.toBeNull();
    });

    it("a photo that isn't in this browser (one taken on another device): its row has the thing's emoji, and no screen draws an empty box", async () => {
        // Ladder's photo is in this browser; Drill's ref came with the server's copy, from the member's other device.
        await keep(shed(thing('t-1', 'Drill', { photo: 'p-elsewhere' }), thing('t-2', 'Ladder')));
        await open('edit', 't-2');
        await click('edit-photo-pick');
        await click('edit-save');
        cleanup();
        await open('main');
        await waitFor(() => expect(byTestId('thing-row-t-2')?.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/jpeg;base64,/));
        expect(byTestId('thing-row-t-1')?.querySelector('img')).toBeNull();
        expect(byTestId('thing-row-t-1')?.textContent).toBe(`${thingCategory('tools').emoji}DrillOn your shelf›`);
        for (const [screenName, photo] of [['thing', 'thing-photo'], ['edit', 'edit-photo']] as const) {
            cleanup();
            await open(screenName, 't-1');
            expect(byTestId(screenName === 'thing' ? 'thing-screen' : 'thing-edit-screen'), screenName).not.toBeNull();
            expect(byTestId(photo), screenName).toBeNull();
        }
        // Its own photo still draws on its screen.
        cleanup();
        await open('thing', 't-2');
        await waitFor(() => expect(byTestId('thing-photo')?.getAttribute('src')).toMatch(/^data:image\/jpeg;base64,/));
    });

    it(`Loans gives no count until the deals are known, and says when they couldn't be read: never "nothing out" unchecked`, async () => {
        let release!: () => void;
        server.dealsGate = new Promise<void>((r) => { release = r; });
        offer('post-1', 'Drill', 'pending', { lendable: true, acceptedAt: iso(NOW - DAY) });
        server.deals.push({ id: 'tx1', postId: 'post-1', sellerPublicKey: OWNER, buyerPublicKey: 'b', status: 'pending', hours: 3, createdAt: iso(NOW - 2 * DAY) });
        await keep(shed(thing('t-1', 'Drill', { postId: 'post-1' })));
        await open('main');
        expect(words(byTestId('things-loans'))).toBe('Loans');
        release();
        await waitFor(() => expect(words(byTestId('things-loans'))).toBe('LoansOut or asked for: 1'));
        expect(byTestId('things-loans-unchecked')).toBeNull();
        cleanup();
        server.dealsGate = null;
        server.dealsDown = true;
        await open('main');
        await waitFor(() => expect(byTestId('things-loans-unchecked')?.textContent).toBe("Loans through BeanPool couldn't be checked just now."));
        expect(words(byTestId('things-loans'))).toBe('Loans');
    });

    it('after "I already do this", an empty shed says what goes in it, with Add', async () => {
        await open('main');
        await click('tool-door-already');
        expect(byTestId('things-empty')?.textContent).toContain("Add the first thing you'd lend");
        expect(byTestId('things-add')).not.toBeNull();
        expect(byTestId('things-filter')).toBeNull();
    });
});

describe('Edit', () => {
    it('a name is needed and a longest loan is 1 to 365 days; saved at the top of the list, then back to it', async () => {
        await keep(shed(thing('t-1', 'Ladder')));
        await open('main');
        await click('things-add');
        await click('edit-save');
        expect(byTestId('edit-name-field')?.textContent).toContain('Give it a name.');
        await type('edit-name', '  Wheelbarrow ');
        await click('edit-condition-fair');
        await type('edit-days', '400');
        await type('edit-replacement', '$90');
        await click('edit-save');
        expect(byTestId('edit-days-field')?.textContent).toContain('A number of days from 1 to 365.');
        await type('edit-days', '7');
        await click('edit-save');
        expect((await kept()).things[1]).toMatchObject({ name: 'Wheelbarrow', condition: 'fair', lendMaxDays: 7, replacementValue: '$90' });
        expect(byTestId('things-main')).not.toBeNull();
        expect(rows()[0]).toBe('WheelbarrowOn your shelf');
    });

    it("a box's error is announced as it shows, from a polite live region there before Save; a hint never is", async () => {
        await keep(shed(thing('t-1', 'Ladder')));
        await open('main');
        await click('things-add');
        // The region is there, empty, before the error goes in it: one made with its words in it is often not read out.
        const regions = () => ['edit-name', 'edit-days'].map((id) => byTestId(`${id}-field`)?.querySelector('[aria-live="polite"]') ?? null);
        const [nameRegion, daysRegion] = regions();
        expect(nameRegion?.textContent).toBe('');
        expect(daysRegion?.textContent).toBe('');
        await click('edit-save');
        expect(regions()).toEqual([nameRegion, daysRegion]);
        expect(nameRegion?.textContent).toBe('Give it a name.');
        const name = byTestId('edit-name')!;
        expect(name.getAttribute('aria-invalid')).toBe('true');
        expect(document.getElementById(name.getAttribute('aria-describedby')!)?.textContent).toBe('Give it a name.');
        await type('edit-name', 'Wheelbarrow');
        expect(nameRegion?.textContent).toBe('');
        await type('edit-days', '400');
        expect(regions()).toEqual([nameRegion, daysRegion]);
        expect(daysRegion?.textContent).toBe('A number of days from 1 to 365.');
        // A hint is read with its box (aria-describedby), never announced: it isn't in a live region.
        const replacement = byTestId('edit-replacement')!;
        const hint = document.getElementById(replacement.getAttribute('aria-describedby')!);
        expect(hint?.textContent).toContain('BeanPool never holds or collects it.');
        expect(hint?.closest('[aria-live]')).toBeNull();
    });

    it('a photo is chosen, drawn at 800 px and kept in this browser; Remove takes it out, and it goes from the store once saved', async () => {
        await keep(shed(thing('t-1', 'Tent')));
        await open('edit', 't-1');
        await click('edit-photo-take');
        expect(picked.sizes).toEqual([800]);
        await waitFor(() => expect(byTestId('edit-photo')?.getAttribute('src')).toBe('data:image/jpeg;base64,cGhvdG81'));
        await click('edit-save');
        const ref = (await keptThing('t-1'))?.photo;
        expect(ref).toBeTruthy();
        expect(await readToolPhoto(OWNER, 'things', ref!)).toBe('data:image/jpeg;base64,cGhvdG81');
        cleanup();
        await open('edit', 't-1');
        await click('edit-photo-remove');
        expect(byTestId('edit-photo')).toBeNull();
        await click('edit-save');
        expect((await keptThing('t-1'))?.photo).toBeUndefined();
        expect(await readToolPhoto(OWNER, 'things', ref!)).toBeNull();
    });

    it("a photo chosen and left without Cancel (the page's back, the browser's) goes from the store; a saved one stays", async () => {
        await keep(shed(thing('t-1', 'Tent')));
        await open('main');
        await click('thing-row-t-1');
        await click('thing-edit');
        await click('edit-photo-pick');
        const [first] = picked.refs;
        expect(await readToolPhoto(OWNER, 'things', first)).toBe('data:image/jpeg;base64,cGhvdG81');
        // The page's Back: the thing's screen again.
        await click('tools-back');
        expect(byTestId('thing-edit-screen')).toBeNull();
        expect(byTestId('thing-screen')).not.toBeNull();
        expect(await readToolPhoto(OWNER, 'things', first)).toBeNull();
        expect((await keptThing('t-1'))?.photo).toBeUndefined();

        // Saved, then gone from the page: the thing's photo stays. Chosen again and gone: the new one goes, the thing's stays.
        cleanup();
        await open('edit', 't-1');
        await click('edit-photo-pick');
        await click('edit-save');
        const saved = picked.refs[1];
        expect((await keptThing('t-1'))?.photo).toBe(saved);
        cleanup();
        await settle();
        expect(await readToolPhoto(OWNER, 'things', saved)).toBe('data:image/jpeg;base64,cGhvdG82');
        await open('edit', 't-1');
        await click('edit-photo-pick');
        await click('edit-photo-remove');
        cleanup();
        await settle();
        expect(await readToolPhoto(OWNER, 'things', picked.refs[2])).toBeNull();
        expect(await readToolPhoto(OWNER, 'things', saved)).toBe('data:image/jpeg;base64,cGhvdG82');
        expect((await keptThing('t-1'))?.photo).toBe(saved);
    });

    it("in StrictMode, as main.tsx draws the app: a photo chosen is kept by Save, never taken away by the second mount", async () => {
        await keep(shed(thing('t-1', 'Tent')));
        render(
            <StrictMode>
                <ToolsPage identity={identity} open={{ id: 'things', screen: 'edit', key: 't-1' }} onOpen={vi.fn()} onClose={vi.fn()} onComposer={vi.fn()}
                    onGuide={vi.fn()} onAddHomeCard={vi.fn()} now={() => NOW} />
            </StrictMode>,
        );
        await screen.findByTestId('thing-edit-screen');
        await settle();
        await click('edit-photo-pick');
        const ref = picked.refs.at(-1)!;
        expect(byTestId('edit-photo')).not.toBeNull();
        expect(await readToolPhoto(OWNER, 'things', ref)).toBe('data:image/jpeg;base64,cGhvdG81');
        await click('edit-save');
        expect((await keptThing('t-1'))?.photo).toBe(ref);
        expect(await readToolPhoto(OWNER, 'things', ref)).toBe('data:image/jpeg;base64,cGhvdG81');
    });

    it("Settings, About and Remove my data from the … menu are no leave: on ← what was typed and the photo chosen are still there; Cancel then takes the photo away", async () => {
        await keep(shed(thing('t-1', 'Ladder')));
        drawStrict('main');
        await screen.findByTestId('things-main');
        await settle();
        await click('thing-row-t-1');
        await click('thing-edit');
        await type('edit-name', 'Ladder, 3 m aluminium');
        await type('edit-note', 'In the garage, left wall');
        await click('edit-photo-pick');
        const ref = picked.refs.at(-1)!;
        const photo = 'data:image/jpeg;base64,cGhvdG81';
        for (const [item, panel] of [['tool-menu-about', 'tool-about'], ['tool-menu-settings', 'tool-settings'], ['tool-menu-remove', 'tool-settings']] as const) {
            await click('tool-menu');
            await click(item);
            expect(byTestId(panel), item).not.toBeNull();
            await click('tools-back');
            expect(byTestId(panel), item).toBeNull();
            expect((byTestId('edit-name') as HTMLInputElement).value, item).toBe('Ladder, 3 m aluminium');
            expect((byTestId('edit-note') as HTMLTextAreaElement).value, item).toBe('In the garage, left wall');
            expect(byTestId('edit-photo')?.getAttribute('src'), item).toBe(photo);
            expect(await readToolPhoto(OWNER, 'things', ref), item).toBe(photo);
        }
        expect(await keptThing('t-1')).toMatchObject({ name: 'Ladder' });
        await click('edit-cancel');
        expect(byTestId('thing-screen')).not.toBeNull();
        expect(await readToolPhoto(OWNER, 'things', ref)).toBeNull();
        expect((await keptThing('t-1'))?.photo).toBeUndefined();
    });

    it('a 101st small thing is kept: the shed is bounded by its size alone, never by a count', async () => {
        await keep(shed(...Array.from({ length: 100 }, (_, i) => thing(`t-${i}`, `Thing ${i}`))));
        await open('main');
        await click('things-add');
        await type('edit-name', 'One more');
        await click('edit-save');
        expect(byTestId('edit-problem')).toBeNull();
        expect(shedThings(await kept())).toHaveLength(101);
        expect(shedThings(await kept())[0].name).toBe('One more');
        // Back on the list, the new thing at the top.
        expect(rows()[0]).toMatch(/^One more/);
    });

    it("a save past the shed's 128 KB is refused in one sentence, in words and never bytes; nothing is written", async () => {
        const full = filledTo(THINGS_DOC_BYTES);
        expect(full.length).toBeGreaterThan(100);
        await keep(shed(...full));
        await open('edit');
        await fillAtCaps();
        await click('edit-save');
        expect(byTestId('edit-problem')?.textContent).toBe(FULL_LINE);
        expect(byTestId('edit-problem')?.textContent).not.toMatch(/KB|byte/);
        expect((await kept()).things).toHaveLength(full.length);
    });

    it("on a server from before 128 KB (its `max` 65536): the room is against 64 KB, a save past it is refused, and nothing past it is sent", async () => {
        server.max = 65_536;
        const some = shed(...Array.from({ length: 30 }, (_, i) => atCaps(i)));
        await keep(some);
        await open('main');
        // The open's GET said 65536: kept beside the setting, and the room is counted against it.
        await waitFor(async () => expect((await readToolSettings(OWNER, 'things')).nodeMax).toBe(65_536));
        await waitFor(() => expect(byTestId('things-room')?.textContent).toBe(roomLine(some, 65_536)));
        expect(shedRoom(some, 65_536)).toBeLessThan(shedRoom(some, THINGS_DOC_BYTES));
        cleanup();

        const full = filledTo(TOOL_LIMITS.docBytes);
        await keep(shed(...full));
        // One more fits the shed's own 128 KB, not this server's 64 KB.
        expect(toolDocBytes(shed(...full, atCaps(full.length)))).toBeLessThan(THINGS_DOC_BYTES);
        await open('edit');
        await fillAtCaps();
        await click('edit-save');
        expect(byTestId('edit-problem')?.textContent).toBe(FULL_LINE);
        expect((await kept()).things).toHaveLength(full.length);
        expect(server.puts.every((doc) => toolDocBytes(doc) <= 65_536)).toBe(true);
    });

    it("a shed already past a server's 64 KB (kept before it said so): a Delete and a shorter note are kept, an Add is refused, nothing past it is sent", async () => {
        // Kept while the browser counted against the shed's own 128 KB; then the open's GET says 65536.
        const over: Thing[] = [];
        while (toolDocBytes(shed(...over)) <= TOOL_LIMITS.docBytes + 4_000) over.push(atCaps(over.length));
        await keep(shed(...over));
        server.max = 65_536;
        await open('main');
        await waitFor(async () => expect((await readToolSettings(OWNER, 'things')).nodeMax).toBe(65_536));
        await waitFor(() => expect(byTestId('things-room')?.textContent).toBe(FULL_LINE));
        await click('thing-row-b-0');
        await click('thing-delete');
        await click('thing-delete-yes');
        expect(byTestId('thing-refused')).toBeNull();
        expect((await kept()).things[0]).toMatchObject({ id: 'b-0', gone: true });
        expect(shedThings(await kept())).toHaveLength(over.length - 1);
        cleanup();

        await open('edit', 'b-1');
        await waitFor(async () => expect((await readToolSettings(OWNER, 'things')).nodeMax).toBe(65_536));
        await type('edit-note', 'Top shelf.');
        await click('edit-save');
        expect(byTestId('edit-problem')).toBeNull();
        expect((await keptThing('b-1'))?.ownerNote).toBe('Top shelf.');
        cleanup();

        // Still past 64 KB: one more thing is not taken.
        expect(toolDocBytes(await kept())).toBeGreaterThan(TOOL_LIMITS.docBytes);
        await open('edit');
        await type('edit-name', 'One more');
        await click('edit-save');
        expect(byTestId('edit-problem')?.textContent).toBe(FULL_LINE);
        expect(shedThings(await kept())).toHaveLength(over.length - 1);
        expect(server.puts.every((doc) => toolDocBytes(doc) <= 65_536)).toBe(true);
    });

    it("a refusal on Save is announced as it shows, from a polite region there before Save; never read out twice", async () => {
        await keep(shed(...filledTo(THINGS_DOC_BYTES)));
        await open('edit');
        // The region is there, empty, before the sentence goes in it: one made with its words in it is often not read out.
        const region = byTestId('edit-problem-live')!;
        expect(region.getAttribute('aria-live')).toBe('polite');
        expect(region.textContent).toBe('');
        await fillAtCaps();
        await click('edit-save');
        expect(byTestId('edit-problem-live')).toBe(region);
        expect(region.textContent).toBe(FULL_LINE);
        // In the region, the sentence isn't a status of its own as well.
        expect(byTestId('edit-problem')?.closest('[aria-live]')).toBe(region);
        expect(byTestId('edit-problem')?.getAttribute('role')).toBeNull();
    });
});

describe('Your things: the room left, in things', () => {
    it("says about how many more things fit, never bytes: from the member's own things, or a typical thing while there are none", async () => {
        await open('main');
        await click('tool-door-already');
        expect(byTestId('things-room')?.textContent).toBe(roomLine(shed(), THINGS_DOC_BYTES));
        expect(shedRoom(shed(), THINGS_DOC_BYTES)).toBeGreaterThan(300);
        cleanup();

        const mine = shed(thing('t-1', 'Ladder', { lendTerms: 'Back by Sunday.' }), atCaps(1), atCaps(2));
        await keep(mine);
        await open('main');
        expect(byTestId('things-room')?.textContent).toBe(roomLine(mine, THINGS_DOC_BYTES));
        expect(byTestId('things-room')?.textContent).toMatch(/^Room for about \d+ more things$/);
    });

    it('a shed with no room says it is full, in the same words as a save that is refused', async () => {
        const full = filledTo(THINGS_DOC_BYTES);
        // Less left than one of them: and if about one still would, a small thing takes it.
        let doc = shed(...full);
        if (shedRoom(doc, THINGS_DOC_BYTES) > 0) doc = shed(...full, thing('last', 'Odds and ends'));
        expect(toolDocBytes(doc)).toBeLessThanOrEqual(THINGS_DOC_BYTES);
        expect(shedRoom(doc, THINGS_DOC_BYTES)).toBe(0);
        await keep(doc);
        await open('main');
        expect(byTestId('things-room')?.textContent).toBe(FULL_LINE);
    });
});

describe('A thing', () => {
    it("List opens the composer with the thing's draft and photo, and posts nothing by itself", async () => {
        await keep(shed(thing('t-1', 'Cordless drill', { lendTerms: 'Clean it.', replacementValue: '$120', lendMaxDays: 7 })));
        await open('edit', 't-1');
        await click('edit-photo-pick');
        await click('edit-save');
        cleanup();
        const { props } = await open('thing', 't-1');
        await click('thing-list');
        await waitFor(() => expect(props.onComposer).toHaveBeenCalledTimes(1));
        expect(props.onComposer).toHaveBeenCalledWith({
            type: 'offer', title: 'Cordless drill', category: 'tools', credits: null, priceType: null, repeatable: false, cashAlsoNeeded: false,
            description: "Clean it.\n\nIf it's lost or broken: $120. That is settled between us; BeanPool doesn't hold or collect it.\n\nLent for up to 7 days at a time.",
            photos: ['data:image/jpeg;base64,cGhvdG81'],
        });
        expect(server.requests.filter((r) => r.startsWith('POST'))).toEqual([]);
        expect((await keptThing('t-1'))?.postId).toBeUndefined();
        expect(byTestId('thing-listed-note')).not.toBeNull();
    });

    it("linked to the member's own Offer: one free to link; a live one puts it in the shop, a paused one takes it out", async () => {
        offer('post-1', 'Cordless drill');
        offer('post-2', 'Old saw', 'paused');
        offer('post-3', 'Ladder');
        server.posts.set('theirs', { id: 'theirs', title: 'Not mine', status: 'active', type: 'offer', authorPublicKey: 'someone' });
        await keep(shed(thing('t-1', 'Cordless drill'), thing('t-2', 'Ladder', { postId: 'post-3' })));
        await open('thing', 't-1');
        await click('thing-link');
        expect(screen.queryAllByTestId(/^thing-link-post/).map((e) => e.getAttribute('data-testid'))).toEqual(['thing-link-post-1', 'thing-link-post-2']);
        await click('thing-link-post-1');
        expect(await keptThing('t-1')).toMatchObject({ postId: 'post-1' });
        expect(byTestId('thing-state')?.textContent).toBe('In your shop');
        cleanup();
        await keep(shed(thing('t-1', 'Saw')));
        await open('thing', 't-1');
        await click('thing-link');
        await click('thing-link-post-2');
        expect(await keptThing('t-1')).toMatchObject({ pausedPostId: 'post-2' });
        expect(byTestId('thing-state')?.textContent).toBe('Taken out of your shop');
    });

    it('take out of the shop pauses its Offer; put back resumes the same one; an Offer gone from the Market puts it on the shelf and says so', async () => {
        offer('post-1', 'Cordless drill');
        await keep(shed(thing('t-1', 'Cordless drill', { postId: 'post-1' })));
        await open('thing', 't-1');
        await click('thing-take-out');
        expect(server.paused).toEqual(['post-1']);
        expect(await keptThing('t-1')).toMatchObject({ pausedPostId: 'post-1' });
        await click('thing-put-back');
        expect(server.resumed).toEqual(['post-1']);
        expect(await keptThing('t-1')).toMatchObject({ postId: 'post-1' });
        cleanup();
        server.posts.delete('post-1');
        await keep(shed(thing('t-1', 'Cordless drill', { pausedPostId: 'post-1' })));
        await open('thing', 't-1');
        await click('thing-put-back');
        expect(byTestId('thing-gone-note')?.textContent).toBe('Its Offer has gone from the Market, so it is back on your shelf. List it again to make a new one.');
        const t1 = await keptThing('t-1');
        expect([t1?.postId, t1?.pausedPostId]).toEqual([undefined, undefined]);
    });

    it('a listed thing whose Offer has gone says so, with List it again and Forget it', async () => {
        await keep(shed(thing('t-1', 'Cordless drill', { postId: 'post-9' })));
        await open('thing', 't-1');
        expect(byTestId('thing-offer-gone')?.textContent).toContain('Its Offer has gone from the Market.');
        await click('thing-forget');
        expect((await keptThing('t-1'))?.postId).toBeUndefined();
        expect(byTestId('thing-list')).not.toBeNull();
    });

    it("lent outside BeanPool: who and when it's back; a listed thing's Offer is paused meanwhile and resumed when it's back", async () => {
        offer('post-1', 'Ladder');
        await keep(shed(thing('t-1', 'Ladder', { postId: 'post-1' })));
        await open('thing', 't-1');
        await click('thing-lend');
        expect((byTestId('thing-lend-save') as HTMLButtonElement).disabled).toBe(true);
        await type('thing-lend-name', 'Sam');
        await click('thing-lend-back-7');
        await click('thing-lend-save');
        expect(server.paused).toEqual(['post-1']);
        const lent = await keptThing('t-1');
        expect(lent?.lentTo?.name).toBe('Sam');
        expect(Date.parse(lent!.lentTo!.backAround!) - Date.parse(lent!.lentTo!.since)).toBe(7 * DAY);
        expect(byTestId('thing-state')?.textContent).toMatch(/^With Sam · back around /);
        expect(byTestId('thing-delete')).toBeNull();
        await click('thing-back-home');
        expect(server.resumed).toEqual(['post-1']);
        expect(await keptThing('t-1')).toMatchObject({ postId: 'post-1' });
        expect((await keptThing('t-1'))?.lentTo).toBeUndefined();
    });

    it("It's back reads its Offer first: put back in the Market meanwhile, it stays in the shop; gone, it is on the shelf; never \"taken out\"", async () => {
        const lentThing = () => thing('t-1', 'Ladder', { postId: 'post-1', lentTo: { name: 'Sam', since: iso(NOW - DAY) } });
        // Put back in the Market (from My Posts, or another device) while it was away: the server won't resume a live Offer.
        offer('post-1', 'Ladder', 'paused');
        await keep(shed(lentThing()));
        await open('thing', 't-1');
        server.posts.get('post-1')!.status = 'active';
        await click('thing-back-home');
        expect(byTestId('thing-refused')).toBeNull();
        expect(server.resumed).toEqual([]);
        let back = await keptThing('t-1');
        expect([back?.postId, back?.pausedPostId, back?.lentTo]).toEqual(['post-1', undefined, undefined]);
        expect(byTestId('thing-state')?.textContent).toBe('In your shop');
        expect(byTestId('thing-offer-paused')).toBeNull();
        expect(byTestId('thing-take-out')).not.toBeNull();

        // Ended or deleted while it was away: it is back on the shelf, and says so.
        cleanup();
        server.posts.delete('post-1');
        await keep(shed(lentThing()));
        await open('thing', 't-1');
        await click('thing-back-home');
        expect(byTestId('thing-refused')).toBeNull();
        back = await keptThing('t-1');
        expect([back?.postId, back?.pausedPostId, back?.lentTo]).toEqual([undefined, undefined, undefined]);
        expect(byTestId('thing-state')?.textContent).toBe('On your shelf');
        expect(byTestId('thing-gone-note')?.textContent).toBe('Its Offer has gone from the Market, so it is back on your shelf. List it again to make a new one.');

        // Paused, as Lend left it: resumed, and the screen says it is in the shop, never that its Offer is paused.
        cleanup();
        offer('post-1', 'Ladder', 'paused');
        await keep(shed(lentThing()));
        await open('thing', 't-1');
        await click('thing-back-home');
        expect(server.resumed).toEqual(['post-1']);
        expect(byTestId('thing-state')?.textContent).toBe('In your shop');
        expect(byTestId('thing-offer-paused')).toBeNull();
        expect(byTestId('thing-take-out')).not.toBeNull();
    });

    it("It's back when the community's server can't be reached: it is home, and taken out of the shop, as it is", async () => {
        offer('post-1', 'Ladder', 'paused');
        await keep(shed(thing('t-1', 'Ladder', { postId: 'post-1', lentTo: { name: 'Sam', since: iso(NOW - DAY) } })));
        await open('thing', 't-1');
        server.down = true;
        await click('thing-back-home');
        const back = await keptThing('t-1');
        expect([back?.postId, back?.pausedPostId, back?.lentTo]).toEqual([undefined, 'post-1', undefined]);
        expect(byTestId('thing-state')?.textContent).toBe('Taken out of your shop');
    });

    it("when the community's server can't be reached, take out and lend change nothing and say so", async () => {
        offer('post-1', 'Ladder');
        await keep(shed(thing('t-1', 'Ladder', { postId: 'post-1' })));
        await open('thing', 't-1');
        server.down = true;
        await click('thing-take-out');
        expect(byTestId('thing-refused')?.textContent).toBe("Couldn't reach your community's server, so nothing changed. Try again when you're online.");
        await click('thing-lend');
        await type('thing-lend-name', 'Sam');
        await click('thing-lend-save');
        expect(byTestId('thing-refused')?.textContent).toBe("Couldn't reach your community's server, so nothing changed. Try again when you're online.");
        expect(await keptThing('t-1')).toEqual(thing('t-1', 'Ladder', { postId: 'post-1' }));
    });

    it("the sentence that says nothing changed, and that its loans couldn't be checked, are announced as they show, from polite regions there before them", async () => {
        let release!: () => void;
        server.dealsGate = new Promise<void>((r) => { release = r; });
        offer('post-1', 'Ladder');
        await keep(shed(thing('t-1', 'Ladder', { postId: 'post-1' })));
        await open('thing', 't-1');
        // Each region is there, empty, before its sentence goes in it: one made with its words in it is often not read out.
        const [unchecked, refused] = ['thing-unchecked-live', 'thing-refused-live'].map((id) => byTestId(id)!);
        for (const region of [unchecked, refused]) {
            expect(region.getAttribute('aria-live')).toBe('polite');
            expect(region.textContent).toBe('');
        }
        server.dealsDown = true;
        release();
        await waitFor(() => expect(unchecked.textContent).toBe("Loans through BeanPool couldn't be checked just now."));
        expect(byTestId('thing-unchecked-live')).toBe(unchecked);
        server.dealsDown = false;
        cleanup();

        await open('thing', 't-1');
        const region = byTestId('thing-refused-live')!;
        expect(region.textContent).toBe('');
        server.down = true;
        await click('thing-take-out');
        expect(byTestId('thing-refused-live')).toBe(region);
        expect(region.textContent).toBe("Couldn't reach your community's server, so nothing changed. Try again when you're online.");
        // In the region, the sentence isn't a status of its own as well.
        expect(byTestId('thing-refused')?.closest('[aria-live]')).toBe(region);
        expect(byTestId('thing-refused')?.getAttribute('role')).toBeNull();
    });

    it('delete: asked first; its Offer is taken out of the Market and its photo goes; then back to the list', async () => {
        offer('post-1', 'Drill');
        await keep(shed(thing('t-1', 'Drill', { postId: 'post-1' })));
        await open('edit', 't-1');
        await click('edit-photo-pick');
        await click('edit-save');
        const ref = (await keptThing('t-1'))?.photo;
        cleanup();
        await open('main');
        await click('thing-row-t-1');
        await click('thing-delete');
        expect(byTestId('thing-delete-ask')?.textContent).toBe('Delete Drill from your Tool shed? Its photo and notes go too.');
        await click('thing-delete-no');
        expect(byTestId('thing-delete-ask')).toBeNull();
        await click('thing-delete');
        await click('thing-delete-yes');
        expect(server.paused).toEqual(['post-1']);
        expect(await readToolPhoto(OWNER, 'things', ref!)).toBeNull();
        expect(shedThings(await kept())).toEqual([]);
        expect((await kept()).things[0]).toMatchObject({ id: 't-1', gone: true });
        expect(byTestId('things-main')).not.toBeNull();
    });

    it("a Delete that lands after the member went back leaves them where they went: the page drawn, Your things showing", async () => {
        offer('post-1', 'Drill');
        await keep(shed(thing('t-1', 'Drill', { postId: 'post-1' }), thing('t-2', 'Ladder')));
        await open('main');
        await click('thing-row-t-1');
        let answer = () => {};
        server.marketGate = new Promise<void>((r) => { answer = r; });
        await click('thing-delete');
        await click('thing-delete-yes');
        await waitFor(() => expect(server.asks).toEqual(['pause post-1']));
        // The page's ← while the pause is still asked: Your things shows before the Delete lands.
        await click('tools-back');
        expect(byTestId('things-main')).not.toBeNull();
        answer();
        await waitFor(async () => expect(shedThings(await kept()).map((t) => t.id)).toEqual(['t-2']));
        await settle();
        expect(byTestId('tools-page')).not.toBeNull();
        expect(byTestId('things-main')).not.toBeNull();
        expect(byTestId('thing-row-t-1')).toBeNull();
        expect(byTestId('thing-row-t-2')).not.toBeNull();
    });

    it('an Offer already paused or gone from the Market is left as it is: lend and delete still do what they say', async () => {
        offer('post-1', 'Ladder', 'paused');
        await keep(shed(thing('t-1', 'Ladder', { postId: 'post-1' }), thing('t-2', 'Drill', { postId: 'post-9' })));
        await open('thing', 't-1');
        await waitFor(() => expect(byTestId('thing-offer-paused')?.textContent).toContain('Its Offer is paused in the Market.'));
        await click('thing-lend');
        await type('thing-lend-name', 'Sam');
        await click('thing-lend-save');
        expect(byTestId('thing-refused')).toBeNull();
        expect((await keptThing('t-1'))?.lentTo?.name).toBe('Sam');
        expect(server.posts.get('post-1')?.status).toBe('paused');

        cleanup();
        await open('main');
        await click('thing-row-t-2');
        await waitFor(() => expect(byTestId('thing-offer-gone')?.textContent).toContain('Its Offer has gone from the Market.'));
        await click('thing-delete');
        await click('thing-delete-yes');
        expect(byTestId('thing-refused')).toBeNull();
        expect((await kept()).things.find((t) => (t as Thing).id === 't-2')).toMatchObject({ gone: true });
        expect(byTestId('things-main')).not.toBeNull();
        expect(server.paused).toEqual([]);
        // The paused one's pause is still asked, as its owner's: one a shop closed for now paused would otherwise come back
        // with the reopen. The gone one asks nothing.
        expect(server.asks).toEqual(['pause post-1']);
    });

    it("an Offer paused elsewhere after the screen opened: Take out reads it first, so the thing is taken out, never \"couldn't reach\"", async () => {
        offer('post-1', 'Ladder');
        await keep(shed(thing('t-1', 'Ladder', { postId: 'post-1' })));
        await open('thing', 't-1');
        server.posts.get('post-1')!.status = 'paused';
        await click('thing-take-out');
        expect(byTestId('thing-refused')).toBeNull();
        expect(server.paused).toEqual([]);
        expect(server.asks).toEqual(['pause post-1']);
        expect(await keptThing('t-1')).toMatchObject({ pausedPostId: 'post-1' });
        expect(byTestId('thing-state')?.textContent).toBe('Taken out of your shop');
    });

    it("with the shop closed for now: Take out, Lend and Delete each ask the owner's pause, so the reopen leaves those Offers down and puts back the rest", async () => {
        offer('post-1', 'Drill');
        offer('post-2', 'Ladder');
        offer('post-3', 'Tent');
        offer('post-4', 'Hammer');
        await keep(shed(...['Drill', 'Ladder', 'Tent', 'Hammer'].map((name, i) => thing(`t-${i + 1}`, name, { postId: `post-${i + 1}` }))));
        // Take out on a screen opened while the shop was open; it closed meanwhile.
        await open('thing', 't-3');
        closeShop('post-1', 'post-2', 'post-3', 'post-4');
        await click('thing-take-out');
        expect(byTestId('thing-refused')).toBeNull();
        expect(await keptThing('t-3')).toMatchObject({ pausedPostId: 'post-3' });

        // Lend on a screen opened while it is closed: its Offer reads paused.
        cleanup();
        await open('thing', 't-2');
        await waitFor(() => expect(byTestId('thing-offer-paused')?.textContent).toContain('Its Offer is paused in the Market.'));
        await click('thing-lend');
        await type('thing-lend-name', 'Sam');
        await click('thing-lend-save');
        expect(byTestId('thing-refused')).toBeNull();
        expect((await keptThing('t-2'))?.lentTo?.name).toBe('Sam');

        cleanup();
        await open('main');
        await click('thing-row-t-1');
        await click('thing-delete');
        await click('thing-delete-yes');
        expect(byTestId('thing-refused')).toBeNull();
        // The Delete's round trip and its write can take longer than click()'s settle under load: wait for it to land.
        await waitFor(() => expect(byTestId('things-main')).not.toBeNull());

        expect(server.asks).toEqual(['pause post-3', 'pause post-2', 'pause post-1']);
        expect([...server.shopHeld]).toEqual(['post-4']);
        reopenShop();
        expect(['post-1', 'post-2', 'post-3', 'post-4'].map((id) => server.posts.get(id)?.status)).toEqual(['paused', 'paused', 'paused', 'active']);
    });

    it("with the shop closed for now, a thing taken out by linking it to the Offer the shop paused: Lend and Delete ask the owner's pause too, so the reopen leaves those Offers down", async () => {
        offer('post-1', 'Drill');
        offer('post-2', 'Ladder');
        offer('post-3', 'Hammer');
        await keep(shed(thing('t-1', 'Drill'), thing('t-2', 'Ladder')));
        closeShop('post-1', 'post-2', 'post-3');
        // Linked while the shop is closed: its Offer reads paused, so the thing is taken out of the shop, and only its
        // pausedPostId names the Offer.
        await open('thing', 't-1');
        await click('thing-link');
        await click('thing-link-post-1');
        expect(byTestId('thing-state')?.textContent).toBe('Taken out of your shop');
        await click('thing-lend');
        await type('thing-lend-name', 'Sam');
        await click('thing-lend-save');
        await waitFor(async () => expect(await keptThing('t-1')).toMatchObject({ pausedPostId: 'post-1', lentTo: { name: 'Sam' } }));
        expect(byTestId('thing-refused')).toBeNull();

        cleanup();
        await open('main');
        await click('thing-row-t-2');
        await click('thing-link');
        await click('thing-link-post-2');
        expect(byTestId('thing-state')?.textContent).toBe('Taken out of your shop');
        await click('thing-delete');
        await click('thing-delete-yes');
        expect(byTestId('thing-refused')).toBeNull();
        await waitFor(() => expect(byTestId('things-main')).not.toBeNull());
        expect((await kept()).things.find((t) => (t as Thing).id === 't-2')).toMatchObject({ gone: true });

        expect(server.asks).toEqual(['pause post-1', 'pause post-2']);
        expect([...server.shopHeld]).toEqual(['post-3']);
        reopenShop();
        expect(['post-1', 'post-2', 'post-3'].map((id) => server.posts.get(id)?.status)).toEqual(['paused', 'paused', 'active']);
    });

    it("linked while its shop was closed, then the shop reopened: its screen says its Offer is up again, and lent through BeanPool it is Out in its row, on its screen and in Loans, never \"nothing out\"", async () => {
        offer('post-1', 'Drill');
        await keep(shed(thing('t-1', 'Drill')));
        closeShop('post-1');
        await open('thing', 't-1');
        await click('thing-link');
        await click('thing-link-post-1');
        expect(byTestId('thing-state')?.textContent).toBe('Taken out of your shop');
        expect(server.asks).toEqual([]);
        // The reopen puts the Offer back up, as the shop still holds it: nothing in the Tool shed did that.
        reopenShop();
        expect(server.posts.get('post-1')?.status).toBe('active');
        cleanup();
        await open('thing', 't-1');
        await waitFor(() => expect(byTestId('thing-offer-live')?.textContent).toBe('Its Offer is up in the Market again.'));
        expect(byTestId('thing-put-back')).not.toBeNull();

        // Someone borrows it through BeanPool.
        cleanup();
        offer('post-1', 'Drill', 'pending', { lendable: true, acceptedAt: iso(NOW - DAY) });
        server.deals.push({ id: 'tx1', postId: 'post-1', sellerPublicKey: OWNER, buyerPublicKey: 'b', status: 'pending', hours: 3, createdAt: iso(NOW - DAY) });
        await open('main');
        await waitFor(() => expect(rows()).toEqual([expect.stringMatching(/^DrillOut · due \d{1,2} [A-Z][a-z]{2}$/)]));
        await click('things-loans');
        await waitFor(() => expect(byTestId('loan-row-t-1')).not.toBeNull());
        expect(within(byTestId('loans-beanpool')!).getByTestId('loan-row-t-1')).toBeTruthy();
        expect(byTestId('loans-none')).toBeNull();
        await click('loan-row-t-1');
        await waitFor(() => expect(byTestId('thing-state')?.textContent).toMatch(/^Out on a loan · back around /));
        expect(byTestId('thing-deal-note')?.textContent).toBe('It is out on a loan through BeanPool. The borrower confirms it is back in the deal.');
        expect(['thing-put-back', 'thing-lend', 'thing-delete', 'thing-offer-live'].map((id) => byTestId(id))).toEqual([null, null, null, null]);
        expect(server.asks).toEqual([]);
    });

    it("taken out, its Offer up again (the Market's own resume): Put back says so in the shop and asks nothing of the Market", async () => {
        offer('post-1', 'Drill');
        await keep(shed(thing('t-1', 'Drill', { pausedPostId: 'post-1' })));
        await open('thing', 't-1');
        await waitFor(() => expect(byTestId('thing-offer-live')).not.toBeNull());
        await click('thing-put-back');
        expect(await keptThing('t-1')).toMatchObject({ postId: 'post-1' });
        expect(byTestId('thing-state')?.textContent).toBe('In your shop');
        expect(byTestId('thing-offer-live')).toBeNull();
        expect(server.asks).toEqual([]);
        // Taken out again: the same Offer, paused; never "up in the Market again" over the pause just made.
        await click('thing-take-out');
        expect(byTestId('thing-state')?.textContent).toBe('Taken out of your shop');
        expect(byTestId('thing-offer-live')).toBeNull();
        expect(server.asks).toEqual(['pause post-1']);
    });

    it("a read of its Offer that lands after Take out or Put back never undoes it: no \"up again\" over the pause, no \"paused\" and no second Put back over the resume", async () => {
        let release!: () => void;
        offer('post-1', 'Drill');
        await keep(shed(thing('t-1', 'Drill', { postId: 'post-1' })));
        server.readGate = new Promise<void>((r) => { release = r; });
        await open('thing', 't-1');
        await click('thing-take-out');
        expect(server.posts.get('post-1')?.status).toBe('paused');
        expect(byTestId('thing-state')?.textContent).toBe('Taken out of your shop');
        // The screen's own first read, sent as it opened while the Offer was live, lands now.
        await act(async () => { release(); });
        await settle();
        expect(byTestId('thing-state')?.textContent).toBe('Taken out of your shop');
        expect(byTestId('thing-offer-live')).toBeNull();
        cleanup();
        server.readGate = new Promise<void>((r) => { release = r; });
        await open('thing', 't-1');
        await click('thing-put-back');
        expect(server.posts.get('post-1')?.status).toBe('active');
        expect(byTestId('thing-state')?.textContent).toBe('In your shop');
        // Its first read, sent while the Offer was paused, lands now.
        await act(async () => { release(); });
        await settle();
        expect(byTestId('thing-state')?.textContent).toBe('In your shop');
        expect(['thing-offer-paused', 'thing-resume'].map((id) => byTestId(id))).toEqual([null, null]);
        expect(byTestId('thing-take-out')).not.toBeNull();
    });

    it("taken out, its deals not yet known: Lend and Delete wait for them, as for a thing in the shop", async () => {
        let release!: () => void;
        server.dealsGate = new Promise<void>((r) => { release = r; });
        offer('post-1', 'Drill', 'paused');
        await keep(shed(thing('t-1', 'Drill', { pausedPostId: 'post-1' })));
        await open('thing', 't-1');
        expect(['thing-lend', 'thing-delete'].map((id) => byTestId(id))).toEqual([null, null]);
        expect(byTestId('thing-put-back')).not.toBeNull();
        release();
        await waitFor(() => expect(['thing-lend', 'thing-delete'].filter((id) => byTestId(id) === null)).toEqual([]));
    });

    it("a panel from the … menu over a thing is no leave: the Lend form keeps its name, and a Delete that lands meanwhile goes back to Your things", async () => {
        offer('post-1', 'Drill');
        await keep(shed(thing('t-1', 'Drill', { postId: 'post-1' }), thing('t-2', 'Ladder')));
        drawStrict('main');
        await screen.findByTestId('things-main');
        await settle();
        await click('thing-row-t-2');
        await click('thing-lend');
        await type('thing-lend-name', 'Sam');
        await click('tool-menu');
        await click('tool-menu-settings');
        await click('tools-back');
        expect((byTestId('thing-lend-name') as HTMLInputElement).value).toBe('Sam');
        await click('thing-lend-cancel');
        await click('tools-back');

        await click('thing-row-t-1');
        let answer = () => {};
        server.marketGate = new Promise<void>((r) => { answer = r; });
        await click('thing-delete');
        await click('thing-delete-yes');
        await waitFor(() => expect(server.asks).toEqual(['pause post-1']));
        await click('tool-menu');
        await click('tool-menu-about');
        answer();
        await waitFor(async () => expect(shedThings(await kept()).map((t) => t.id)).toEqual(['t-2']));
        await settle();
        // The panel stays where the member put it; behind it, the Delete went back a screen.
        expect(byTestId('tool-about')).not.toBeNull();
        await click('tools-back');
        expect(byTestId('tool-about')).toBeNull();
        expect(byTestId('things-main')).not.toBeNull();
        expect(byTestId('thing-missing')).toBeNull();
        expect(byTestId('thing-row-t-1')).toBeNull();
        expect(byTestId('thing-row-t-2')).not.toBeNull();
    });

    it("Put back while the shop is closed for now says so in the Tool shed's words, never \"couldn't reach\", and changes nothing", async () => {
        const closed = "Your shop is closed for now, so this can't go back in it yet. Reopen your shop first.";
        offer('post-1', 'Drill');
        offer('post-2', 'Tent', 'paused');
        const drill = thing('t-1', 'Drill', { postId: 'post-1' });
        const tent = thing('t-2', 'Tent', { pausedPostId: 'post-2' });
        await keep(shed(drill, tent));
        closeShop('post-1', 'post-2');
        // In the shop, its Offer paused by the closing: the paused section's Put back.
        await open('thing', 't-1');
        await waitFor(() => expect(byTestId('thing-offer-paused')).not.toBeNull());
        await click('thing-resume');
        expect(byTestId('thing-refused')?.textContent).toBe(closed);
        expect(byTestId('thing-offer-paused')).not.toBeNull();
        // Taken out: Put back.
        cleanup();
        await open('thing', 't-2');
        await click('thing-put-back');
        expect(byTestId('thing-refused')?.textContent).toBe(closed);
        expect(byTestId('thing-state')?.textContent).toBe('Taken out of your shop');
        expect([server.resumed, server.posts.get('post-1')?.status, server.posts.get('post-2')?.status]).toEqual([[], 'paused', 'paused']);
        expect((await kept()).things).toEqual([drill, tent]);
    });

    /**
     * The open's sync takes the server's newer copy while `press` waits for the Market's answer: this browser holds
     * `ladder`, synced; the server's copy (`copy`) is newer, by default with Drill too (added on the member's phone). Its
     * read is held until the pause or resume is asked, and that answer until the copy is taken (`meanwhile` runs before
     * either is let go). Then what this browser keeps, and what the next sync sends the server.
     */
    async function takenMeanwhile(ladder: Thing, press: () => Promise<void>, copy = shed(ladder, thing('t-2', 'Drill')), meanwhile = () => {}) {
        const synced = iso(NOW - DAY);
        expect(await writeToolRecord(OWNER, 'things', { body: JSON.stringify(shed(ladder)), updatedAt: synced, syncedAt: synced })).toBe(true);
        let copyAnswers = () => {};
        let marketAnswers = () => {};
        server.copy = { doc: copy, updatedAt: iso(NOW - DAY / 2) };
        server.copyGate = new Promise((r) => { copyAnswers = r; });
        server.marketGate = new Promise((r) => { marketAnswers = r; });
        await open('thing', 't-1');
        await press();
        expect(server.requests.at(-1)).toMatch(/^POST \/api\/marketplace\/posts\/(pause|resume)$/);
        meanwhile();
        copyAnswers();
        await settle();
        expect(await kept()).toEqual(readThingsDoc(copy));
        marketAnswers();
        await settle();
        const here = await kept();
        const sync = await openToolCopy({ manifest: THINGS, owner: { kind: 'member', publicKey: OWNER }, node: pageNode() });
        return { here, sync, sent: server.puts.at(-1) as ThingsDoc | undefined };
    }

    /** The things in a document, in its order, by name. */
    const names = (d: ThingsDoc | undefined) => (d ? readThingsDoc(d).things.map((t) => (t as Thing).name) : null);

    it("Take out while the open's sync takes the server's newer copy: the other device's thing is kept, here and on the server", async () => {
        offer('post-1', 'Ladder');
        const after = await takenMeanwhile(thing('t-1', 'Ladder', { postId: 'post-1' }), () => click('thing-take-out'));
        expect(server.paused).toEqual(['post-1']);
        expect([names(after.here), after.sync, names(after.sent)]).toEqual([['Ladder', 'Drill'], 'put', ['Ladder', 'Drill']]);
        expect(after.here.things[0]).toMatchObject({ id: 't-1', pausedPostId: 'post-1' });
        expect(after.here.things[1]).toEqual(thing('t-2', 'Drill'));
        expect(byTestId('thing-refused')).toBeNull();
        expect(byTestId('thing-state')?.textContent).toBe('Taken out of your shop');
    });

    it("Lend while the open's sync takes the server's newer copy: the other device's thing is kept, here and on the server", async () => {
        offer('post-1', 'Ladder');
        const after = await takenMeanwhile(thing('t-1', 'Ladder', { postId: 'post-1' }), async () => {
            await click('thing-lend');
            await type('thing-lend-name', 'Sam');
            await click('thing-lend-save');
        });
        expect(server.paused).toEqual(['post-1']);
        expect([names(after.here), after.sync, names(after.sent)]).toEqual([['Ladder', 'Drill'], 'put', ['Ladder', 'Drill']]);
        expect(after.here.things[0]).toMatchObject({ id: 't-1', postId: 'post-1', lentTo: { name: 'Sam' } });
        expect(after.here.things[1]).toEqual(thing('t-2', 'Drill'));
        expect(byTestId('thing-lend-name')).toBeNull();
        expect(byTestId('thing-state')?.textContent).toMatch(/^With Sam since /);
    });

    it("It's back while the open's sync takes the server's newer copy: the other device's thing is kept, here and on the server", async () => {
        offer('post-1', 'Ladder', 'paused');
        const after = await takenMeanwhile(thing('t-1', 'Ladder', { postId: 'post-1', lentTo: { name: 'Sam', since: iso(NOW - DAY) } }), () => click('thing-back-home'));
        expect(server.resumed).toEqual(['post-1']);
        expect([names(after.here), after.sync, names(after.sent)]).toEqual([['Ladder', 'Drill'], 'put', ['Ladder', 'Drill']]);
        expect(after.here.things[0]).toMatchObject({ id: 't-1', postId: 'post-1' });
        expect((after.here.things[0] as Thing).lentTo).toBeUndefined();
        expect(after.here.things[1]).toEqual(thing('t-2', 'Drill'));
        expect(byTestId('thing-state')?.textContent).toBe('In your shop');
    });

    /** A shed with `first` in it and things to fill it, `room` bytes under the shed's own bound (128 KB). */
    function shedWithRoom(first: Thing, room: number): ThingsDoc {
        const target = THINGS_DOC_BYTES - room;
        const big = (i: number) => thing(`f-${i}`, 'n'.repeat(80), { lendTerms: 't'.repeat(300), ownerNote: 'o'.repeat(500), replacementValue: 'r'.repeat(40) });
        const small = (i: number) => thing(`f-${i}`, 'n'.repeat(80));
        // The last thing's note: a letter more is a byte more, so it takes up all that is left but `room`.
        const last = (k: number) => thing('f-last', 'Odds and ends', { ownerNote: 'o'.repeat(1 + k) });
        const fill: Thing[] = [];
        while (toolDocBytes(shed(first, ...fill, big(fill.length), last(0))) <= target) fill.push(big(fill.length));
        while (toolDocBytes(shed(first, ...fill, small(fill.length), last(0))) <= target) fill.push(small(fill.length));
        const doc = shed(first, ...fill, last(target - toolDocBytes(shed(first, ...fill, last(0)))));
        expect(toolDocBytes(doc)).toBe(target);
        return doc;
    }
    const FULL = FULL_LINE;

    it("at the store's bound, lend, take out and link say the shed is full before the server is asked anything; nothing changes", async () => {
        offer('post-1', 'Ladder');
        const listed = thing('t-1', 'Ladder', { postId: 'post-1' });
        // Lent to Sam, back in a week: more than the 40 bytes left.
        const full = shedWithRoom(listed, 40);
        expect(toolDocBytes(lendOutside(full, 't-1', 'Sam', backAroundIn(NOW, 7), NOW))).toBeGreaterThan(THINGS_DOC_BYTES);
        await keep(full);
        const before = await kept();
        expect(toolDocBytes(before)).toBe(THINGS_DOC_BYTES - 40);
        await open('thing', 't-1');
        const asked = server.requests.length;
        await click('thing-lend');
        await type('thing-lend-name', 'Sam');
        await click('thing-lend-back-7');
        await click('thing-lend-save');
        expect([server.paused, server.posts.get('post-1')?.status, server.requests.slice(asked)]).toEqual([[], 'active', []]);
        expect(await kept()).toEqual(before);
        expect(byTestId('thing-refused')?.textContent).toBe(FULL);
        expect(byTestId('thing-state')?.textContent).toBe('In your shop');

        // Taken out, its Offer's id is kept as pausedPostId: 6 bytes more than the 3 left.
        cleanup();
        await keep(shedWithRoom(listed, 3));
        const before2 = await kept();
        await open('thing', 't-1');
        const asked2 = server.requests.length;
        await click('thing-take-out');
        expect([server.paused, server.posts.get('post-1')?.status, server.requests.slice(asked2)]).toEqual([[], 'active', []]);
        expect(await kept()).toEqual(before2);
        expect(byTestId('thing-refused')?.textContent).toBe(FULL);

        // Linked (no server step): its Offer's id is more than the 10 bytes left, and the shed is said to be full.
        cleanup();
        await keep(shedWithRoom(thing('t-1', 'Ladder'), 10));
        const before3 = await kept();
        await open('thing', 't-1');
        await click('thing-link');
        await click('thing-link-post-1');
        expect(byTestId('thing-refused')?.textContent).toBe(FULL);
        expect(await kept()).toEqual(before3);
    });

    it("a change that no longer fits once the open has taken the server's fuller copy: the shed is said to be full, nothing is written, and the Offer is put back as it was", async () => {
        offer('post-1', 'Ladder');
        const ladder = thing('t-1', 'Ladder', { postId: 'post-1' });
        // Filled on the member's other device, 3 bytes under the bound: taken out, the Offer's id is kept as pausedPostId,
        // 6 bytes more. What is here fits it easily, so Take out asks the Market.
        const full = shedWithRoom(ladder, 3);
        let after = await takenMeanwhile(ladder, () => click('thing-take-out'), full);
        expect([server.paused, server.resumed, server.posts.get('post-1')?.status]).toEqual([['post-1'], ['post-1'], 'active']);
        expect(after.here).toEqual(readThingsDoc(full));
        expect([after.sync, after.sent]).toEqual(['nothing', undefined]);
        expect(byTestId('thing-refused')?.textContent).toBe(FULL);
        expect(byTestId('thing-state')?.textContent).toBe('In your shop');
        expect(byTestId('thing-offer-paused')).toBeNull();

        // The Market can't be reached to put it back: the screen says its Offer is paused, with Put back, which resumes it.
        cleanup();
        server.posts.clear();
        server.paused.length = 0;
        server.resumed.length = 0;
        offer('post-1', 'Ladder');
        after = await takenMeanwhile(ladder, () => click('thing-take-out'), full, () => { server.down = true; });
        expect([server.paused, server.resumed, server.posts.get('post-1')?.status]).toEqual([['post-1'], [], 'paused']);
        expect(after.here).toEqual(readThingsDoc(full));
        expect(byTestId('thing-refused')?.textContent).toBe(FULL);
        expect(byTestId('thing-state')?.textContent).toBe('In your shop');
        expect(byTestId('thing-offer-paused')?.textContent).toContain('Its Offer is paused in the Market.');
        server.down = false;
        await click('thing-resume');
        expect([server.resumed, server.posts.get('post-1')?.status]).toEqual([['post-1'], 'active']);
        expect(byTestId('thing-offer-paused')).toBeNull();
        expect(await kept()).toEqual(readThingsDoc(full));
    });

    it("a change this browser couldn't keep says so in its own words, never that the shed is full", async () => {
        offer('post-1', 'Ladder');
        await keep(shed(thing('t-1', 'Ladder')));
        await open('thing', 't-1');
        await click('thing-link');
        storeFails.on = true;
        await click('thing-link-post-1');
        storeFails.on = false;
        expect(byTestId('thing-refused')?.textContent).toBe("Couldn't save it in this browser. Try again.");
        expect((await keptThing('t-1'))?.postId).toBeUndefined();
        // Not linked, so the Offers to link stay open to try again.
        expect(byTestId('thing-link-post-1')).not.toBeNull();
        // Nothing changed on the screen either (it reads host.doc.get()), so the next write that is kept doesn't carry the
        // link the member was told had failed.
        expect(byTestId('thing-state')?.textContent).toBe('On your shelf');
        await click('thing-lend');
        await type('thing-lend-name', 'Sam');
        await click('thing-lend-save');
        expect(server.paused).toEqual([]);
        expect(await keptThing('t-1')).toMatchObject({ lentTo: { name: 'Sam' } });
        expect((await keptThing('t-1'))?.postId).toBeUndefined();
    });

    it("List it again that this browser couldn't keep says so, and opens no composer over a thing still linked to the gone Offer", async () => {
        await keep(shed(thing('t-1', 'Cordless drill', { postId: 'post-9' })));
        const { props } = await open('thing', 't-1');
        storeFails.on = true;
        await click('thing-relist');
        storeFails.on = false;
        expect(byTestId('thing-refused')?.textContent).toBe("Couldn't save it in this browser. Try again.");
        expect(props.onComposer).not.toHaveBeenCalled();
        expect((await keptThing('t-1'))?.postId).toBe('post-9');

        await click('thing-relist');
        expect(byTestId('thing-refused')).toBeNull();
        await waitFor(() => expect(props.onComposer).toHaveBeenCalledTimes(1));
        expect((await keptThing('t-1'))?.postId).toBeUndefined();
    });

    it("keep: past the bound it never asks the host; the host's own size refusal is the shed full; anything else is not kept", async () => {
        const set = vi.fn(async (_next: ThingsDoc) => {});
        const over = shedWithRoom(thing('t-1', 'Ladder'), 0);
        const setting = (s: typeof set) => ({ doc: { get: () => over, set: s, maxBytes: () => THINGS_DOC_BYTES } }) as unknown as Parameters<typeof keepThings>[0];
        expect(await keepThings(setting(set), lendOutside(over, 't-1', 'Sam', null, NOW))).toBe('too-big');
        expect(set).not.toHaveBeenCalled();
        expect(await keepThings(setting(set), shed(thing('t-1', 'Ladder')))).toBeNull();
        // The bound is the host's: an older server's 64 KB refuses before the host is asked, as the shed's own 128 KB does.
        const older = (held: ThingsDoc) => ({ doc: { get: () => held, set, maxBytes: () => 65_536 } }) as unknown as Parameters<typeof keepThings>[0];
        const sixty = shed(...Array.from({ length: 60 }, (_, i) => atCaps(i)));
        set.mockClear();
        expect(await keepThings(older(shed()), sixty)).toBe('too-big');
        expect(set).not.toHaveBeenCalled();
        // Unless the host holds more than that already (kept before the server said 64 KB): smaller is handed to the host.
        expect(toolDocBytes(sixty)).toBeGreaterThan(65_536);
        expect(await keepThings(older(over), sixty)).toBeNull();
        expect(set).toHaveBeenCalledWith(sixty);
        set.mockClear();
        expect(await keepThings(setting(vi.fn(async () => { throw new ToolDocTooBig(70_000, 65_536); })), shed())).toBe('too-big');
        expect(await keepThings(setting(vi.fn(async () => { throw new ToolDocNotKept(); })), shed())).toBe('not-kept');
    });

    it("in the shop: until its deals are known, nothing that would pause its Offer or delete it; deals that can't be read say so", async () => {
        let release!: () => void;
        server.dealsGate = new Promise<void>((r) => { release = r; });
        offer('post-1', 'Drill');
        await keep(shed(thing('t-1', 'Drill', { postId: 'post-1' })));
        await open('thing', 't-1');
        expect(['thing-take-out', 'thing-lend', 'thing-delete'].map((id) => byTestId(id))).toEqual([null, null, null]);
        expect(byTestId('thing-edit')).not.toBeNull();
        release();
        await waitFor(() => expect(['thing-take-out', 'thing-lend', 'thing-delete'].filter((id) => byTestId(id) === null)).toEqual([]));
        expect(byTestId('thing-unchecked')).toBeNull();
        cleanup();
        server.dealsGate = null;
        server.dealsDown = true;
        await open('thing', 't-1');
        await waitFor(() => expect(byTestId('thing-unchecked')?.textContent).toBe("Loans through BeanPool couldn't be checked just now."));
        expect(['thing-take-out', 'thing-lend', 'thing-delete'].map((id) => byTestId(id))).toEqual([null, null, null]);
        expect(byTestId('thing-edit')).not.toBeNull();
    });

    it("out on a BeanPool loan: the deal's words, its back-around from the deal, and no delete", async () => {
        offer('post-1', 'Drill', 'pending', { lendable: true, acceptedAt: iso(NOW - DAY) });
        server.deals.push({ id: 'tx1', postId: 'post-1', sellerPublicKey: OWNER, buyerPublicKey: 'b', status: 'pending', hours: 3, createdAt: iso(NOW - 2 * DAY) });
        await keep(shed(thing('t-1', 'Drill', { postId: 'post-1' })));
        await open('thing', 't-1');
        await waitFor(() => expect(byTestId('thing-state')?.textContent).toMatch(/^Out on a loan · back around /));
        expect(byTestId('thing-deal-note')?.textContent).toBe('It is out on a loan through BeanPool. The borrower confirms it is back in the deal.');
        expect(byTestId('thing-delete')).toBeNull();
        expect(byTestId('thing-take-out')).toBeNull();
    });

    it("past the node's page of 50: every Offer is offered to link, and a loan still out is out, with its date", async () => {
        for (let i = 1; i <= 60; i++) offer(`old-${i}`, `Old offer ${i}`);
        offer('post-1', 'Drill', 'pending', { lendable: true, acceptedAt: iso(NOW - DAY) });
        offer('post-2', 'Ladder');
        for (let i = 1; i <= 60; i++) server.deals.push({ id: `done-${i}`, postId: `old-${i}`, sellerPublicKey: OWNER, buyerPublicKey: 'c', status: 'completed', createdAt: iso(NOW - DAY) });
        server.deals.push({ id: 'tx-out', postId: 'post-1', sellerPublicKey: OWNER, buyerPublicKey: 'b', status: 'pending', hours: 3, createdAt: iso(NOW - 30 * DAY) });
        await keep(shed(thing('t-1', 'Drill', { postId: 'post-1' }), thing('t-2', 'Ladder')));
        await open('thing', 't-1');
        await waitFor(() => expect(byTestId('thing-state')?.textContent).toMatch(/^Out on a loan · back around /));
        expect(byTestId('thing-delete')).toBeNull();
        cleanup();
        await open('thing', 't-2');
        await click('thing-link');
        expect(byTestId('thing-link-post-2')).not.toBeNull();
        expect(screen.queryAllByTestId(/^thing-link-(old|post)-/)).toHaveLength(61);
    });

    it("the community's price guide: a hint where Beans are on, none where they are off; never a price set", async () => {
        server.guide = { items: [{ id: 'th-002', category: 'tools', emoji: '🪜', name: 'Extension Ladder Hire (6m / Day)', description: '', priceBeans: 12, unit: 'day' }] };
        await keep(shed(thing('t-1', 'Step ladder')));
        const { props } = await open('thing', 't-1');
        await waitFor(() => expect(byTestId('thing-hint')?.textContent).toBe("Your community's price guide says about 12 Beans a day for something like this. Free is fine too."));
        await click('thing-list');
        expect((props.onComposer as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ credits: null, priceType: null });
        cleanup();
        info.value = { profile: 'global', features: { beans: false } };
        await open('thing', 't-1');
        expect(byTestId('thing-hint')).toBeNull();
    });

    it('a thing that is not there (an old link, a deleted thing): said, never a crash', async () => {
        await keep(shed(thing('t-1', 'Drill', { gone: true })));
        await open('thing', 't-1');
        expect(byTestId('thing-missing')?.textContent).toContain('This thing is no longer in your Tool shed.');
    });
});

describe('Loans', () => {
    it('lent outside and through BeanPool, overdue first; each opens its thing', async () => {
        offer('post-1', 'Drill', 'pending', { lendable: true, acceptedAt: iso(NOW - DAY) });
        server.deals.push({ id: 'tx1', postId: 'post-1', sellerPublicKey: OWNER, buyerPublicKey: 'b', status: 'pending', hours: 5, createdAt: iso(NOW - 2 * DAY) });
        offer('post-2', 'Tent');
        server.deals.push({ id: 'tx2', postId: 'post-2', sellerPublicKey: OWNER, buyerPublicKey: 'c', status: 'requested', createdAt: iso(NOW - DAY) });
        await keep(shed(
            thing('t-1', 'Drill', { postId: 'post-1' }),
            thing('t-2', 'Ladder', { lentTo: { name: 'Sam', since: iso(NOW - 9 * DAY), backAround: iso(NOW - 2 * DAY) } }),
            thing('t-3', 'Tent', { postId: 'post-2' }),
            thing('t-4', 'Saw'),
        ));
        await open('loans');
        await waitFor(() => expect(screen.queryAllByTestId(/^loan-row-/).map((r) => r.getAttribute('data-testid'))).toEqual(['loan-row-t-2', 'loan-row-t-1', 'loan-row-t-3']));
        expect(words(byTestId('loan-row-t-2'))).toBe('LadderOverdue · with Sam');
        expect(within(byTestId('loans-outside')!).getByTestId('loan-row-t-2')).toBeTruthy();
        expect(within(byTestId('loans-beanpool')!).getByTestId('loan-row-t-1')).toBeTruthy();
        expect(within(byTestId('loans-asked')!).getByTestId('loan-row-t-3')).toBeTruthy();
        await click('loan-row-t-1');
        expect(byTestId('thing-screen')).not.toBeNull();
    });

    it("nothing out says so; deals that couldn't be checked are said, never shown as nothing out", async () => {
        await keep(shed(thing('t-1', 'Saw')));
        await open('loans');
        await waitFor(() => expect(byTestId('loans-none')?.textContent).toContain('Nothing of yours is out or asked for right now.'));
        cleanup();
        server.down = true;
        await open('loans');
        await waitFor(() => expect(byTestId('loans-unchecked')).not.toBeNull());
        expect(byTestId('loans-none')).toBeNull();
    });

    it("loans that couldn't be checked are announced as they show, on the list and on Loans, from polite regions there before them", async () => {
        await keep(shed(thing('t-1', 'Saw')));
        for (const [screenName, id] of [['main', 'things-loans-unchecked'], ['loans', 'loans-unchecked']] as const) {
            let release!: () => void;
            server.dealsGate = new Promise<void>((r) => { release = r; });
            await open(screenName);
            // The region is there, empty, before the sentence goes in it: one made with its words in it is often not read out.
            const region = byTestId(`${id}-live`)!;
            expect(region.getAttribute('aria-live')).toBe('polite');
            expect(region.textContent).toBe('');
            server.dealsDown = true;
            release();
            await waitFor(() => expect(region.textContent).toBe("Loans through BeanPool couldn't be checked just now."));
            expect(byTestId(`${id}-live`)).toBe(region);
            // In the region, the sentence isn't a status of its own as well.
            expect(byTestId(id)?.closest('[aria-live]')).toBe(region);
            expect(byTestId(id)?.getAttribute('role')).toBeNull();
            server.dealsDown = false;
            cleanup();
        }
    });
});
