// @vitest-environment jsdom
/**
 * Vouchers on the phone (slice V2; DESIGN-invites-and-names-list-amend2-fable.md §2 to §5, Marty's §10 and §11): the rules
 * the screens call (utils/voucher-rules.ts), the names list's sort (utils/names-list.ts openEntries, on entries sealed with a
 * real list key), and the voucher card (components/VoucherCard.tsx) rendered from cards shaped as the node sends them.
 *
 * Node-shaped fixtures: engine/vouchers.ts budgetOf() returns `level = left + held`, and every landed vouch lowers it. A
 * voucher given 1,000 who vouched 350 and holds 100 reads left 550, held 100, level 650: a level off the 100-step grid,
 * which core's isBudgetLevel (the node's own check on "set to") refuses. Every figure is whole hundredths of a Bean, as the
 * node sends them (DESIGN-atomic-beans-fable.md M2): left 55000 is 550 Beans, and a history line's figure is `amount_c`.
 *
 * The screens themselves, with the node's answers for each role, are in vouchers-people-render.test.ts (People → Invites)
 * and vouchers-names-list-render.test.ts (the names list).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { isBudgetLevel, newNamesListKey, sealNamesEntry, VOUCHER_BUDGET_MAX } from '@beanpool/core';
import {
    openEntries, makeNamesVoucher,
    type OpenedEntry, type NamesListBody, type VoucherSummaryRow, type VoucherCardData, type ConfirmationRow,
} from '../names-list';
import {
    lowestBudgetLevel, nearestBudgetLevel, budgetLevelUp, budgetLevelDown, acceptsBudgetLevel, voucherActorWords, historyLineWords,
    voucherCardSubtitle, canMakeVoucher, ownerOnlyVoucherTargets, voucherCallsignFor, roleVouchersWithoutEntry, filterRoleVouchers,
} from '../voucher-rules';
import { voucherRowText } from '../../components/VouchersBlock';
import { VoucherCard } from '../../components/VoucherCard';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
// The names key's store (utils/names-list.ts DEVICE_NAMES_STORE), as names-list.test.ts mocks it: nothing is kept here.
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)), randomUUID: () => 'uuid' };
});

const alerts = vi.hoisted(() => ({ calls: [] as Array<{ title: string; buttons?: Array<{ text?: string; onPress?: () => unknown }> }> }));
vi.mock('react-native', async () => {
    const { createElement: h } = await import('react');
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, disabled, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (disabled) attrs.disabled = true;
        return h(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), TextInput: el('input'), ScrollView: el('div'),
        ActivityIndicator: el('div'),
        Alert: { alert: (title: string, _body?: string, buttons?: Array<{ text?: string; onPress?: () => unknown }>) => { alerts.calls.push({ title, buttons }); } },
        StyleSheet: { create: (s: any) => s, hairlineWidth: 1 },
    };
});
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (fn: any) => fn({ theme: 'light', colors: lightColors }),
    };
});

const mockFetch = vi.fn();
(globalThis as any).fetch = mockFetch;
const answer = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
/** The level each POST …/budget asked the node for, in order. */
const postedLevels = () => mockFetch.mock.calls
    .filter(([url]) => String(url).endsWith('/budget'))
    .map(([, init]) => JSON.parse((init as { body: string }).body).level as number);

