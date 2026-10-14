import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    HOME_TIPS, allTipsSeen, dismissTips, emptyTipsRecord, localDay, nextTip, readTipsRecord, restartTips, tipNow,
    tipOnLanding, tipsCaption, tipsFor, tipsNextLabel, type TipsNode, type TipsRecord,
} from '../home-tips.js';

const LOCAL: TipsNode = { profile: 'local', features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true } };
const ADMINS_ONLY: TipsNode = { profile: 'local', features: { ...LOCAL.features, door: 'admins' } };
const NO_DECISIONS: TipsNode = { profile: 'local', features: { ...LOCAL.features, decisions: false } };
const GLOBAL: TipsNode = { profile: 'global', features: { beans: false, escrow: false, enterprises: false, invites: false, decisions: false, wordsDoor: true } };
const PREVIEW: TipsNode = { profile: 'global', features: { ...GLOBAL.features, privatePreview: true, invites: true, door: 'admins' } };

const ids = (node: TipsNode, role: Parameters<typeof tipsFor>[1] = null) => tipsFor(node, role).map(t => t.id);

const LOCAL_SEQ = ['what-this-is', 'offer', 'beans', 'price', 'words', 'map', 'messages', 'deal', 'credit', 'levels', 'invites', 'groups', 'votes', 'private', 'guide'];
const GLOBAL_SEQ = ['what-this-is', 'offer-global', 'no-beans', 'words', 'map', 'messages', 'find-community', 'groups', 'polls', 'visitors', 'guide'];

describe('home tips: which tips each node shows (design §3)', () => {
    it('a local community with everything on: the 15, in order', () => {
        expect(ids(LOCAL)).toEqual(LOCAL_SEQ);
    });

    it('a local community where only admins invite: a plain member gets no invite tip, an admin does', () => {
        expect(ids(ADMINS_ONLY)).toEqual(LOCAL_SEQ.filter(id => id !== 'invites'));
        expect(ids(ADMINS_ONLY, undefined)).toEqual(LOCAL_SEQ.filter(id => id !== 'invites'));
        expect(ids(ADMINS_ONLY, 'moderator')).toEqual(LOCAL_SEQ.filter(id => id !== 'invites'));
        expect(ids(ADMINS_ONLY, 'admin')).toEqual(LOCAL_SEQ);
        expect(ids(ADMINS_ONLY, 'owner')).toEqual(LOCAL_SEQ);
    });

    it('a local community with Decisions off: Polls in place of Commons', () => {
        expect(ids(NO_DECISIONS)).toEqual(LOCAL_SEQ.map(id => (id === 'votes' ? 'polls' : id)));
    });

    it('the worldwide community: the 11, in order', () => {
        expect(ids(GLOBAL)).toEqual(GLOBAL_SEQ);
    });

    it('the worldwide community in a private preview: the same 11, even for its admins', () => {
        expect(ids(PREVIEW)).toEqual(GLOBAL_SEQ);
        expect(ids(PREVIEW, 'owner')).toEqual(GLOBAL_SEQ);
    });

    it('escrow off drops only the deal tip; invites off drops only the invite tip', () => {
        expect(ids({ profile: 'local', features: { ...LOCAL.features, escrow: false } })).toEqual(LOCAL_SEQ.filter(id => id !== 'deal'));
        expect(ids({ profile: 'local', features: { ...LOCAL.features, invites: false } })).toEqual(LOCAL_SEQ.filter(id => id !== 'invites'));
    });

    it('a node older than the app (no features said): unknown counts as on, as cardOnNode reads it; invites need a yes', () => {
        expect(ids({ profile: 'local', features: {} })).toEqual(LOCAL_SEQ.filter(id => id !== 'invites'));
    });
});

