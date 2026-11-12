// @vitest-environment jsdom
/**
 * The credit screens rendered for real against a fake node (slice C4; DESIGN-credit-list-fable.md §8 tests 6, 10, 11, 12, 14, 18
 * to 21 and 23, with the amendments). React Native's host components are DOM with their styles (credit-rn-dom.ts); the
 * node's routes are a table in `world`, so what the phone SENT (the bodies, the order of reads) is recorded and what it
 * DREW comes from the node's answers alone. Nothing here contacts a node.
 *
 * With CREDIT_SHOTS_DIR set, the same renders are written there as HTML for the director's screenshots: the list (Rob, Jane at
 * −420, a frozen row, Sam after the gift, a −437.13 row), the sheet, the profile card, Jane's voucher row and Ask for more, at
 * 320 dp with 130% text, in the Light, Classic and Dark colour sets. Without it they are not written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { act, createElement, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { offersNamesList as coreOffersNamesList, type RiskReason } from '@beanpool/core';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const look = vi.hoisted(() => ({ set: 'light' as 'light' | 'dark' | 'night' }));
vi.mock('react-native', async () => (await import('./credit-rn-dom')).reactNativeDom());
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
const nav = vi.hoisted(() => ({ pushed: [] as any[] }));
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    return { router: { push: (r: unknown) => { nav.pushed.push(r); }, setParams() {} }, useFocusEffect: (cb: () => void) => useEffect(() => { cb(); }, [cb]) };
});
vi.mock('../../app/ThemeContext', async () => {
    const { COLOUR_SETS } = await import('../../constants/colors');
    const ctx = () => ({ theme: look.set === 'light' ? 'light' : 'dark', set: look.set, colors: COLOUR_SETS[look.set] });
    return { useTheme: ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx()) };
});
vi.mock('../../components/MemberAvatar', async () => {
    const { createElement: h } = await import('react');
    return { MemberAvatar: ({ callsign, size }: { callsign: string; size: number }) => h('div', { style: { width: size, height: size, borderRadius: size / 2, background: '#9aa59a', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, flexShrink: 0 } }, callsign.slice(0, 1).toUpperCase()) };
});

// ── The fake node ────────────────────────────────────────────────────────────────────────────────────────────────────
const KEY = (c: string) => c.repeat(64);
const ROB = KEY('1'), JANE = KEY('2'), FAY = KEY('3'), SAM = KEY('4'), ZED = KEY('5'), MEL = KEY('6'), ME = KEY('9');
const risk = (level: string, reasons: RiskReason[] = [], more = false) => ({ level, reasons, more }) as any;
const overHalfGift: RiskReason = { code: 'over_half', level: 'medium', mark: 'giver', values: { owed: 90000, line: 100000, pct: 50, gift: 90000, giftDays: 30 } };
const person = (o: Record<string, unknown>) => ({
    status: 'active', own: false, line_c: 0, usable_c: 0, liveOffers: 0, balance_c: 0, owed_c: 0, over_c: 0, paused: false, canGive: true, risk: risk('not_known'),
    parts: { known_c: 0, room_c: 0, earned_c: 0, granted_c: 0, cap_c: 200000 }, standsBehind: { confirmedBy: null, vouchedBy: [] }, frozen: { credit: false, known: false }, ...o,
}) as any;

const world = vi.hoisted(() => ({
    sight: 'owner' as 'owner' | 'admin' | 'voucher',
    people: [] as any[],
    pageStatus: 200 as number | 'offline',
    chip: { status: 200, rows: [] as any[] },
    mine: { voucher: true, noLimit: false, budget: { left: 15000, held: 0, heldInvites: 0, vouched: 85000, peopleVouched: 4, level: 100000 }, presets: [2500, 5000, 7500, 10000], vouchMax: 10000, budgetMax: 200000, vouchedBy: [], ask: { askedAt: null, lastAskedAt: null, askAgainAt: null, blocked: null } } as any,
    role: null as null | { role: string | null },
    vouchRefusal: null as null | { status: number; error: string; code: string },
    log: [] as string[],
    posts: [] as { path: string; body: any }[],
    topUps: [] as any[],
    /** The community's known-rule answer: false = a Beans node that doesn't confirm its members (an answer with no floor in it). */
    known: true,
    /** How many people a page of the fake node holds (0 = all of them on one page); the cursor is the offset. */
    pageSize: 0,
}));
const forSight = (p: any) => {
    if (world.sight !== 'voucher') return p;
    const { parts: _p, standsBehind: _s, frozen: _f, voucherBudget: _v, ...rest } = p;
    return rest;
};
const reply = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });
vi.mock('../node-post', () => ({
    signedGet: async (_u: string, p: string) => {
        world.log.push(`GET ${p}`);
        if (world.pageStatus === 'offline' && p.startsWith('/api/credit/people?')) throw new Error('offline');
        if (p === '/api/vouchers/me') return reply(200, world.mine);
        if (p === '/api/credit/people?filter=vouchers') {
            return world.chip.status === 200 ? reply(200, { sight: world.sight, filter: 'vouchers', vouchers: world.chip.rows, next: null }) : reply(403, { error: 'Only an owner or an admin on the credit committee makes vouchers and sets their budgets.', code: 'committee_only' });
        }
        if (p.startsWith('/api/credit/people?')) {
            if (world.pageStatus === 403) return reply(403, { error: 'Only the owners, admins and vouchers here can see credit.', code: 'not_a_giver' });
            const filter = /filter=(\w+)/.exec(p)?.[1];
            const list = filter === 'no_credit' ? world.people.filter((x) => x.line_c === 0) : filter === 'has_offers' ? world.people.filter((x) => x.line_c === 0 && x.liveOffers > 0) : world.people;
            const after = /[?&]after=([^&]+)/.exec(p)?.[1];
            const start = after ? Number(decodeURIComponent(after)) : 0;
            const size = world.pageSize || list.length;
            return reply(200, { sight: world.sight, told: 'x', people: list.slice(start, start + size).map(forSight), next: start + size < list.length ? String(start + size) : null });
        }
        const one = /^\/api\/credit\/people\/([0-9a-f]{64})$/.exec(p);
        if (one) {
            const found = world.people.find((x) => x.memberPubkey === one[1]);
            return found ? reply(200, { sight: world.sight, told: 'x', person: forSight(found) }) : reply(404, { error: 'Nobody here by that key.', code: 'not_listed' });
        }
        return reply(404, {});
    },
    signedPost: async (_u: string, p: string, body: any) => {
        world.log.push(`POST ${p}`);
        world.posts.push({ path: p, body });
        if (p === '/api/vouch') {
            if (world.vouchRefusal) return reply(world.vouchRefusal.status, { error: world.vouchRefusal.error, code: world.vouchRefusal.code });
            const target = world.people.find((x) => x.memberPubkey === body.memberPubkey);
            target.line_c += body.vouchAmount; target.usable_c += body.vouchAmount; target.youVouched_c = (target.youVouched_c ?? 0) + body.vouchAmount;
            return reply(200, { id: 'v1', memberPubkey: body.memberPubkey, amount: body.vouchAmount, total: target.youVouched_c, budget: {} });
        }
        if (p === '/api/credit/known-floor') {
            const target = world.people.find((x) => x.memberPubkey === body.memberPubkey);
            const was = target.parts.known_c; target.parts.known_c = body.raiseTo_c; target.line_c += body.raiseTo_c - was; target.usable_c = target.line_c;
            return reply(200, { memberPubkey: body.memberPubkey, was_c: was, knownFloor_c: body.raiseTo_c });
        }
        if (p === '/api/vouchers/ask') {
            const askedAt = '2026-11-12T12:00:00.000Z', askAgainAt = '2026-11-19T12:00:00.000Z';
            world.mine.ask = { askedAt, lastAskedAt: askedAt, askAgainAt, blocked: null };
            return reply(200, { askedAt, askAgainAt });
        }
        return reply(404, {});
    },
}));
vi.mock('../names-list', () => ({
    offersNamesList: (role: string | null | undefined, profile: any) => (role === 'owner' || role === 'admin') && profile !== 'global',
    setVoucherBudget: async (a: string, i: unknown, member: string, level: number) => {
        world.topUps.push({ member, level });
        const row = world.chip.rows.find((r: any) => r.memberPubkey === member);
        row.left = level - row.held; row.level = level; row.setLevel_c = level; row.runningLow = false; row.askedAt = null; row.topUpTo_c = null; row.topUpBlocked = 'at_most';
        return { ok: true, value: { level, left: row.left } };
    },
}));
vi.mock('../node-admin', () => ({ askNodeRole: async () => world.role }));
// The node's answer as core's readKnownRule gives it: a community that confirms carries its floor; a Beans node that does
// not still answers (only `creditSight`), so "an answer" must not be read as "confirms".
vi.mock('../known-rule', () => ({
    fetchKnownRule: async () => (world.known
        ? { knownFloor: 100000, debtLinePct: 50, quietDays: 60, debtLineFrom: null, quietDaysFrom: null, creditSight: true }
        : { debtLineFrom: null, quietDaysFrom: null, creditSight: true }),
}));

