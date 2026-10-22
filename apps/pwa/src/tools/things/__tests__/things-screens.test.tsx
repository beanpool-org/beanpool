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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { THINGS, THINGS_MAX_ITEMS, TOOL_LIMITS, readThingsDoc, shedThings, toolDocBytes, type Thing, type ThingsDoc } from '@beanpool/core';
import { ToolsPage, type ToolsPageProps } from '../../../pages/ToolsPage';
import { TOOL_APPS } from '../../index';
import { readToolPhoto, readToolRecord, resetToolStoreForTest, writeToolRecord } from '../../store';
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
const picked = vi.hoisted(() => ({ count: 0, cancel: false, sizes: [] as number[] }));
vi.mock('../../photos', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../photos')>();
    return {
        ...real,
        chooseImageFile: async () => (picked.cancel ? null : new File(['jpeg bytes'], 'picked.jpg', { type: 'image/jpeg' })),
        keepChosen: (owner: string, tool: string, file: File | null, ref: string) => real.keepChosen(owner, tool, file, ref, async () => {
            picked.count++;
            picked.sizes.push(800);
            return { dataUrl: `data:image/jpeg;base64,cGhvdG8${picked.count}`, width: 800, height: 600 };
        }),
    };
});

const OWNER = 'things-web-owner';
const identity = { publicKey: OWNER, privateKey: '', callsign: 'Robin', createdAt: '2026-10-01T00:00:00.000Z' };
/** The fixtures' moment. */
const NOW = Date.parse('2026-10-20T09:00:00.000Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const thing = (id: string, name: string, extra: Partial<Thing> = {}): Thing => ({ id, name, category: 'tools', createdAt: iso(NOW - DAY), updatedAt: iso(NOW - DAY), ...extra });
const shed = (...things: Thing[]): ThingsDoc => ({ v: 1, things });

/** The community's server, as these screens use it; `down` when it can't be reached. */
const server = {
    posts: new Map<string, Record<string, unknown>>(),
    deals: [] as Array<Record<string, unknown>>,
    guide: { items: [] as unknown[] },
    paused: [] as string[], resumed: [] as string[],
    requests: [] as string[],
    down: false,
};
function offer(id: string, title: string, status = 'active', extra: Record<string, unknown> = {}) {
    server.posts.set(id, { id, title, status, type: 'offer', authorPublicKey: OWNER, priceType: 'fixed', ...extra });
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
async function answer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input), 'https://mullum.example');
    const method = (init?.method ?? 'GET').toUpperCase();
    server.requests.push(`${method} ${url.pathname}`);
    if (server.down) throw new TypeError('Failed to fetch');
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    switch (`${method} ${url.pathname}`) {
        case 'GET /api/tools/things': return json({ tool: 'things', doc: null, updatedAt: null });
        case 'PUT /api/tools/things': return json({ success: true, tool: 'things', updatedAt: '2026-10-21T08:00:00.000Z' });
        case 'GET /api/marketplace/posts': {
            const id = url.searchParams.get('id');
            const author = url.searchParams.get('author');
            const all = [...server.posts.values()];
            return json(id ? all.filter((p) => p.id === id) : all.filter((p) => !author || p.authorPublicKey === author));
        }
        case 'GET /api/marketplace/transactions': return json(server.deals.filter((d) => d.sellerPublicKey === url.searchParams.get('publicKey') || d.buyerPublicKey === url.searchParams.get('publicKey')));
        case 'POST /api/marketplace/posts/pause': {
            server.paused.push(body.postId);
            const p = server.posts.get(body.postId);
            if (p) p.status = 'paused';
            return json({ success: true });
        }
        case 'POST /api/marketplace/posts/resume': {
            server.resumed.push(body.postId);
            const p = server.posts.get(body.postId);
            if (p) p.status = 'active';
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
    server.deals.length = 0;
    server.guide = { items: [] };
    server.paused.length = 0;
    server.resumed.length = 0;
    server.requests.length = 0;
    server.down = false;
    info.value = { profile: 'local', features: { beans: true } };
    picked.count = 0;
    picked.cancel = false;
    picked.sizes.length = 0;
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
        expect(rows()).toEqual(['Camping tentOn your shelf', expect.stringMatching(/^Step ladderWith Alice · back around \d{1,2} [A-Z][a-z]{2}$/), 'Cordless drillIn your shop']);
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

    it(`a ${THINGS_MAX_ITEMS + 1}st thing and a save past the store's bound are refused in one sentence each; nothing is written`, async () => {
        await keep(shed(...Array.from({ length: THINGS_MAX_ITEMS }, (_, i) => thing(`t-${i}`, `Thing ${i}`))));
        await open('edit');
        await type('edit-name', 'One more');
        await click('edit-save');
        expect(byTestId('edit-problem')?.textContent).toBe('Your Tool shed holds 100 things. Take one out first.');
        expect((await kept()).things).toHaveLength(THINGS_MAX_ITEMS);
        cleanup();

        const big = (i: number) => thing(`b-${i}`, 'n'.repeat(80), { lendTerms: 't'.repeat(300), ownerNote: 'o'.repeat(500), replacementValue: 'r'.repeat(40) });
        const full: Thing[] = [];
        while (toolDocBytes(shed(...full, big(full.length))) <= TOOL_LIMITS.docBytes) full.push(big(full.length));
        await keep(shed(...full));
        await open('edit');
        await type('edit-name', 'n'.repeat(80));
        await type('edit-terms', 't'.repeat(300));
        await type('edit-note', 'o'.repeat(500));
        await type('edit-replacement', 'r'.repeat(40));
        await click('edit-save');
        expect(byTestId('edit-problem')?.textContent).toBe('Your Tool shed is full: it keeps up to 64 KB. Take out something you no longer have, or shorten some notes.');
        expect((await kept()).things).toHaveLength(full.length);
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
        expect(words(byTestId('loan-row-t-2'))).toMatch(/^LadderWith Sam · was due back /);
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
});
