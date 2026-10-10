import { describe, expect, it } from 'vitest';
import {
    HOME_CARD_TYPES, HOME_FRAME_LIMITS, HOME_NEWCOMER_FIVE, addCard, cardsToAsk, checkHomeLayout, defaultCards, moveCard,
    readHomeLayout, readSearchSettings, removeCard, translateV1, type HomeLayoutV2, type HomeNodeFacts,
} from '../home-frame.js';

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
        expect(cardsToAsk(null)).toEqual(['needs', 'safety', 'steps', 'events', 'market', 'notices', 'community']);
    });
});

/** The 320 dp model's width of a word at 15 pt × 1.3, bold (apps/native home-layout-320.test.ts uses the same 0.6 em average). */
const wordDp = (word: string) => word.length * 15 * 1.3 * 0.6;

describe('home frame §5.2 (4): the default and the words', () => {
    it("defaultCards is the newcomer's five on both profiles, with the two that manage themselves", () => {
        expect(HOME_NEWCOMER_FIVE).toEqual(['steps', 'tips', 'market', 'events', 'notices']);
        for (const p of ['local', 'global'] as const) {
            expect(defaultCards(p).map(c => c.id)).toEqual(['safety', 'steps', 'tips', 'interests', 'market', 'events', 'notices']);
            expect(defaultCards(p).filter(c => HOME_NEWCOMER_FIVE.includes(c.type))).toHaveLength(5);
        }
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
        expect(on(global)).toEqual(['needs', 'safety', 'find', 'steps', 'tips', 'interests', 'events', 'market', 'search', 'groups', 'joined', 'pulse', 'sky', 'notices', 'community']);
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
});