import { CreditList } from '../../components/CreditList';
import { CreditCard } from '../../components/CreditCard';
import { AskForMore } from '../../components/AskForMore';
import { useCreditGiver } from '../use-credit-giver';
import { WINDOW, FONT_SCALE } from './credit-rn-dom';
import { COLOUR_SETS } from '../../constants/colors';

const id = { publicKey: ME, privateKey: KEY('e'), callsign: 'Me' } as any;
let host: HTMLElement, root: Root;
// Real milliseconds, not turns: the screens ask the (mocked) node through dynamic imports, which settle on the event loop.
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };
const byId = (t: string) => host.querySelector(`[data-testid="${t}"]`) as HTMLElement | null;
const press = async (el: Element | null) => { if (!el) throw new Error('nothing to press'); await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); await flush(); };
const text = () => host.textContent ?? '';
const refused = vi.fn();
/** A component rendered with props the test names (the screens' own prop types are not the point here). */
const el = (component: unknown, props: Record<string, unknown>) => createElement(component as ComponentType<Record<string, unknown>>, props);
const mount = async (node: any) => { await act(async () => { root.render(node); }); await flush(); };
const list = (extra: Record<string, unknown> = {}) => el(CreditList, { anchorUrl: 'https://n.test', identity: id, query: '', nodeProfile: 'local', onOpenProfile() {}, onRefused: refused, ...extra });