describe('home tips: the wording (approved 8 Oct 2026, word for word)', () => {
    const guide = JSON.parse(readFileSync(fileURLToPath(new URL('../../../beanpool-guide/generated/guide.json', import.meta.url)), 'utf8'));
    const slugs = new Set<string>(guide.sections.flatMap((s: { slugs: string[] }) => s.slugs));

    it('every Read more names a page in the bundled guide', () => {
        expect(slugs.size).toBeGreaterThan(10);
        for (const t of HOME_TIPS) expect(slugs.has(t.guide!), `${t.id} → ${t.guide}`).toBe(true);
    });

    it('every tip is one or two sentences and at most 180 characters', () => {
        for (const t of HOME_TIPS) {
            expect(t.text.length, t.id).toBeLessThanOrEqual(180);
            const sentences = t.text.split(/(?<=[.?!])\s+/).filter(Boolean);
            expect(sentences.length, t.id).toBeGreaterThanOrEqual(1);
            expect(sentences.length, t.id).toBeLessThanOrEqual(2);
            expect(t.text, t.id).toMatch(/[.?!]$/);
        }
    });

    it('nothing is worded as locked or earned access, no tiers, no Ʀ, and Beans is capitalised', () => {
        for (const t of HOME_TIPS) {
            // "locked end to end" is the one use of the word: a chat's encryption, never access (design §3, tip 7).
            const text = t.id === 'messages' ? t.text.replace(/locked end to end|are not locked/g, '') : t.text;
            expect(text, t.id).not.toMatch(/lock|\bearn|tier|Ʀ/i);
            expect(t.text, t.id).not.toMatch(/\bbeans\b/);
        }
    });

    it('ids are unique, and are the design\'s ids (a record of seen tips must never reset)', () => {
        const all = HOME_TIPS.map(t => t.id);
        expect(new Set(all).size).toBe(all.length);
        expect(all).toEqual([
            'what-this-is', 'offer', 'offer-global', 'beans', 'no-beans', 'price', 'words', 'map', 'messages', 'deal', 'credit',
            'levels', 'find-community', 'invites', 'groups', 'votes', 'polls', 'private', 'visitors', 'guide',
        ]);
    });

    it('a sample of the approved wording, character for character', () => {
        const text = (id: string) => HOME_TIPS.find(t => t.id === id)!.text;
        expect(text('what-this-is')).toBe('BeanPool is neighbours helping neighbours. You offer what you can do or spare, and ask for what you need.');
        expect(text('words')).toBe('Your 12 words are the key to your account, and there is no password. Write them on paper and keep it safe: nobody can reset them for you.');
        expect(text('guide')).toBe("That's the last tip. The whole guide is in Settings under Help & how it works, and it works with no connection; Edit home, at the bottom, arranges your cards.");
    });

    it('the caption and the button labels', () => {
        expect(tipsCaption({ position: 3, total: 15 })).toBe('Tips · 3 of 15');
        expect(tipsNextLabel({ last: false })).toBe('Next tip');
        expect(tipsNextLabel({ last: true })).toBe('Done with tips. The card goes.');
    });
});