/** As budgetOf() reads it for a voucher given 1,000 who vouched 350 to 4 people and holds 100 on one invite. */
const NODE_CARD: VoucherCardData = {
    memberPubkey: 'a1'.repeat(32),
    callsign: 'jane',
    source: 'entry',
    entryId: 'e'.repeat(32),
    madeBy: 'b2'.repeat(32),
    madeByCallsign: 'marty',
    madeAt: '2026-11-05T10:00:00Z',
    stoppedAt: null,
    stopReason: null,
    left: 55000,
    held: 10000,
    heldInvites: 1,
    vouched: 35000,
    vouchedLast30Days: 10000,
    peopleVouched: 4,
    level: 65000,
    belowZero: 1,
    writtenOff: 0,
    passedOn: { amount_c: 5000, people: 1, belowZero: 2500 },
    invitesWithVouch: 5,
    trading: { withOthers: 2, insideOnly: 1 },
    canChange: true,
    history: [
        { kind: 'grant', amount_c: 100000, actor: 'b2'.repeat(32), actorCallsign: 'marty', at: '2026-11-05T10:00:00Z' },
        { kind: 'hold', amount_c: -10000, actor: 'a1'.repeat(32), actorCallsign: 'jane', at: '2026-11-05T11:00:00Z', for: 'invite', outcome: 'held', inviteMadeAt: '2026-11-05T11:00:00Z' },
    ],
    people: [
        {
            memberPubkey: 'c3'.repeat(32), callsign: 'sam', joinedAt: '2026-11-02T12:00:00Z', amount_c: 10000, raised: false, byInvite: true,
            belowZero: true, left: false, writtenOff: 0, vouchesForMe: false, trading: 'others',
        },
    ],
};

const ME = '1'.repeat(64);
const identity = { publicKey: ME, privateKey: '2'.repeat(64), callsign: 'viewer', createdAt: '2026-11-01' };