const seed = () => {
    world.sight = 'owner'; world.pageStatus = 200; world.role = null; world.vouchRefusal = null; world.known = true; world.pageSize = 0;
    world.log.length = 0; world.posts.length = 0; world.topUps.length = 0; nav.pushed.length = 0; refused.mockClear();
    world.chip = { status: 403, rows: [] };
    world.mine.voucher = true; world.mine.noLimit = false; world.mine.ask = { askedAt: null, lastAskedAt: null, askAgainAt: null, blocked: null };
    world.mine.budget = { left: 15000, held: 0, heldInvites: 0, vouched: 85000, peopleVouched: 4, level: 100000 };
    world.people = [
        person({ memberPubkey: ROB, callsign: 'Rob', liveOffers: 4, risk: risk('not_known', [{ code: 'new', level: 'not_known', mark: 'open', values: {} }]) }),
        person({ memberPubkey: FAY, callsign: 'Fay', canGive: false, line_c: 100000, usable_c: 100000, liveOffers: 1, frozen: { credit: true, known: false }, risk: risk('high', [{ code: 'frozen', level: 'high', mark: 'admins', values: {} }]) }),
        person({ memberPubkey: JANE, callsign: 'Jane', line_c: 130000, usable_c: 130000, liveOffers: 1, balance_c: -42000, owed_c: 42000, risk: risk('low', [{ code: 'confirmed', level: 'low', mark: 'admins', values: {} }]), parts: { known_c: 100000, room_c: 20000, earned_c: 10000, granted_c: 0, cap_c: 200000 }, standsBehind: { confirmedBy: { memberPubkey: KEY('c'), callsign: 'marty', at: '2026-11-01T00:00:00Z' }, vouchedBy: [{ memberPubkey: KEY('d'), callsign: 'olive', amount_c: 10000 }] } }),
        person({ memberPubkey: SAM, callsign: 'Sam', line_c: 100000, usable_c: 100000, liveOffers: 1, balance_c: 0, risk: risk('high', [overHalfGift], true) }),
        person({ memberPubkey: ZED, callsign: 'Zed', line_c: 130000, usable_c: 130000, liveOffers: 2, balance_c: -43713, owed_c: 43713, risk: risk('low') }),
        person({ memberPubkey: MEL, callsign: 'Mel', balance_c: -100, owed_c: 100, liveOffers: 0 }),
    ];
};