describe('home tips: rotation and stopping (design §1)', () => {
    const list = tipsFor(LOCAL, null);
    const D1 = '2026-10-09';
    const D2 = '2026-10-10';

    it('a first landing draws the first tip, 1 of 15, and remembers the day', () => {
        const s = tipOnLanding(emptyTipsRecord(), list, D1);
        expect(s.view).toMatchObject({ position: 1, total: 15, last: false });
        expect(s.view!.tip.id).toBe('what-this-is');
        expect(s.record).toMatchObject({ seen: [], current: 'what-this-is', currentShownOn: D1 });
    });

    it('Next marks the tip seen and draws the next one, shown today', () => {
        const first = tipOnLanding(emptyTipsRecord(), list, D1);
        const s = nextTip(first.record, list, D1);
        expect(s.record.seen).toEqual(['what-this-is']);
        expect(s.view!.tip.id).toBe('offer');
        expect(s.view!.position).toBe(2);
        expect(s.record).toMatchObject({ current: 'offer', currentShownOn: D1 });
    });

    it('a new local day advances once on landing, and not twice on the same day', () => {
        const first = tipOnLanding(emptyTipsRecord(), list, D1).record;
        const sameDay = tipOnLanding(first, list, D1);
        expect(sameDay.record).toBe(first);
        expect(sameDay.view!.tip.id).toBe('what-this-is');
        const nextDay = tipOnLanding(first, list, D2);
        expect(nextDay.view!.tip.id).toBe('offer');
        expect(nextDay.record).toMatchObject({ seen: ['what-this-is'], current: 'offer', currentShownOn: D2 });
        const again = tipOnLanding(nextDay.record, list, D2);
        expect(again.record).toBe(nextDay.record);
        expect(again.view!.tip.id).toBe('offer');
    });

    it('a redraw while Home is in front never advances, whatever the day', () => {
        const first = tipOnLanding(emptyTipsRecord(), list, D1).record;
        expect(tipNow(first, list, D2).view!.tip.id).toBe('what-this-is');
    });

    it('the last tip reads Done, and Done ends the card: none when all are seen', () => {
        let r: TipsRecord = emptyTipsRecord();
        let s = tipOnLanding(r, list, D1);
        for (let i = 1; i < list.length; i++) {
            expect(s.view!.last).toBe(false);
            s = nextTip(s.record, list, D1);
        }
        expect(s.view).toMatchObject({ position: 15, total: 15, last: true });
        expect(s.view!.tip.id).toBe('guide');
        r = nextTip(s.record, list, D1).record;
        expect(nextTip(s.record, list, D1).view).toBeNull();
        expect(allTipsSeen(r, list)).toBe(true);
        expect(r).toMatchObject({ current: null, currentShownOn: null });
        expect(tipOnLanding(r, list, D2).view).toBeNull();
    });

    it('Don\'t show tips again: no card, on any day, until the tips start over', () => {
        const r = dismissTips(tipOnLanding(emptyTipsRecord(), list, D1).record, '2026-10-09T10:00:00.000Z');
        expect(tipOnLanding(r, list, D1).view).toBeNull();
        expect(tipOnLanding(r, list, D2).view).toBeNull();
        expect(nextTip(r, list, D2).view).toBeNull();
        expect(allTipsSeen(r, list)).toBe(false);
        const again = tipOnLanding(restartTips(list, D2), list, D2);
        expect(again.view!.tip.id).toBe('what-this-is');
        expect(again.view!.position).toBe(1);
    });

    it('starts over after a Show: all seen, then switched on in Edit home', () => {
        const allSeen: TipsRecord = { ...emptyTipsRecord(), seen: list.map(t => t.id) };
        expect(tipOnLanding(allSeen, list, D1).view).toBeNull();
        expect(tipOnLanding(restartTips(list, D1), list, D1).view!.tip.id).toBe('what-this-is');
    });

    it('a restart keeps tip 1 as the one on the card from that day: the next day moves on from it (PR #1694 review 6)', () => {
        const r = restartTips(list, D1);
        expect(r).toEqual({ v: 1, seen: [], current: 'what-this-is', currentShownOn: D1, dismissedAt: null });
        expect(tipOnLanding(r, list, D1).record).toBe(r);
        expect(tipOnLanding(r, list, D2).view!.tip.id).toBe('offer');
        // A list with nothing in it (no answer in hand): an empty record, no card.
        expect(restartTips([], D1)).toEqual(emptyTipsRecord());
    });

    it('ignores a seen id the current list no longer has, and moves a member on from global to local without repeats', () => {
        const global = tipsFor(GLOBAL, null);
        let s = tipOnLanding(emptyTipsRecord(), global, D1);
        while (s.view) s = nextTip(s.record, global, D1);
        expect(allTipsSeen(s.record, global)).toBe(true);
        // Joined a local community: only the tips not seen there yet, the count is the local list's.
        const local = tipOnLanding(s.record, list, D2);
        expect(local.view!.tip.id).toBe('offer');
        expect(local.view).toMatchObject({ position: 2, total: 15 });
        const rest: string[] = [];
        let t = local;
        while (t.view) { rest.push(t.view.tip.id); t = nextTip(t.record, list, D2); }
        expect(rest).toEqual(['offer', 'beans', 'price', 'deal', 'credit', 'levels', 'invites', 'votes', 'private']);
        expect(allTipsSeen(t.record, list)).toBe(true);
    });

    it('a tip on the card that this node no longer shows is replaced, without marking it seen', () => {
        const r: TipsRecord = { ...emptyTipsRecord(), current: 'invites', currentShownOn: D1 };
        const s = tipOnLanding(r, tipsFor(ADMINS_ONLY, null), D2);
        expect(s.view!.tip.id).toBe('what-this-is');
        expect(s.record.seen).toEqual([]);
    });

    it('reads a stored record tolerantly', () => {
        expect(readTipsRecord(null)).toEqual(emptyTipsRecord());
        expect(readTipsRecord('x')).toEqual(emptyTipsRecord());
        expect(readTipsRecord([1])).toEqual(emptyTipsRecord());
        expect(readTipsRecord({ v: 1, seen: ['a', 'a', 3, '', 'b'], current: 'c', currentShownOn: '2026-10-09', dismissedAt: null }))
            .toEqual({ v: 1, seen: ['a', 'b'], current: 'c', currentShownOn: '2026-10-09', dismissedAt: null });
        expect(readTipsRecord({ seen: 'x', current: 4, currentShownOn: 'yesterday', dismissedAt: 7 })).toEqual(emptyTipsRecord());
        expect(readTipsRecord({ current: 'c', currentShownOn: 'nope' })).toMatchObject({ current: 'c', currentShownOn: null });
    });

    it('localDay is the device\'s calendar day', () => {
        expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
        expect(localDay(new Date(2026, 9, 9, 0, 1))).toBe('2026-10-09');
    });
});
