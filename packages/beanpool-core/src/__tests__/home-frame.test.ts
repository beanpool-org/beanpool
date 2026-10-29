import { describe, expect, it } from 'vitest';
import {
    HOME_CARD_TYPES, HOME_CHAT_ID_CHARS, HOME_CHAT_KINDS, HOME_CHAT_NAME_CHARS, HOME_COLUMN_CHOICES, HOME_FRAME_LIMITS, HOME_FRAME_MESSAGES,
    HOME_NEWCOMER_FIVE, HOME_STARTER_SET, addCard, cardsToAsk, checkHomeLayout, defaultCards, endTourLayout, homeColumns, moveCard,
    readChatSettings, readHomeLayout, readSearchSettings, removeCard, setHomeColumns, translateV1, type HomeLayoutV2, type HomeNodeFacts,
} from '../home-frame.js';
import { t } from '../words.js';
import { toolHomeCardTypes } from '../tools/index.js';

const AT = '2026-10-08T10:00:00.000Z';
const NOW = Date.parse(AT);
const layout = (cards: HomeLayoutV2['cards'], dismissed: Record<string, string> = {}): HomeLayoutV2 => ({ v: 2, cards, dismissed, updatedAt: AT });
const one = (type: string) => ({ id: type, type });
const FUTURE = { id: 'zzz-future-1', type: 'zzz-future', settings: { a: [1, 'two', { three: null }], é: 'ü' }, extra: 'kept' };

describe('home frame §5.2 (1): readHomeLayout is tolerant and keeps what it does not know', () => {
    it('keeps an instance of an unknown type with its settings byte for byte', () => {
        const read = readHomeLayout({ v: 2, cards: [one('steps'), FUTURE], dismissed: {}, updatedAt: AT });
        expect(read?.cards).toHaveLength(2);
        expect(JSON.stringify(read!.cards[1])).toBe(JSON.stringify(FUTURE));
    });

    it('drops a malformed instance, keeps ids unique (first wins), stops at 24, and refuses nothing', () => {
        const cards: unknown[] = [one('steps'), { id: 'x' }, 'market', { id: 7, type: 'market' }, { id: 'a'.repeat(33), type: 'market' },
            { id: 'q', type: 'search', settings: [] }, { ...one('steps'), settings: { second: true } }, one('market')];
        const read = readHomeLayout({ v: 2, cards, dismissed: { safety: 'not a date', events: AT }, updatedAt: 'never' });
        expect(read).toEqual({ v: 2, cards: [one('steps'), one('market')], dismissed: { events: AT }, updatedAt: null });
        const many = Array.from({ length: 30 }, (_, i) => ({ id: `t-${i}`, type: 't' }));
        expect(readHomeLayout({ v: 2, cards: many })?.cards.map(c => c.id)).toEqual(many.slice(0, 24).map(c => c.id));
    });

    it('anything that is neither version 2 nor version 1 is null (the default Home)', () => {
        for (const v of [null, 'x', [], { v: 3, cards: [] }, { v: 2 }, { v: 2, cards: {} }]) expect(readHomeLayout(v)).toBeNull();
    });

    it('reads version 1 through translateV1: the member order, the rest after, hidden and the fixed two left out, dismissed kept', () => {
        const v1 = { v: 1, order: ['market', 'needs', 'beans'], hidden: ['events', 'community', 'pulse'], dismissed: { safety: AT }, updatedAt: AT };
        const read = readHomeLayout(v1)!;
        expect(read.cards.map(c => c.id)).toEqual([
            'market', 'beans', 'safety', 'find', 'steps', 'tips', 'interests', 'deals', 'enterprise', 'decide', 'groups', 'joined',
            'notices', 'invite',
        ]);
        expect(read.cards.every(c => c.id === c.type && c.settings === undefined)).toBe(true);
        expect(read.dismissed).toEqual({ safety: AT });
        expect(read.updatedAt).toBe(AT);
        expect(translateV1(v1)).toEqual(read);
    });
});