beforeEach(() => {
    look.set = 'light'; FONT_SCALE.value = 1.3; WINDOW.height = 569;
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); seed();
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe('Show credit, the list (tests 6, 10, 14)', () => {
    it('an owner reads each row in core\'s sentences, in the node\'s order, with the chips the node allows', async () => {
        await mount(list());
        const rows = ['Rob', 'Fay', 'Jane', 'Sam', 'Zed'].map((n) => byId(`credit-row-${n}`)!.textContent!);
        expect(rows[0]).toContain('No credit yet · 4 live Offers');
        expect(rows[0]).toContain('Balance 0');
        expect(rows[0]).toContain('○ Credit risk: not known yet');
        expect(rows[1]).toContain('Credit line frozen by an admin');
        expect(rows[2]).toContain('Credit line 1,300 · can use all of it now');
        expect(rows[2]).toContain('Balance −420 · using 420 of 1,300');
        expect(rows[2]).toContain('✓ Credit risk: low');
        expect(rows[4]).toContain('Balance −437.13 · using 437.13 of 1,300');
        expect(text()).toContain('Only people who can give credit see this. Each look is recorded.');
        expect(['credit-chip-all', 'credit-chip-no_credit', 'credit-chip-has_offers', 'credit-chip-mine'].every((c) => !!byId(c))).toBe(true);
        expect(byId('credit-chip-vouchers')).toBeNull();
        expect(text()).not.toMatch(/…|\.\.\./);
    });
    it('the Vouchers chip is drawn only when the NODE answers it; a 403 is its no', async () => {
        world.chip = { status: 200, rows: [] };
        await mount(list());
        expect(byId('credit-chip-vouchers')).not.toBeNull();
        world.chip = { status: 403, rows: [] };
        await act(async () => { root.unmount(); });
        root = createRoot(host);
        await mount(list());
        expect(byId('credit-chip-vouchers')).toBeNull();
    });
    it('a frozen row and a row the viewer may not give to have no Give credit button; the rest do', async () => {
        await mount(list());
        expect(byId('credit-row-Fay')!.querySelector('[data-testid="credit-give"]')).toBeNull();
        expect(byId('credit-row-Rob')!.querySelector('[data-testid="credit-give"]')).not.toBeNull();
    });
    it('a voucher is not shown the parts, who stands behind them, or the admins\' reasons: the node left them out', async () => {
        world.sight = 'voucher';
        await mount(list());
        const jane = byId('credit-row-Jane')!.textContent!;
        expect(jane).toContain('Balance −420');
        expect(text()).not.toMatch(/Made of|known floor|Confirmed by|frozen by an admin/);
    });
    it('offline: "Connect to your community to see credit lines."; a 403 not_a_giver hands the view back', async () => {
        world.pageStatus = 'offline';
        await mount(list());
        expect(text()).toContain('Connect to your community to see credit lines.');
        await act(async () => { root.unmount(); });
        root = createRoot(host);
        world.pageStatus = 403;
        await mount(list());
        expect(refused).toHaveBeenCalled();
        expect(text()).not.toContain('Credit line');
    });
    it('a plain member\'s phone asks for no credit answer (test 10): the giver check is the only thing it sends', async () => {
        world.role = { role: null };
        world.mine = { ...world.mine, voucher: false };
        let state = '';
        const Probe = () => { state = useCreditGiver('https://n.test', id, true, 1); return null; };
        await mount(createElement(Probe));
        expect(state).toBe('no');
        expect(world.log.filter((l) => /\/api\/credit\//.test(l))).toEqual([]);
        expect(world.log).toEqual(['GET /api/vouchers/me']);
    });
});

describe('the profile hands in the budget answer it already asks for (no second ask)', () => {
    const probe = (answer: { voucher: boolean } | null) => {
        const out = { state: '' };
        const Probe = () => { out.state = useCreditGiver('https://n.test', id, true, 1, answer); return null; };
        return { out, node: createElement(Probe) };
    };
    it('waits while it is not heard, asks nothing; then a voucher is a giver without GET /api/vouchers/me', async () => {
        world.role = { role: null };
        const waiting = probe(null);
        await mount(waiting.node);
        expect(waiting.out.state).toBe('checking');
        expect(world.log).toEqual([]);
        const heard = probe({ voucher: true });
        await act(async () => { root.unmount(); });
        root = createRoot(host);
        await mount(heard.node);
        expect(heard.out.state).toBe('giver');
        expect(world.log).toEqual([]);
    });
    it('a member who is no voucher and has no role is "no", and no credit answer is asked for', async () => {
        world.role = { role: null };
        const p = probe({ voucher: false });
        await mount(p.node);
        expect(p.out.state).toBe('no');
        expect(world.log).toEqual([]);
    });
});

describe('Give credit (test 11)', () => {
    it('vouch 100 for Rob: the body is exactly { memberPubkey, vouchAmount: 10000 }, and the row is READ AGAIN from the node after', async () => {
        await mount(list());
        await press(byId('credit-row-Rob')!.querySelector('[data-testid="credit-give"]'));
        expect(byId('give-credit-sheet')).not.toBeNull();
        expect(text()).toContain('Give @Rob credit');
        await press(byId('invite-vouch-100'));
        await press(byId('give-vouch-submit'));
        expect(world.posts).toEqual([{ path: '/api/vouch', body: { memberPubkey: ROB, vouchAmount: 10000 } }]);
        const posted = world.log.indexOf('POST /api/vouch');
        expect(world.log.slice(posted + 1)).toContain(`GET /api/credit/people/${ROB}`);
        expect(byId('give-done')!.textContent).toBe('Vouched 100 Beans for @Rob.');
        expect(byId('give-line')!.textContent).toBe('Their credit line is now 100.');
        expect(byId('credit-row-Rob')!.textContent).toContain('Credit line 100 · can use all of it now');
    });
    it('a refusal shows the node\'s sentence and changes nothing; "not enough budget" offers Ask for more under it', async () => {
        world.vouchRefusal = { status: 409, error: 'You have 150 Beans of budget left, so you can’t vouch 100.', code: 'not_enough' };
        await mount(list());
        await press(byId('credit-row-Rob')!.querySelector('[data-testid="credit-give"]'));
        await press(byId('invite-vouch-100'));
        await press(byId('give-vouch-submit'));
        expect(byId('give-refusal')!.textContent).toBe('You have 150 Beans of budget left, so you can’t vouch 100.');
        expect(byId('ask-for-more')).not.toBeNull();
        expect(byId('credit-row-Rob')!.textContent).toContain('No credit yet · 4 live Offers');
        expect(world.log.filter((l) => l.includes(`GET /api/credit/people/${ROB}`)).length).toBe(1);
    });
    it('Next › opens the next person who can be given credit', async () => {
        await mount(list());
        await press(byId('credit-row-Rob')!.querySelector('[data-testid="credit-give"]'));
        await press(byId('invite-vouch-50'));
        await press(byId('give-vouch-submit'));
        await press(byId('give-next'));
        expect(text()).toContain('Give @Jane credit');
        expect(text()).not.toContain('Give @Fay credit');
    });
    it('Next › across a page boundary: the node is asked for the next page and the first person on it who can be given credit opens', async () => {
        world.pageSize = 2; // page 1: Rob, Fay (Fay cannot be given credit). page 2: Jane, Sam.
        await mount(list());
        expect(byId('credit-row-Jane')).toBeNull();
        await press(byId('credit-row-Rob')!.querySelector('[data-testid="credit-give"]'));
        await press(byId('invite-vouch-50'));
        await press(byId('give-vouch-submit'));
        expect(world.log.filter((l) => l.includes('after=')).length).toBe(0);
        await press(byId('give-next'));
        expect(world.log.filter((l) => l.includes('after=2')).length).toBe(1);
        expect(text()).toContain('Give @Jane credit');
        expect(text()).not.toContain('Give @Fay credit');
        expect(byId('credit-row-Sam')).not.toBeNull();
    });
    it('Next › at the last person with no page after it is not offered', async () => {
        world.pageSize = 2;
        await mount(list({ initialFilter: 'has_offers' }));
        // has_offers holds Rob alone (line 0 with a live Offer): one page, no next.
        await press(byId('credit-row-Rob')!.querySelector('[data-testid="credit-give"]'));
        await press(byId('invite-vouch-50'));
        await press(byId('give-vouch-submit'));
        expect(byId('give-next')).toBeNull();
    });
    it('below zero: the presets are greyed under the node\'s sentence, there is no submit, and no request is sent', async () => {
        await mount(list());
        await press(byId('credit-row-Mel')!.querySelector('[data-testid="credit-give"]'));
        expect(byId('give-greyed')!.textContent).toBe('@Mel is below zero: a credit-line gift or a Decision can help.');
        expect(byId('give-vouch-submit')).toBeNull();
        expect(world.posts).toEqual([]);
    });
    it('an owner raises a confirmed member\'s known floor: exactly { memberPubkey, raiseTo_c }, then reads the person again', async () => {
        await mount(list());
        await press(byId('credit-row-Jane')!.querySelector('[data-testid="credit-give"]'));
        expect(byId('give-floor-value')!.textContent).toBe('1,100');
        await press(host.querySelector('[aria-label="Raise the amount"]'));
        expect(byId('give-floor-value')!.textContent).toBe('1,200');
        await press(byId('give-floor-submit'));
        expect(world.posts).toEqual([{ path: '/api/credit/known-floor', body: { memberPubkey: JANE, raiseTo_c: 120000 } }]);
        expect(byId('give-done')!.textContent).toBe('Raised the known floor for @Jane to 1,200 Beans.');
    });
    it('Confirm goes to the names list\'s one-step form with the callsign (test 12, phone half); a confirmed member has no Confirm row', async () => {
        await mount(list());
        await press(byId('credit-row-Rob')!.querySelector('[data-testid="credit-give"]'));
        expect(byId('give-confirm-adds')!.textContent).toBe('Adds the known floor: 1,000 Beans');
        await press(byId('give-confirm')!.querySelector('[data-role="button"]'));
        expect(nav.pushed).toEqual([{ pathname: '/names-list', params: { act: 'add', forMember: ROB, forCallsign: 'Rob' } }]);
        nav.pushed.length = 0;
        await mount(list());
        await press(byId('credit-row-Jane')!.querySelector('[data-testid="credit-give"]'));
        expect(byId('give-confirm')).toBeNull();
    });
});

describe('a community that does not confirm its members', () => {
    it('shows neither known line: no Confirm and no Raise their known floor (the vouch is still there)', async () => {
        world.known = false;
        await mount(list());
        await press(byId('credit-row-Rob')!.querySelector('[data-testid="credit-give"]'));
        expect(byId('give-confirm')).toBeNull();
        expect(byId('give-floor')).toBeNull();
        expect(byId('give-vouch')).not.toBeNull();
        await act(async () => { root.unmount(); });
        root = createRoot(host);
        await mount(list());
        await press(byId('credit-row-Jane')!.querySelector('[data-testid="credit-give"]'));
        expect(byId('give-floor')).toBeNull();
    });
});

describe('vouchers\' budgets (tests 18, 19, 20)', () => {
    const jane = () => ({ memberPubkey: KEY('b'), callsign: 'Jane', left: 15000, held: 5000, heldInvites: 1, vouched: 80000, peopleVouched: 9, level: 100000, belowZero: 2, writtenOff: 0, setLevel_c: 100000, runningLow: true, nothingLeft: false, askedAt: '2026-11-12T12:00:00.000Z', topUpTo_c: 100000, topUpBlocked: null });
    it('Top up: the label and the level are the node\'s offer; one tap sends that level to the budget route; no picker', async () => {
        world.chip = { status: 200, rows: [jane()] };
        await mount(list({ initialFilter: 'vouchers', focusVoucher: KEY('b') }));
        const row = byId('credit-voucher-Jane')!;
        expect(row.textContent).toContain('Voucher · 150 of 1,000 left');
        expect(row.textContent).toContain('! Running low');
        expect(row.textContent).toContain('Asked for more on 12 Nov');
        expect(byId('credit-top-up')!.textContent).toBe('Top up to 1,000');
        await press(byId('credit-top-up'));
        expect(world.topUps).toEqual([{ member: KEY('b'), level: 100000 }]);
        expect(byId('credit-voucher-Jane')!.textContent).toContain('Jane’s budget is 1,000 now: 950 left to vouch with.');
        expect(byId('credit-top-up')).toBeNull();
    });
    it('a plain voucher sees their own budget above the chips with Ask for more; one tap sends an empty body and the button becomes the note', async () => {
        world.sight = 'voucher';
        await mount(list());
        expect(byId('credit-own-budget')!.textContent).toBe('Your budget: 150 of 1,000 left');
        await press(byId('ask-for-more-button'));
        expect(world.posts).toEqual([{ path: '/api/vouchers/ask', body: {} }]);
        expect(byId('ask-for-more-note')!.textContent).toBe('Asked on 12 Nov · an owner or the credit committee will see it.');
    });
    it('Ask for more: an owner has none; a frozen voucher reads why; a second ask inside the week reads the dates', async () => {
        world.mine = { ...world.mine, noLimit: true, ask: null };
        await mount(list());
        expect(byId('ask-for-more')).toBeNull();
        expect(byId('credit-own-budget')).toBeNull();
        await act(async () => { root.unmount(); });
        root = createRoot(host);
        await mount(el(AskForMore, { anchorUrl: 'https://n.test', identity: id, ask: { askedAt: null, lastAskedAt: null, askAgainAt: null, blocked: 'frozen' } }));
        expect(byId('ask-for-more-note')!.textContent).toBe('Your credit line is frozen, so your budget can’t be raised until an admin unfreezes it.');
        await act(async () => { root.unmount(); });
        root = createRoot(host);
        await mount(el(AskForMore, { anchorUrl: 'https://n.test', identity: id, ask: { askedAt: null, lastAskedAt: '2026-11-12T12:00:00.000Z', askAgainAt: '2026-11-19T12:00:00.000Z', blocked: null } }));
        expect(byId('ask-for-more-note')!.textContent).toBe('You asked on 12 Nov. You can ask again on 19 Nov.');
    });
});

describe('the profile card (test 14)', () => {
    it('an owner reads the line, the balance, what it is made of, who stands behind it and the reasons; nothing is stored', async () => {
        await mount(el(CreditCard, { anchorUrl: 'https://n.test', identity: id, memberPubkey: JANE }));
        expect(byId('credit-card-line')!.textContent).toBe('Credit line 1,300 · can use all of it now');
        expect(byId('credit-card-balance')!.textContent).toBe('Balance −420 · using 420 of 1,300');
        expect(byId('credit-card-made')!.textContent).toBe('Made of: known floor 1,000 · vouched 200 · earned 100');
        expect(text()).toContain('Confirmed by @marty');
        expect(text()).toContain('Vouched by @olive 100');
        expect(text()).toContain('✓ Credit risk: low');
        expect(world.log).toEqual([`GET /api/credit/people/${JANE}`]);
    });
    it('the viewer\'s own profile draws no card', async () => {
        world.people.push(person({ memberPubkey: ME, callsign: 'Me', own: true, canGive: false }));
        await mount(el(CreditCard, { anchorUrl: 'https://n.test', identity: id, memberPubkey: ME }));
        expect(byId('credit-card')).toBeNull();
    });
});

// ── Screenshots (only with CREDIT_SHOTS_DIR) ──────────────────────────────────────────────────────────────────────────
const SHOTS = process.env.CREDIT_SHOTS_DIR;
const page = (set: string, title: string, body: string, height: number) => {
    const c = (COLOUR_SETS as any)[set];
    return `<!doctype html><meta charset="utf-8"><title>${title}</title><style>html,body{margin:0;background:#888}*{font-family:Roboto,"Helvetica Neue",Arial,sans-serif}
.frame{position:relative;width:320px;height:${height}px;overflow:hidden;background:${c.surface.app};color:${c.text.body}}</style><div class="frame">${body}</div>`;
};
const shot = (name: string, set: string, height: number) => {
    fs.mkdirSync(SHOTS!, { recursive: true });
    fs.writeFileSync(path.join(SHOTS!, `${name}-${set}.html`), page(set, name, host.innerHTML, height));
};

describe.skipIf(!SHOTS)('screenshots: 320 dp, 130% text, Light, Classic and Dark', () => {
    const jane2 = () => ({ memberPubkey: KEY('b'), callsign: 'Jane', left: 15000, held: 5000, heldInvites: 1, vouched: 80000, peopleVouched: 9, level: 100000, belowZero: 2, writtenOff: 0, setLevel_c: 100000, runningLow: true, nothingLeft: false, askedAt: '2026-11-12T12:00:00.000Z', topUpTo_c: 100000, topUpBlocked: null });
    /** Mount `node` afresh (a new root), as a screen opened by itself. */
    const fresh = async (node: any) => { await act(async () => { root.unmount(); }); root = createRoot(host); await mount(node); };
    for (const set of ['light', 'dark', 'night'] as const) {
        it(`${set}: the list, the sheet, Sam after the gift, the card, the voucher row, Ask for more`, async () => {
            look.set = set; WINDOW.height = 900;
            // An owner: vouches with no limit, so no budget line above the chips.
            world.mine = { ...world.mine, noLimit: true, ask: null };
            await fresh(list());
            shot('01-list', set, 1450);
            await fresh(list());
            await press(byId('credit-row-Rob')!.querySelector('[data-testid="credit-give"]'));
            await press(host.querySelector('[data-role="button"][aria-label="Credit risk: not known yet"]'));
            shot('02-sheet-rob', set, 900);
            // Sam after the gift, as a voucher reads it: balance 0, high, the two-sentence reason, "An owner or admin can say more."
            world.sight = 'voucher';
            world.mine = { ...world.mine, noLimit: false, ask: { askedAt: null, lastAskedAt: null, askAgainAt: null, blocked: null } };
            await fresh(list());
            await press(byId('credit-row-Sam')!.querySelector('[data-testid="credit-give"]'));
            await press(host.querySelector('[data-role="button"][aria-label="Credit risk: high"]'));
            shot('03-sheet-sam-after-gift', set, 900);
            await fresh(el(CreditCard, { anchorUrl: 'https://n.test', identity: id, memberPubkey: SAM }));
            await press(host.querySelector('[data-role="button"]'));
            shot('04b-profile-card-sam-voucher', set, 560);
            world.sight = 'owner';
            await fresh(el(CreditCard, { anchorUrl: 'https://n.test', identity: id, memberPubkey: JANE }));
            await press(host.querySelector('[data-role="button"]'));
            shot('04-profile-card', set, 560);
            world.chip = { status: 200, rows: [jane2(), { ...jane2(), memberPubkey: KEY('7'), callsign: 'Olive', left: 90000, runningLow: false, askedAt: null, peopleVouched: 1, vouched: 10000, belowZero: 0, topUpTo_c: 150000 }, { ...jane2(), memberPubkey: KEY('8'), callsign: 'Kit', left: 2000, nothingLeft: true, askedAt: null, topUpTo_c: null, topUpBlocked: 'frozen' }] };
            world.mine = { ...world.mine, noLimit: true, ask: null };
            await fresh(list({ initialFilter: 'vouchers', focusVoucher: KEY('b') }));
            shot('05-vouchers-chip', set, 1250);
            // A plain voucher: the node answers the Vouchers chip with a 403, so the chip is not drawn.
            world.sight = 'voucher';
            world.chip = { status: 403, rows: [] };
            world.mine = { ...world.mine, noLimit: false, ask: { askedAt: null, lastAskedAt: null, askAgainAt: null, blocked: null } };
            await fresh(list());
            shot('06a-voucher-ask-for-more', set, 700);
            await press(byId('ask-for-more-button'));
            shot('06b-voucher-asked', set, 700);
            // The third place: under the node's "You have … of budget left" refusal on the sheet.
            world.mine = { ...world.mine, ask: { askedAt: null, lastAskedAt: null, askAgainAt: null, blocked: null } };
            world.vouchRefusal = { status: 409, error: 'You have 15 Beans of budget left, so you can’t vouch 25. Pick a smaller vouch, or ask an owner for more.', code: 'not_enough' };
            await fresh(list());
            await press(byId('credit-row-Rob')!.querySelector('[data-testid="credit-give"]'));
            await press(byId('invite-vouch-25'));
            await press(byId('give-vouch-submit'));
            shot('07-sheet-refusal-ask-for-more', set, 900);
        });
    }
});
void coreOffersNamesList;