const confirmation = (over: Partial<ConfirmationRow> = {}): ConfirmationRow => ({
    id: 'c1', entryId: 'e1', memberPubkey: 'pk_alice', callsign: 'alice', status: 'confirmed', confirmedBy: 'pk_marty', confirmedAt: '2026-11-03T09:00:00Z',
    needsSecond: false, secondedBy: null, secondedAt: null, revokedBy: null, revokedAt: null, revokeReason: null, ...over,
});
const summary = (over: Partial<VoucherSummaryRow>): VoucherSummaryRow => {
    const { history: _h, people: _p, canChange: _c, ...row } = NODE_CARD;
    return { ...row, ...over };
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
    mockFetch.mockReset();
    alerts.calls.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const renderCard = async (props: Record<string, unknown>) => {
    await act(async () => { root.render(createElement(VoucherCard, { anchorUrl: 'https://community.test', identity, memberPubkey: NODE_CARD.memberPubkey, ...props } as any) as any); });
};
const button = (label: string) => container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
const press = async (el: Element | null) => {
    expect(el).not.toBeNull();
    await act(async () => { (el as HTMLElement).click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const stepperValue = () => /Set budget to: ([\d,]+)/.exec(container.textContent ?? '')?.[1]?.replace(/,/g, '') ?? null;
const setButton = () => container.querySelector('button[aria-label^="Set budget to "]') as HTMLButtonElement | null;

describe('budget levels: only what the node takes (core isBudgetLevel, ≥ held, ≤ 2,000)', () => {
    it('every level the stepper can reach, from every card the node can send, is one the node accepts', () => {
        // Every held and level the node can send in steps of 25 Beans (the vouch presets are 25, 50, 75 and 100), in hundredths.
        for (let held = 0; held <= 200000; held += 2500) {
            for (let level = held; level <= 200000; level += 2500) {
                const start = nearestBudgetLevel(level, held);
                const seen = [start];
                for (let l: number | null = budgetLevelUp(start, held); l !== null; l = budgetLevelUp(l, held)) seen.push(l);
                for (let l: number | null = budgetLevelDown(start, held); l !== null; l = budgetLevelDown(l, held)) seen.push(l);
                for (const l of seen) {
                    expect(isBudgetLevel(l), `held ${held}, level ${level}: ${l}`).toBe(true);
                    expect(l, `held ${held}, level ${level}: ${l}`).toBeGreaterThanOrEqual(held);
                    expect(l).toBeLessThanOrEqual(VOUCHER_BUDGET_MAX);
                }
            }
        }
    });

    it('starts from the nearest level, never the card’s own off-grid level', () => {
        expect(nearestBudgetLevel(65000, 10000)).toBe(70000);
        expect(nearestBudgetLevel(62500, 0)).toBe(60000);
        expect(nearestBudgetLevel(100000, 10000)).toBe(100000);
        expect(nearestBudgetLevel(7500, 7500)).toBe(10000);
        expect(nearestBudgetLevel(15000, 12500)).toBe(20000); // 150 rounds to 200, and 100 would be below what's held
        expect(nearestBudgetLevel(205000, 0)).toBe(200000);
        expect(nearestBudgetLevel(null)).toBe(100000);
        expect(lowestBudgetLevel(12500)).toBe(20000);
        expect(lowestBudgetLevel(0)).toBe(10000);
        // A level one hundredth off the grid is off it (the grid is whole hundredths, not whole Beans).
        expect(nearestBudgetLevel(64999, 0)).toBe(60000);
        expect(lowestBudgetLevel(10001)).toBe(20000);
    });

    it('steps to the next level on the grid and stops at the floor and the ceiling', () => {
        expect(budgetLevelUp(65000, 10000)).toBe(70000);
        expect(budgetLevelDown(65000, 10000)).toBe(60000);
        expect(budgetLevelUp(70000, 10000)).toBe(80000);
        expect(budgetLevelDown(20000, 12500)).toBeNull();
        expect(budgetLevelDown(10000, 0)).toBeNull();
        expect(budgetLevelUp(200000, 0)).toBeNull();
        expect(acceptsBudgetLevel(65000, 10000)).toBe(false);
        expect(acceptsBudgetLevel(10000, 12500)).toBe(false);
        expect(acceptsBudgetLevel(20000, 12500)).toBe(true);
        expect(acceptsBudgetLevel(210000, 0)).toBe(false);
        // 100 Beans is 10000 hundredths: the old whole-Bean figure 100 is one Bean, off the grid and never sent.
        expect(acceptsBudgetLevel(100, 0)).toBe(false);
    });
});

describe('the voucher card from a card shaped as the node sends it (§5, §10)', () => {
    it('Set budget to starts at 700 for a 650 card, steps on the grid, and posts a level the node takes', async () => {
        mockFetch.mockResolvedValue(answer(200, { ...NODE_CARD, left: 70000, level: 80000, changed: true }));
        await renderCard({ initialCard: NODE_CARD });
        expect(stepperValue()).toBe('700');
        await press(button('Increase by 100'));
        expect(stepperValue()).toBe('800');
        await press(setButton());
        // The level the node takes, in whole hundredths: 800 Beans.
        expect(postedLevels()).toEqual([80000]);
        expect(postedLevels().every((l) => isBudgetLevel(l) && l >= NODE_CARD.held)).toBe(true);
    });

    it('stepping down stops at the lowest level the node takes for what is held, and never posts an off-grid level', async () => {
        mockFetch.mockResolvedValue(answer(409, { code: 'below_held', error: 'never asked' }));
        await renderCard({ initialCard: { ...NODE_CARD, held: 12500, left: 52500, level: 65000 } });
        expect(stepperValue()).toBe('700');
        for (let i = 0; i < 10; i++) {
            const down = button('Decrease by 100');
            if (!down || down.disabled) break;
            await press(down);
        }
        expect(stepperValue()).toBe('200');
        expect(button('Decrease by 100')?.disabled).toBe(true);
        await press(setButton());
        expect(postedLevels()).toEqual([20000]);
    });

    it('a quick level the node would refuse is not offered (below what is held)', async () => {
        await renderCard({ initialCard: { ...NODE_CARD, held: 60000, left: 5000, level: 65000, heldInvites: 6 } });
        expect(button('500')?.disabled).toBe(true);
        expect(button('1,000')?.disabled).toBeFalsy();
        expect(stepperValue()).toBe('700');
    });

    it('the Set button waits while the level is the one the voucher already has (the node would write nothing)', async () => {
        await renderCard({ initialCard: { ...NODE_CARD, left: 90000, held: 10000, vouched: 0, level: 100000 } });
        expect(stepperValue()).toBe('1000');
        expect(setButton()?.disabled).toBe(true);
        await press(button('1,500'));
        expect(setButton()?.disabled).toBeFalsy();
    });

    it('the budget lines, from the node’s numbers; no invite code and no balance figure', async () => {
        await renderCard({ initialCard: NODE_CARD });
        const text = container.textContent ?? '';
        expect(text).toContain('550 of 650 left');
        // The numbers first (invites-vouching I4): the headline is the card's first line, before the budget.
        expect(text).toContain('Vouched 350 to 4 people · 100 in the last 30 days · 1 below zero · written off 0');
        expect(container.querySelector('[data-testid="voucher-budget-card"]')?.firstElementChild?.getAttribute('data-testid')).toBe('voucher-headline');
        expect(text).not.toContain('people who joined');
        expect(text).toContain('Held 100 on 1 invite not used yet');
        expect(text).toContain('Invites sent with a vouch: 5');
        expect(text).toContain('Trading: 2 with others · 1 inside only');
        expect(container.querySelector('[data-testid="set-budget-control"]')?.textContent).toContain('550 left · 100 held');
        expect(text).not.toMatch(/[A-HJ-NP-Za-km-z1-9]{20,}/);
        expect(text).not.toMatch(/balance/i);
        // Every figure on the card is one of the node's own numbers for this budget (or a level to pick), never a balance.
        // ('30' is the headline's fixed window, "in the last 30 days": a length of time, not a figure from the node.) A level
        // of 1,000 Beans and more is grouped as every Beans figure is (core formatHundredths, as on the web).
        const own = new Set(['550', '650', '350', '4', '100', '1', '5', '0', '2', '50', '25', '500', '1,000', '1,500', '2,000', '700', '30']);
        const figures = Array.from(container.querySelectorAll('span')).flatMap((el) => (el.textContent ?? '').replace(/\d{1,2} (Nov|Oct)/g, '').match(/\d[\d,]*/g) ?? []);
        expect(figures.filter((f) => !own.has(f))).toEqual([]);
    });

    it('Passed on says how much of it is below zero now, from passedOn.belowZero (§5 tracking (a))', async () => {
        // Was "omits uncomputed belowZero from passedOn summary line", which asserted the clause was missing: the node does
        // send it (engine/vouchers.ts passedOnOf), so that assertion encoded the regression. It now asserts the node's number.
        await renderCard({ initialCard: NODE_CARD });
        expect(container.textContent).toContain('Passed on: 50 of their 350 to 1 person · 25 of it below zero');
        await renderCard({ initialCard: { ...NODE_CARD, passedOn: { amount_c: 12000, people: 3, belowZero: 0 } } });
        expect(container.textContent).toContain('Passed on: 120 of their 350 to 3 people · 0 of it below zero');
    });

    it('opened from the names list, the second line says who confirmed them and who made them a voucher (§5)', async () => {
        const entry = {
            id: 'e1', keyId: 'k1', createdAt: '', updatedAt: '', text: { name: 'Jane Albury', note: '' }, locked: null, key: null,
            holders: [], notTrusting: [], checkedHere: [], voucher: null,
            confirmation: confirmation({ memberPubkey: NODE_CARD.memberPubkey, callsign: 'jane', confirmedBy: 'pk_marty', confirmedAt: '2026-11-03T09:00:00Z' }),
        } as OpenedEntry;
        await renderCard({ initialCard: NODE_CARD, entry, nameOf: (pk: string) => (pk === 'pk_marty' ? 'marty' : '') });
        expect(container.textContent).toContain('Jane Albury · Voucher');
        expect(container.textContent).toContain('@jane: confirmed by @marty, 3 Nov · made a voucher by @marty, 5 Nov');
    });

    it('opened from People → Invites (no entry), the second line is the callsign and who made them a voucher', async () => {
        await renderCard({ initialCard: NODE_CARD });
        expect(container.textContent).toContain('@jane · made a voucher by @marty, 5 Nov');
        expect(container.textContent).not.toContain('confirmed by');
    });

    it('History never prints a node actor or a key: words for each, @callsign for members', async () => {
        const gone = 'd4'.repeat(32);
        const card: VoucherCardData = {
            ...NODE_CARD,
            history: [
                { kind: 'grant', amount_c: 100000, actor: 'node:claim', actorCallsign: null, at: '2026-11-01T10:00:00Z' },
                { kind: 'top_up', amount_c: 50000, actor: 'server:recover', actorCallsign: null, at: '2026-11-02T10:00:00Z' },
                { kind: 'grant', amount_c: 100000, actor: 'migration:vouchers', actorCallsign: null, at: '2026-11-03T10:00:00Z' },
                { kind: 'lower', amount_c: -20000, actor: gone, actorCallsign: null, at: '2026-11-04T10:00:00Z' },
                { kind: 'stop', amount_c: -30000, actor: 'SYSTEM', actorCallsign: null, at: '2026-11-04T11:00:00Z' },
                { kind: 'return', amount_c: 10000, actor: 'node', actorCallsign: null, at: '2026-11-04T12:00:00Z', for: 'invite', why: 'expired' },
                { kind: 'top_up', amount_c: 10000, actor: 'b2'.repeat(32), actorCallsign: 'marty', at: '2026-11-05T10:00:00Z' },
            ],
        };
        await renderCard({ initialCard: card });
        await press(button('Budget history ›'));
        const history = container.querySelector('[data-testid="budget-history-section"]')?.textContent ?? '';
        // Figures from whole hundredths (formatHundredths): 1,000 is grouped, as on the web.
        expect(history).toContain('+1,000 budget, made a voucher by the community’s first owner, 1 Nov');
        expect(history).toContain('+500 top-up by the server’s shell, 2 Nov');
        expect(history).toContain('+1,000 budget, made a voucher by BeanPool, when vouchers started, 3 Nov');
        expect(history).toContain('−200 lower by someone who has left, 4 Nov');
        expect(history).toContain('Budget stopped by the community’s server, 4 Nov');
        expect(history).toContain('+100 back, invite expired, 4 Nov');
        expect(history).toContain('+100 top-up by @marty, 5 Nov');
        for (const raw of ['node:claim', 'server:recover', 'migration:vouchers', 'migration', 'SYSTEM', gone]) expect(history).not.toContain(raw);
        expect(history).not.toMatch(/[0-9a-f]{64}/i);
    });

    it('shows the node’s refusal sentences as they come', async () => {
        await renderCard({ initialCard: NODE_CARD });
        for (const [status, code, error] of [
            [409, 'below_held', '@jane has 100 Beans held on invites not used yet: a budget can’t go below that.'],
            [409, 'over_ceiling', 'A voucher holds at most 2,000 Beans of budget.'],
            [403, 'owner_only', 'Only an owner lowers an owner’s budget.'],
        ] as const) {
            mockFetch.mockResolvedValueOnce(answer(status, { code, error }));
            await press(setButton());
            expect(container.textContent).toContain(error);
        }
    });

    it('keeps the controls after a budget is set (the node’s card carries no canChange)', async () => {
        const { canChange: _drop, ...noCanChange } = { ...NODE_CARD, left: 140000, level: 150000, changed: true };
        mockFetch.mockResolvedValueOnce(answer(200, noCanChange));
        await renderCard({ initialCard: NODE_CARD });
        await press(button('1,500'));
        await press(setButton());
        expect(container.textContent).toContain('Budget set to 1,500 Beans.');
        expect(container.querySelector('[data-testid="set-budget-control"]')).not.toBeNull();
        expect(stepperValue()).toBe('1500');
    });

    it('a stopped voucher: no set-to control and no Stop vouching', async () => {
        await renderCard({ initialCard: { ...NODE_CARD, stoppedAt: '2026-11-03T12:00:00Z', stopReason: 'stopped' } });
        expect(container.querySelector('[data-testid="set-budget-control"]')).toBeNull();
        expect(container.textContent).not.toContain('Stop vouching');
    });
});

describe('the rules the screens call', () => {
    const entry = (over: Partial<OpenedEntry>): Pick<OpenedEntry, 'voucher' | 'confirmation' | 'text'> => ({
        text: { name: 'Alice', note: '' }, voucher: null, confirmation: confirmation(), ...over,
    });

    it('canMakeVoucher: the committee only, on a complete confirmation, never a voucher already, never your own', () => {
        expect(canMakeVoucher(entry({}), true, ME)).toBe(true);
        expect(canMakeVoucher(entry({}), false, ME)).toBe(false);
        expect(canMakeVoucher(entry({ confirmation: confirmation({ status: 'awaiting_second' }) }), true, ME)).toBe(false);
        expect(canMakeVoucher(entry({ confirmation: confirmation({ status: 'revoked' }) }), true, ME)).toBe(false);
        expect(canMakeVoucher(entry({ confirmation: null }), true, ME)).toBe(false);
        expect(canMakeVoucher(entry({ voucher: summary({ memberPubkey: 'pk_alice' }) }), true, ME)).toBe(false);
        expect(canMakeVoucher(entry({ confirmation: confirmation({ memberPubkey: ME }) }), true, ME)).toBe(false);
        expect(canMakeVoucher(entry({}), true, null)).toBe(false);
    });

    it('canMakeVoucher: not on an admin’s entry for a viewer who is not an owner (the node answers 403 owner_only); an owner may (review, 10 Nov; I5)', () => {
        const admins = [
            { pubkey: ME, role: 'owner' }, { pubkey: 'pk_alice', role: 'admin' }, { pubkey: 'pk_wren', role: 'admin' }, { pubkey: 'pk_sally', role: 'owner' },
        ];
        const committeeAdmin = ownerOnlyVoucherTargets(admins, false);
        const owner = ownerOnlyVoucherTargets(admins, true);
        // Alice is an admin (entry() confirms pk_alice): a committee admin is not offered Make, an owner is.
        expect(canMakeVoucher(entry({}), true, ME, committeeAdmin)).toBe(false);
        expect(canMakeVoucher(entry({}), true, ME, owner)).toBe(true);
        // A member who is no admin is offered to both, and the rule never lets a non-committee viewer in.
        expect(canMakeVoucher(entry({ confirmation: confirmation({ memberPubkey: 'pk_bea' }) }), true, ME, committeeAdmin)).toBe(true);
        expect(canMakeVoucher(entry({}), false, ME, owner)).toBe(false);
        // The other checks still hold with the set given.
        expect(canMakeVoucher(entry({ confirmation: confirmation({ status: 'awaiting_second', memberPubkey: 'pk_bea' }) }), true, ME, committeeAdmin)).toBe(false);
        expect(canMakeVoucher(entry({ voucher: summary({ memberPubkey: 'pk_bea' }), confirmation: confirmation({ memberPubkey: 'pk_bea' }) }), true, ME, committeeAdmin)).toBe(false);
    });

    it('ownerOnlyVoucherTargets: the admins, for anyone who is not an owner; nobody for an owner; owners are never in it', () => {
        const admins = [{ pubkey: 'pk_sally', role: 'owner' }, { pubkey: 'pk_alice', role: 'admin' }, { pubkey: 'pk_wren', role: 'admin' }];
        expect([...ownerOnlyVoucherTargets(admins, false)].sort()).toEqual(['pk_alice', 'pk_wren']);
        expect(ownerOnlyVoucherTargets(admins, true).size).toBe(0);
        expect(ownerOnlyVoucherTargets(null, false).size).toBe(0);
        expect(ownerOnlyVoucherTargets(undefined, false).size).toBe(0);
    });

    it('voucherCallsignFor: the confirmation’s callsign, the community’s, the entry’s name', () => {
        const callsignOf = (pk: string) => (pk === 'pk_charlie' ? 'charlie' : '');
        expect(voucherCallsignFor(entry({ confirmation: confirmation({ callsign: 'alice' }) }), callsignOf)).toBe('alice');
        expect(voucherCallsignFor(entry({ confirmation: confirmation({ callsign: null, memberPubkey: 'pk_charlie' }) }), callsignOf)).toBe('charlie');
        expect(voucherCallsignFor(entry({ text: { name: 'Charlie Bucket', note: '' }, confirmation: confirmation({ callsign: null, memberPubkey: 'pk_x' }) }), callsignOf)).toBe('Charlie Bucket');
    });

    it('role vouchers with no entry, and the search over them', () => {
        const owner = summary({ memberPubkey: 'pk_owner', callsign: 'Sally', source: 'role', entryId: null });
        const jane = summary({ memberPubkey: 'pk_jane', callsign: 'jane' });
        const rows = roleVouchersWithoutEntry([owner, jane], [entry({ voucher: jane, confirmation: confirmation({ memberPubkey: 'pk_jane' }) })]);
        expect(rows.map((r) => r.callsign)).toEqual(['Sally']);
        expect(filterRoleVouchers(rows, 'sal').map((r) => r.callsign)).toEqual(['Sally']);
        expect(filterRoleVouchers(rows, 'zed')).toEqual([]);
        expect(filterRoleVouchers(rows, '  ')).toEqual(rows);
        expect(roleVouchersWithoutEntry(null, [])).toEqual([]);
    });

    it('voucherActorWords and historyLineWords never return the actor string', () => {
        expect(voucherActorWords({ actor: 'node:claim', actorCallsign: null })).toBe('the community’s first owner');
        expect(voucherActorWords({ actor: 'server:recover', actorCallsign: null })).toBe('the server’s shell');
        expect(voucherActorWords({ actor: 'migration:vouchers', actorCallsign: null })).toBe('BeanPool, when vouchers started');
        expect(voucherActorWords({ actor: 'f'.repeat(64), actorCallsign: null })).toBe('someone who has left');
        expect(voucherActorWords({ actor: 'f'.repeat(64), actorCallsign: 'wren' })).toBe('@wren');
        expect(historyLineWords({ kind: 'mystery', amount_c: 500, actor: 'node:claim', actorCallsign: null, at: '2026-11-05T10:00:00Z' })).toBe('Budget changed by the community’s first owner, 5 Nov');
        // A line's figure is whole hundredths: a part of a Bean shows its hundredths; a figure that isn't one is no number.
        expect(historyLineWords({ kind: 'top_up', amount_c: 4925, actor: 'b2'.repeat(32), actorCallsign: 'marty', at: '2026-11-05T10:00:00Z' })).toBe('+49.25 top-up by @marty, 5 Nov');
        expect(historyLineWords({ kind: 'top_up', amount_c: 1, actor: 'b2'.repeat(32), actorCallsign: 'marty', at: '2026-11-05T10:00:00Z' })).toBe('+0.01 top-up by @marty, 5 Nov');
        expect(historyLineWords({ kind: 'top_up', amount_c: 12.5, actor: 'b2'.repeat(32), actorCallsign: 'marty', at: '2026-11-05T10:00:00Z' })).not.toMatch(/12/);
    });

    it('voucherCardSubtitle: a seconded confirmation names both admins; a role budget says so', () => {
        const conf = confirmation({ memberPubkey: NODE_CARD.memberPubkey, secondedBy: 'pk_wren', secondedAt: '2026-11-04T09:00:00Z' });
        const nameOf = (pk: string) => ({ pk_marty: 'marty', pk_wren: 'wren' } as Record<string, string>)[pk] ?? '';
        expect(voucherCardSubtitle(NODE_CARD, conf, nameOf)).toBe('@jane: confirmed by @marty and @wren, 4 Nov · made a voucher by @marty, 5 Nov');
        expect(voucherCardSubtitle({ ...NODE_CARD, source: 'role', madeBy: 'migration:vouchers', madeByCallsign: null }, null)).toBe('@jane · made a voucher by role');
        // An admin an owner made a voucher (I5: source 'role', made by that owner) names the owner, as the web and manager do.
        expect(voucherCardSubtitle({ ...NODE_CARD, source: 'role', madeBy: 'pk_marty', madeByCallsign: 'marty' }, null)).toBe('@jane · made a voucher by @marty, 5 Nov');
        // Someone else's confirmation (not this member's) is never shown as theirs.
        expect(voucherCardSubtitle(NODE_CARD, confirmation({ memberPubkey: 'pk_other' }), nameOf)).toBe('@jane · made a voucher by @marty, 5 Nov');
    });

    it('the Vouchers block row, from the node’s numbers (§11)', () => {
        // Rows say only what matters (I4): who and what is left; an owner's says who and how many they vouched, no budget words.
        expect(voucherRowText(NODE_CARD)).toBe('@jane · 550 left ›');
        expect(voucherRowText({ ...NODE_CARD, left: 145000 })).toBe('@jane · 1,450 left ›');
        // The figures this check pins (DESIGN-atomic-beans-fable.md M2): a hundredth, a Bean, a part, and a whole figure.
        expect(voucherRowText({ ...NODE_CARD, left: 1 })).toBe('@jane · 0.01 left ›');
        expect(voucherRowText({ ...NODE_CARD, left: 100 })).toBe('@jane · 1 left ›');
        expect(voucherRowText({ ...NODE_CARD, left: 4925 })).toBe('@jane · 49.25 left ›');
        expect(voucherRowText({ ...NODE_CARD, left: 50000 })).toBe('@jane · 500 left ›');
        expect(voucherRowText({ ...NODE_CARD, noLimit: true })).toBe('@jane · 4 vouched ›');
    });
});

describe('the names list puts vouchers first (§10), on entries sealed with a real list key', () => {
    it('a voucher sorts above names that come before theirs, then the rest by name', () => {
        const key = newNamesListKey();
        const KID = '9'.repeat(64);
        const sealed = (id: string, name: string) => ({ id, keyId: KID, ciphertext: sealNamesEntry(key, id, KID, { name, note: '' }), createdBy: 'a', createdAt: '2026-11-01', updatedAt: '2026-11-01', updatedBy: null });
        const ids = ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)];
        const list: NamesListBody = {
            current: null,
            entries: [sealed(ids[0], 'Alice Archer'), sealed(ids[1], 'Bob Baker'), sealed(ids[2], 'Charlie Cole')],
            confirmations: [
                confirmation({ id: 'c1', entryId: ids[0], memberPubkey: 'pk_alice', callsign: 'alice' }),
                confirmation({ id: 'c3', entryId: ids[2], memberPubkey: 'pk_charlie', callsign: 'charlie' }),
            ],
        } as NamesListBody;
        const opened = { ring: { [KID]: key }, pin: { trusted: [], me: ME, chain: [], abandoned: [], communityId: 'test' }, generations: new Map(), state: { admins: [] } } as any;
        const charlie = summary({ memberPubkey: 'pk_charlie', callsign: 'charlie', entryId: ids[2] });

        const withBlock = openEntries(list, opened, [charlie]);
        expect(withBlock.map((e) => e.text?.name)).toEqual(['Charlie Cole', 'Alice Archer', 'Bob Baker']);
        expect(withBlock[0].voucher?.memberPubkey).toBe('pk_charlie');
        // Without the block (anyone the node didn't answer it for) there are no voucher rows and the list is by name.
        const without = openEntries(list, opened);
        expect(without.map((e) => e.text?.name)).toEqual(['Alice Archer', 'Bob Baker', 'Charlie Cole']);
        expect(without.every((e) => !e.voucher)).toBe(true);
    });

    it('Make a voucher posts the amount picked', async () => {
        mockFetch.mockResolvedValueOnce(answer(201, NODE_CARD));
        const res = await makeNamesVoucher('https://community.test', identity, 'e'.repeat(32), 110000);
        expect(res.ok).toBe(true);
        const [url, init] = mockFetch.mock.calls[0];
        expect(String(url)).toBe('https://community.test/api/names/vouchers');
        // The budget is `amount_c`, whole hundredths (engine/vouchers.ts makeVoucher): the node refuses the old `amount`
        // with 400 amount_c_required, so the old `{ entryId, amount: 1100 }` this pinned was never made.
        expect(JSON.parse((init as { body: string }).body)).toEqual({ entryId: 'e'.repeat(32), amount_c: 110000 });
    });
});