describe('home frame: checkHomeLayout (the node takes a write by shape and bounds, never by type)', () => {
    it('takes an unknown type and a search instance unchanged', () => {
        const value = layout([one('steps'), { id: 'search-k7mq', type: 'search', settings: { q: 'eggs', kind: 'any', km: 5 } }, FUTURE]);
        const checked = checkHomeLayout(value);
        expect(checked.ok && JSON.stringify(checked.layout)).toBe(JSON.stringify(value));
    });

    it('refuses each bound whole, with its problem', () => {
        const cards = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t-${i}`, type: 't' }));
        expect(checkHomeLayout(layout(cards(24))).ok).toBe(true);
        expect(checkHomeLayout(layout(cards(25)))).toEqual({ ok: false, problem: 'tooMany' });
        expect(checkHomeLayout(layout([{ id: 's', type: 's', settings: { q: 'x'.repeat(600) } }]))).toEqual({ ok: false, problem: 'settingsSize' });
        // 512 bytes counted in UTF-8: 250 two-byte letters are 500 bytes plus the braces and key; 260 are over.
        expect(checkHomeLayout(layout([{ id: 's', type: 's', settings: { q: 'é'.repeat(250) } }])).ok).toBe(true);
        expect(checkHomeLayout(layout([{ id: 's', type: 's', settings: { q: 'é'.repeat(260) } }]))).toEqual({ ok: false, problem: 'settingsSize' });
        const big = Array.from({ length: 20 }, (_, i) => ({ id: `t-${i}`, type: 't', settings: { q: 'x'.repeat(480) } }));
        expect(checkHomeLayout(layout(big))).toEqual({ ok: false, problem: 'layoutSize' });
        expect(checkHomeLayout(layout([one('steps'), one('steps')]))).toEqual({ ok: false, problem: 'repeated' });
        expect(checkHomeLayout(layout([{ id: 'a'.repeat(33), type: 'a' }]))).toEqual({ ok: false, problem: 'idLength' });
        expect(checkHomeLayout(layout([{ id: 'a', type: 'b'.repeat(25) }]))).toEqual({ ok: false, problem: 'idLength' });
        expect(checkHomeLayout({ ...layout([]), updatedAt: 'yesterday' })).toEqual({ ok: false, problem: 'date' });
        expect(checkHomeLayout(layout([], { safety: '2026-13-45' }))).toEqual({ ok: false, problem: 'date' });
        for (const bad of [{ v: 1, order: [] }, { v: 2, cards: 'x' }, layout([{ id: 'a', type: 'a', settings: [1] } as never])]) {
            expect(checkHomeLayout(bad)).toEqual({ ok: false, problem: 'shape' });
        }
    });
});

describe('home frame: the size bound is on what is kept (review of #1697, finding 1)', () => {
    it('a body under 8 KB as sent whose kept dates grow it past 8 KB is refused, so nothing kept refuses its own read-back', () => {
        // Short dates ('1' parses) on 24 dismissals and no updatedAt: each is kept as a 24-character ISO string, and the caller
        // stamps updatedAt. Pad settings until the body as sent sits just under the bound.
        const build = (pad: number) => ({
            v: 2,
            cards: Array.from({ length: 24 }, (_, i) => ({ id: `t-${String(i).padStart(2, '0')}`, type: 't', settings: { q: 'x'.repeat(pad) } })),
            dismissed: Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`d-${i}`, '1'])),
        });
        let pad = 0;
        while (new TextEncoder().encode(JSON.stringify(build(pad + 1))).length <= HOME_FRAME_LIMITS.layoutBytes) pad++;
        const sent = build(pad);
        expect(new TextEncoder().encode(JSON.stringify(sent)).length).toBeLessThanOrEqual(HOME_FRAME_LIMITS.layoutBytes);
        expect(checkHomeLayout(sent)).toEqual({ ok: false, problem: 'layoutSize' });
        // And whatever is taken re-checks: a kept layout, stamped, is never refused when sent back unchanged.
        const fits = { ...sent, dismissed: {} };
        const kept = checkHomeLayout(fits);
        expect(kept.ok).toBe(true);
        if (kept.ok) expect(checkHomeLayout({ ...kept.layout, updatedAt: AT }).ok).toBe(true);
    });
});

describe('home frame §5.2 (2): addCard, removeCard, moveCard', () => {
    const base = layout([one('steps'), one('tips')]);

    it('puts a new instance first, after a pinned card, and stamps the change', () => {
        const added = addCard(base, 'beans', { now: NOW + 1 });
        expect(added.ok && added.layout.cards.map(c => c.id)).toEqual(['beans', 'steps', 'tips']);
        expect(added.ok && added.layout.updatedAt).toBe(new Date(NOW + 1).toISOString());
        const pinned = addCard(layout([one('find'), one('steps')]), 'beans', { pinned: ['find'] });
        expect(pinned.ok && pinned.layout.cards.map(c => c.id)).toEqual(['find', 'beans', 'steps']);
    });

    it('refuses a second one-of-a-kind, a fixed or unknown type, the sixth saved search and the 25th card', () => {
        expect(addCard(base, 'steps')).toEqual({ ok: false, refused: 'on-home' });
        expect(addCard(base, 'needs')).toEqual({ ok: false, refused: 'fixed' });
        expect(addCard(base, 'weather')).toEqual({ ok: false, refused: 'unknown' });
        let l: HomeLayoutV2 = base;
        for (let i = 0; i < 5; i++) {
            const r = addCard(l, 'search', { settings: { q: `w${i}` } });
            expect(r.ok).toBe(true);
            if (r.ok) l = r.layout;
        }
        expect(addCard(l, 'search')).toEqual({ ok: false, refused: 'type-full' });
        const full = layout(Array.from({ length: 24 }, (_, i) => ({ id: `t-${i}`, type: 't' })));
        expect(addCard(full, 'beans')).toEqual({ ok: false, refused: 'home-full' });
    });

    it('makes a search id that is not in the list, and reads its settings tolerantly', () => {
        // A random source that repeats: the first id it makes is taken, so the next one is used.
        const seq = [0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5];
        let i = 0;
        const random = () => seq[i++ % seq.length];
        const taken = layout([{ id: 'search-aaaa', type: 'search', settings: { q: 'eggs', kind: 'any' } }]);
        const r = addCard(taken, 'search', { random, settings: { q: '  honey  ', kind: 'swap', km: 3, category: 'nope' } });
        expect(r.ok && r.id).toBe('search-qqqq');
        expect(r.ok && r.layout.cards[0]).toEqual({ id: 'search-qqqq', type: 'search', settings: { q: 'honey', kind: 'any' } });
        expect(readSearchSettings({ q: 'x'.repeat(50), kind: 'offer', km: 5, category: 'food' })).toEqual({ q: 'x'.repeat(40), kind: 'offer', km: 5, category: 'food' });
    });

    it('removes an instance with its settings and dismissal; moves one place, unchanged at an end', () => {
        const l = layout([one('safety'), { id: 'search-k7mq', type: 'search', settings: { q: 'eggs' } }, one('steps')], { safety: AT });
        expect(removeCard(l, 'safety', NOW).dismissed).toEqual({});
        expect(removeCard(l, 'search-k7mq', NOW).cards.map(c => c.id)).toEqual(['safety', 'steps']);
        expect(removeCard(l, 'nope', NOW)).toBe(l);
        expect(moveCard(l, 'steps', -1, NOW).cards.map(c => c.id)).toEqual(['safety', 'steps', 'search-k7mq']);
        expect(moveCard(l, 'safety', -1, NOW)).toBe(l);
        expect(moveCard(l, 'steps', 1, NOW)).toBe(l);
    });
});

describe('home frame W0: the columns a member chose, kept in the layout (DESIGN-home-wide-and-content-fable.md D1)', () => {
    const withView = (view: unknown, cards: HomeLayoutV2['cards'] = [one('steps'), FUTURE]) => ({ ...layout(cards), view });

    it('a layout with a view round-trips byte for byte through the read and the write, for each choice', () => {
        expect(HOME_COLUMN_CHOICES).toEqual(['auto', 1, 2]);
        for (const columns of HOME_COLUMN_CHOICES) {
            const value = withView({ columns });
            const read = readHomeLayout(JSON.parse(JSON.stringify(value)));
            expect(JSON.stringify(read)).toBe(JSON.stringify(value));
            expect(homeColumns(read)).toBe(columns);
            const checked = checkHomeLayout(value);
            expect(checked.ok && JSON.stringify(checked.layout)).toBe(JSON.stringify(value));
        }
    });

    it('a layout without one gains none (Auto), so a layout kept before W0 reads and checks as it did', () => {
        const value = layout([one('steps')]);
        expect(readHomeLayout(value)).not.toHaveProperty('view');
        const checked = checkHomeLayout(value);
        expect(checked.ok && checked.layout).not.toHaveProperty('view');
        expect(homeColumns(readHomeLayout(value))).toBe('auto');
        expect(homeColumns(null)).toBe('auto');
    });

    it('{ columns: 5 } reads as Auto and is refused on a write with the sentence, as is any other columns or a view that is no object', () => {
        expect(homeColumns(readHomeLayout(withView({ columns: 5 })))).toBe('auto');
        expect(readHomeLayout(withView({ columns: 5 }))?.view).toEqual({ columns: 'auto' });
        expect(checkHomeLayout(withView({ columns: 5 }))).toEqual({ ok: false, problem: 'view' });
        for (const columns of [3, 0, -1, 1.5, '2', 'Auto', 'three', null, true, [2], {}]) {
            expect(homeColumns(readHomeLayout(withView({ columns }))), JSON.stringify(columns)).toBe('auto');
            expect(checkHomeLayout(withView({ columns })), JSON.stringify(columns)).toEqual({ ok: false, problem: 'view' });
        }
        expect(checkHomeLayout(withView({}))).toEqual({ ok: false, problem: 'view' });
        for (const view of ['wide', 2, [2], null, true]) {
            const read = readHomeLayout(withView(view));
            expect(read?.cards, JSON.stringify(view)).toHaveLength(2);
            expect(read, JSON.stringify(view)).not.toHaveProperty('view');
            expect(checkHomeLayout(withView(view)), JSON.stringify(view)).toEqual({ ok: false, problem: 'view' });
        }
        expect(HOME_FRAME_MESSAGES.view).toBe("A Home layout's view names its columns: auto, 1 or 2.");
        // Marked for translation (member-words.ts translates it on the way out): t() takes it, English unchanged.
        expect(t(HOME_FRAME_MESSAGES.view)).toBe(HOME_FRAME_MESSAGES.view);
    });

    it("a newer app's own keys in the view ride along, read and written, as an unknown card's settings do", () => {
        const value = withView({ columns: 2, later: { dense: true, list: [1, 'two'] } });
        expect(JSON.stringify(readHomeLayout(value))).toBe(JSON.stringify(value));
        const checked = checkHomeLayout(value);
        expect(checked.ok && JSON.stringify(checked.layout)).toBe(JSON.stringify(value));
        expect(readHomeLayout(withView({ later: 1, columns: 'one' }))?.view).toEqual({ later: 1, columns: 'auto' });
    });

    it('the view counts toward the 8 KB bound', () => {
        const pad = (n: number) => withView({ columns: 2, later: 'x'.repeat(n) }, []);
        let n = 0;
        while (new TextEncoder().encode(JSON.stringify(pad(n + 1))).length <= HOME_FRAME_LIMITS.layoutBytes) n++;
        const kept = checkHomeLayout(pad(n));
        expect(kept.ok && JSON.stringify(kept.layout)).toBe(JSON.stringify(pad(n)));
        expect(checkHomeLayout(pad(n + 1))).toEqual({ ok: false, problem: 'layoutSize' });
    });

    it('version 1 has none: its translation never carries a view', () => {
        const v1 = { v: 1, order: ['market'], hidden: [], dismissed: {}, updatedAt: AT, view: { columns: 2 } };
        expect(readHomeLayout(v1)).not.toHaveProperty('view');
        expect(translateV1(v1)).not.toHaveProperty('view');
    });

    it('kept by addCard, removeCard, moveCard and endTourLayout: columns are no card', () => {
        const view = { columns: 2 as const };
        const l: HomeLayoutV2 = { ...layout([one('start'), one('steps'), one('tips')]), view };
        const added = addCard(l, 'beans', { now: NOW });
        expect(added.ok && added.layout.view).toEqual(view);
        expect(removeCard(l, 'tips', NOW).view).toEqual(view);
        expect(moveCard(l, 'tips', -1, NOW).view).toEqual(view);
        expect(endTourLayout(l, { now: NOW }).view).toEqual(view);
        // A Home with only Getting started on it ends the tour on the starter set: the choice stays.
        expect(endTourLayout({ ...layout([one('start')]), view }, { now: NOW }).view).toEqual(view);
    });

    it('setHomeColumns: the choice made, dated now so the last write wins as for any edit; the same choice changes nothing', () => {
        const l = layout([one('steps')]);
        const two = setHomeColumns(l, 2, NOW + 5);
        expect(two.view).toEqual({ columns: 2 });
        expect(two.cards).toBe(l.cards);
        expect(two.updatedAt).toBe(new Date(NOW + 5).toISOString());
        expect(setHomeColumns(two, 2, NOW + 9)).toBe(two);
        expect(setHomeColumns(l, 'auto', NOW)).toBe(l);
        expect(setHomeColumns(two, 'auto', NOW + 9).view).toEqual({ columns: 'auto' });
        expect(setHomeColumns({ ...l, view: { columns: 1, later: 'x' } }, 2, NOW).view).toEqual({ columns: 2, later: 'x' });
        // A newcomer who never edited chooses on the default Home.
        expect(setHomeColumns(null, 1, NOW)).toMatchObject({ v: 2, cards: defaultCards(), view: { columns: 1 } });
    });
});

describe('home frame §5.2 (3): cardsToAsk', () => {
    it('is the same for the same set whatever the order: catalogue order, then id', () => {
        const a = layout([{ id: 'search-zz11', type: 'search' }, one('market'), one('steps'), { id: 'search-aa22', type: 'search' }]);
        const b = layout([one('steps'), { id: 'search-aa22', type: 'search' }, one('market'), { id: 'search-zz11', type: 'search' }]);
        expect(cardsToAsk(a)).toEqual(['needs', 'steps', 'market', 'search-aa22', 'search-zz11', 'community']);
        expect(cardsToAsk(b).join(',')).toBe(cardsToAsk(a).join(','));
    });

    it("omits asks: 'none' types and never asks an unknown type; a pinned type is asked whatever the list says", () => {
        const l = layout([one('tips'), one('interests'), one('invite'), FUTURE, one('beans')]);
        expect(cardsToAsk(l)).toEqual(['needs', 'beans', 'community']);
        expect(cardsToAsk(l, ['find'])).toEqual(['needs', 'find', 'beans', 'community']);
        // A newcomer's Home is Getting started alone (drawn from the device, never asked): only the fixed two are asked.
        expect(cardsToAsk(null)).toEqual(['needs', 'community']);
    });
});

/** The 320 dp model's width of a word at 15 pt × 1.3, bold (apps/native home-layout-320.test.ts uses the same 0.6 em average). */
const wordDp = (word: string) => word.length * 15 * 1.3 * 0.6;

describe('home frame §5.2 (4): the default and the words', () => {
    it("defaultCards is Getting started alone on both profiles; the starter set is the usual five with the two that manage themselves", () => {
        expect(HOME_NEWCOMER_FIVE).toEqual(['steps', 'tips', 'market', 'events', 'notices']);
        expect(HOME_STARTER_SET).toEqual(['safety', 'steps', 'tips', 'interests', 'market', 'events', 'notices']);
        expect(HOME_STARTER_SET.filter(id => HOME_NEWCOMER_FIVE.includes(id))).toHaveLength(5);
        for (const p of ['local', 'global'] as const) expect(defaultCards(p)).toEqual([{ id: 'start', type: 'start' }]);
    });

    it('every name and line fits the 320 model, says nothing locked, earned or tiered, and says Beans never a symbol', () => {
        for (const t of HOME_CARD_TYPES) {
            for (const text of [t.name, t.globalName ?? '', t.line]) {
                for (const word of text.split(/\s+/).filter(Boolean)) expect(wordDp(word), `${t.id}: ${word}`).toBeLessThanOrEqual(140);
                expect(text).not.toMatch(/lock|earn|tier|level|Ʀ/i);
            }
        }
    });

    it('which node shows which type: no money, Decide or invites on the worldwide community', () => {
        const local: HomeNodeFacts = { profile: 'local', features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true, wordsDoor: false } };
        const global: HomeNodeFacts = { profile: 'global', features: { beans: false, escrow: false, enterprises: false, invites: false, decisions: false, wordsDoor: true } };
        const on = (a: HomeNodeFacts, role?: 'admin' | null) => HOME_CARD_TYPES.filter(t => t.onNode(a, role)).map(t => t.id);
        // A tool's card (tools/index.ts) is wherever its tool is, by its own manifest: the built-in types are pinned here.
        const toolCards = new Set(toolHomeCardTypes().map(t => t.id));
        expect(on(global).filter(id => !toolCards.has(id))).toEqual(['needs', 'safety', 'find', 'start', 'steps', 'tips', 'interests', 'shop', 'events', 'market', 'search', 'groups', 'chat', 'joined', 'pulse', 'sky', 'notices', 'community']);
        expect(on(global).filter(id => toolCards.has(id))).toEqual(toolHomeCardTypes().filter(t => t.onNode(global)).map(t => t.id));
        expect(on(local)).toEqual(HOME_CARD_TYPES.map(t => t.id).filter(id => id !== 'safety' && id !== 'find'));
        const adminsInvite = { ...local, features: { ...local.features, door: 'admins' } };
        expect(on(adminsInvite, null)).not.toContain('invite');
        expect(on(adminsInvite, 'admin')).toContain('invite');
        expect(HOME_FRAME_LIMITS.cards).toBe(24);
    });

    it('sun and moon (F5): one of a kind, Around you, on every node, never asked of the node; its place setting read tolerantly', () => {
        const sky = HOME_CARD_TYPES.find(t => t.id === 'sky')!;
        expect(sky).toMatchObject({ name: 'Sun and moon', line: 'Sunrise, sunset and the moon tonight.', group: 'around', asks: 'none' });
        expect(sky.multiple).toBeUndefined();
        expect(sky.onNode({ profile: 'global', features: {} })).toBe(true);
        expect(sky.readSettings!({ place: 'me' })).toEqual({ place: 'me' });
        expect(sky.readSettings!({ place: 'moon' })).toEqual({ place: 'community' });
        const added = addCard(layout([one('steps')]), 'sky', { settings: { place: 'me', extra: 1 }, now: NOW });
        expect(added.ok && added.layout.cards[0]).toEqual({ id: 'sky', type: 'sky', settings: { place: 'me' } });
        expect(added.ok && addCard(added.layout, 'sky', { now: NOW })).toEqual({ ok: false, refused: 'on-home' });
        expect(added.ok && cardsToAsk(added.layout)).not.toContain('sky');
    });

    it('your shop and tools (S4′): one of a kind, For you, on every node (a shop is no enterprise), asked of the node; no settings', () => {
        const shop = HOME_CARD_TYPES.find(t => t.id === 'shop')!;
        expect(shop).toMatchObject({ name: 'Your shop and tools', group: 'you', asks: 'node' });
        expect(shop.multiple).toBeUndefined();
        expect(shop.fixed).toBeUndefined();
        expect(shop.readSettings).toBeUndefined();
        expect(shop.onNode({ profile: 'global', features: { beans: false, escrow: false, enterprises: false } })).toBe(true);
        expect(shop.onNode({ profile: 'local', features: {} })).toBe(true);
        // Next to the account's other own cards: after Your enterprise, before what is around.
        const ids = HOME_CARD_TYPES.map(t => t.id);
        expect(ids.indexOf('shop')).toBe(ids.indexOf('enterprise') + 1);
        const added = addCard(layout([one('steps')]), 'shop', { now: NOW });
        expect(added.ok && added.layout.cards[0]).toEqual({ id: 'shop', type: 'shop' });
        expect(added.ok && cardsToAsk(added.layout)).toContain('shop');
        // Not in the newcomer's starter set: a member adds it, or opens their shop from Tools.
        expect(HOME_STARTER_SET).not.toContain('shop');
    });
});

describe('a chosen chat (C0, scratch/fable-design/DESIGN-home-chosen-chat-fable.md §1, §2)', () => {
    const picked = { conversationId: 'conv-ana-1', kind: 'dm', name: 'Ana Reyes' };
    const chatCard = (id: string, settings: unknown) => ({ id, type: 'chat', settings: settings as Record<string, unknown> });

    it('is an instance type, For you, up to three, on every node, asked of the node, with settings', () => {
        const chat = HOME_CARD_TYPES.find(t => t.id === 'chat')!;
        expect(chat).toMatchObject({ name: 'A chat', line: 'The last lines of one chat you choose.', group: 'you', multiple: { max: 3 }, asks: 'node' });
        expect(chat.fixed).toBeUndefined();
        expect(chat.readSettings).toBe(readChatSettings);
        for (const a of [{ profile: 'global', features: { beans: false, escrow: false, enterprises: false } }, { profile: 'local', features: {} }]) {
            expect(chat.onNode(a), a.profile).toBe(true);
        }
        // Beside Your groups in the catalogue: the order `cards=` names them in.
        const ids = HOME_CARD_TYPES.map(t => t.id);
        expect(ids.indexOf('chat')).toBe(ids.indexOf('groups') + 1);
        expect(HOME_STARTER_SET).not.toContain('chat');
        expect(HOME_CHAT_KINDS).toEqual(['dm', 'group', 'event', 'enterprise']);
    });

    it('three chats are taken, each its own instance with its chat; a fourth is refused and the layout unchanged', () => {
        let l: HomeLayoutV2 = layout([one('steps')]);
        const ids: string[] = [];
        for (const kind of ['dm', 'group', 'event'] as const) {
            const r = addCard(l, 'chat', { settings: { ...picked, conversationId: `conv-${kind}`, kind }, now: NOW });
            expect(r.ok, kind).toBe(true);
            if (!r.ok) return;
            expect(r.id).toMatch(/^chat-[a-z2-7]{4}$/);
            expect(r.layout.cards[0]).toEqual({ id: r.id, type: 'chat', settings: { conversationId: `conv-${kind}`, kind, name: 'Ana Reyes' } });
            ids.push(r.id);
            l = r.layout;
        }
        expect(new Set(ids).size).toBe(3);
        expect(addCard(l, 'chat', { settings: { ...picked, conversationId: 'conv-four' } })).toEqual({ ok: false, refused: 'type-full' });
        expect(l.cards.filter(c => c.type === 'chat')).toHaveLength(3);
        // A stored layout holding four (a newer app's, or a write by hand) is still read whole: the frame never drops a card.
        const four = layout([...l.cards, chatCard('chat-zzzz', { ...picked, conversationId: 'conv-four' })]);
        expect(readHomeLayout(four)?.cards.filter(c => c.type === 'chat')).toHaveLength(4);
    });

    it('reads its settings tolerantly: garbage is no chat picked ({}), a name is cut to 60, unknown keys go', () => {
        expect(readChatSettings(picked)).toEqual(picked);
        expect(readChatSettings({ ...picked, name: `  ${'n'.repeat(70)}  `, extra: 'x' })).toEqual({ ...picked, name: 'n'.repeat(HOME_CHAT_NAME_CHARS) });
        // A name counted in characters, never cut through one.
        expect(readChatSettings({ ...picked, name: '🙂'.repeat(61) })).toEqual({ ...picked, name: '🙂'.repeat(60) });
        expect(readChatSettings({ ...picked, name: 7 })).toEqual({ ...picked, name: '' });
        expect(readChatSettings({ conversationId: 'c'.repeat(HOME_CHAT_ID_CHARS), kind: 'enterprise' })).toEqual({ conversationId: 'c'.repeat(64), kind: 'enterprise', name: '' });
        const garbage: unknown[] = [
            undefined, null, 'conv-ana-1', 7, [], [picked], {},
            { ...picked, conversationId: '' }, { ...picked, conversationId: 'c'.repeat(HOME_CHAT_ID_CHARS + 1) }, { ...picked, conversationId: 42 },
            { ...picked, conversationId: { id: 'x' } }, { ...picked, kind: 'thread' }, { ...picked, kind: 'DM' }, { conversationId: 'conv-ana-1' },
        ];
        for (const raw of garbage) expect(readChatSettings(raw), JSON.stringify(raw)).toEqual({});
        // Added with garbage, the card is there with nothing picked: the apps say "Pick a chat".
        const added = addCard(layout([]), 'chat', { settings: { conversationId: 99, kind: 'dm' }, now: NOW });
        expect(added.ok && added.layout.cards[0].settings).toEqual({});
    });

    it('cardsToAsk asks a chat once it is picked, in catalogue order; never one with nothing picked, nor one not on Home', () => {
        const a = chatCard('chat-bbbb', picked);
        const b = chatCard('chat-aaaa', { ...picked, conversationId: 'grp-1', kind: 'group' });
        const none = chatCard('chat-cccc', {});
        const junk = chatCard('chat-dddd', { conversationId: 'x'.repeat(65), kind: 'dm' });
        const withChats = layout([one('beans'), a, none, one('groups'), junk, b, one('market')]);
        expect(cardsToAsk(withChats)).toEqual(['needs', 'market', 'groups', 'chat-aaaa', 'chat-bbbb', 'beans', 'community']);
        // The same set in another order is the same ask.
        expect(cardsToAsk(layout([b, one('market'), junk, a, one('groups'), none, one('beans')]))).toEqual(cardsToAsk(withChats));
        // A Home without a chat card asks no chat, and asks what it asked before the type existed.
        const without = layout([one('beans'), one('groups'), one('market')]);
        expect(cardsToAsk(without)).toEqual(['needs', 'market', 'groups', 'beans', 'community']);
        expect(cardsToAsk(without).some(id => id.startsWith('chat'))).toBe(false);
        // Another instance type is untouched by the rule: a saved search with no words is asked as before.
        expect(cardsToAsk(layout([{ id: 'search-k7mq', type: 'search', settings: {} }]))).toContain('search-k7mq');
    });

    it('its name and line fit the 320 model, and say nothing locked, earned or tiered', () => {
        const chat = HOME_CARD_TYPES.find(t => t.id === 'chat')!;
        for (const text of [chat.name, chat.line]) {
            for (const w of text.split(/\s+/).filter(Boolean)) expect(wordDp(w), w).toBeLessThanOrEqual(140);
            expect(text).not.toMatch(/lock|earn|tier|level|Ʀ/i);
            expect(t(text)).toBe(text);
        }
    });
});
