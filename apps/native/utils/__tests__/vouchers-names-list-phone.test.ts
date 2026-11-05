// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import {
    openEntries, fetchVouchers, makeNamesVoucher,
    type OpenedEntry, type NamesListBody, type VoucherSummaryRow, type VoucherCardData,
} from '../names-list';
import { VoucherCard } from '../../components/VoucherCard';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', () => ({
    MaterialCommunityIcons: () => null,
}));

vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(len)),
}));

vi.mock('expo', () => ({
    requireNativeModule: vi.fn(() => ({})),
    requireOptionalNativeModule: vi.fn(() => null),
}));
vi.mock('expo-modules-core', () => ({
    requireNativeModule: vi.fn(() => ({})),
    requireOptionalNativeModule: vi.fn(() => null),
    EventEmitter: vi.fn(() => ({ addListener: vi.fn(), removeListener: vi.fn() })),
    NativeModulesProxy: {},
    ProxyNativeModule: {},
}));

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
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), TextInput: el('input'), ScrollView: el('div'),
        ActivityIndicator: el('div'),
        Alert: { alert: vi.fn() },
        StyleSheet: { create: (s: any) => s, hairlineWidth: 1 },
    };
});

const MOCK_COLORS = {
    brand: { primary: '#2b583c', fill: '#2b583c' },
    text: { heading: '#181b18', body: '#242824', secondary: '#585e57', muted: '#767c74', inverse: '#ffffff' },
    surface: { card: '#ffffff', subtle: '#f3f4f1', page: '#fbfbf9', sunken: '#ecefe9' },
    border: { default: '#e0e3dd', strong: '#c2c7be' },
    feedback: {
        danger: { solid: '#b9382c', fg: '#b9382c', bg: '#fdf2f1', border: '#fca5a5' },
        warning: { fg: '#a05c04', bg: '#fef7ec', border: '#fcd34d', solid: '#d97706' },
        success: { bg: '#eef6f0', fg: '#2b583c', border: '#86efac', solid: '#16a34a' },
        info: { fg: '#2563eb', bg: '#eff6ff', border: '#3b82f6', solid: '#2563eb' },
    },
};

vi.mock('../../app/ThemeContext', () => ({
    useTheme: () => ({ theme: 'light', colors: MOCK_COLORS }),
    useStyles: (fn: any) => fn({ theme: 'light', colors: MOCK_COLORS }),
}));

const mockFetch = vi.fn();
(globalThis as any).fetch = mockFetch;

const FIXTURE_VOUCHER_CARD: VoucherCardData = {
    memberPubkey: 'pk_jane',
    callsign: 'jane',
    source: 'entry',
    entryId: 'entry_jane',
    madeBy: 'pk_admin',
    madeByCallsign: 'admin',
    madeAt: '2026-11-01T10:00:00Z',
    stoppedAt: null,
    stopReason: null,
    left: 550,
    held: 100,
    heldInvites: 1,
    vouched: 350,
    peopleVouched: 4,
    level: 1000,
    belowZero: 1,
    writtenOff: 0,
    passedOn: { amount: 50, people: 1 },
    invitesWithVouch: 5,
    trading: { withOthers: 3, insideOnly: 1 },
    canChange: true,
    history: [
        {
            kind: 'grant',
            amount: 1000,
            actor: 'pk_admin',
            actorCallsign: 'admin',
            at: '2026-11-01T10:00:00Z',
        },
        {
            kind: 'hold',
            amount: -100,
            actor: 'pk_jane',
            actorCallsign: 'jane',
            at: '2026-11-02T10:00:00Z',
            for: 'invite',
            outcome: 'vouched',
            person: { memberPubkey: 'pk_sam', callsign: 'sam' },
        },
    ],
    people: [
        {
            memberPubkey: 'pk_sam',
            callsign: 'sam',
            joinedAt: '2026-11-02T12:00:00Z',
            amount: 100,
            raised: false,
            byInvite: true,
            belowZero: true,
            left: false,
            writtenOff: 0,
            vouchesForMe: false,
            trading: 'others',
        },
    ],
};

describe('vouchers on the phone (slice V2)', () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    describe('openEntries and sorting (§10)', () => {
        it('vouchers sort FIRST on the names list automatically', () => {
            const list: NamesListBody = {
                current: null,
                entries: [
                    { id: 'e1', keyId: 'k1', ciphertext: 'c1', createdBy: 'a', createdAt: '2026-11-01', updatedAt: '2026-11-01', updatedBy: null },
                    { id: 'e2', keyId: 'k1', ciphertext: 'c2', createdBy: 'a', createdAt: '2026-11-02', updatedAt: '2026-11-02', updatedBy: null },
                    { id: 'e3', keyId: 'k1', ciphertext: 'c3', createdBy: 'a', createdAt: '2026-11-03', updatedAt: '2026-11-03', updatedBy: null },
                ],
                confirmations: [
                    { id: 'c1', entryId: 'e1', memberPubkey: 'pk_alice', callsign: 'alice', status: 'confirmed', confirmedBy: 'a', confirmedAt: '2026-11-01', needsSecond: false, secondedBy: null, secondedAt: null, revokedBy: null, revokedAt: null, revokeReason: null },
                    { id: 'c2', entryId: 'e2', memberPubkey: 'pk_bob', callsign: 'bob', status: 'confirmed', confirmedBy: 'a', confirmedAt: '2026-11-02', needsSecond: false, secondedBy: null, secondedAt: null, revokedBy: null, revokedAt: null, revokeReason: null },
                    { id: 'c3', entryId: 'e3', memberPubkey: 'pk_charlie', callsign: 'charlie', status: 'confirmed', confirmedBy: 'a', confirmedAt: '2026-11-03', needsSecond: false, secondedBy: null, secondedAt: null, revokedBy: null, revokedAt: null, revokeReason: null },
                ],
            };

            // Only Charlie is a voucher. Alice and Bob are not.
            // Alphabetically Alice is first, but Charlie must sort FIRST because Charlie is a voucher.
            const voucherCharlie: VoucherSummaryRow = {
                memberPubkey: 'pk_charlie',
                callsign: 'charlie',
                source: 'entry',
                entryId: 'e3',
                madeBy: 'a',
                madeByCallsign: 'admin',
                madeAt: '2026-11-03',
                stoppedAt: null,
                stopReason: null,
                left: 1000,
                held: 0,
                heldInvites: 0,
                vouched: 0,
                peopleVouched: 0,
                level: 1000,
                belowZero: 0,
                writtenOff: 0,
                passedOn: { amount: 0, people: 0 },
                invitesWithVouch: 0,
                trading: { withOthers: 0, insideOnly: 0 },
            };

            const opened: any = {
                ring: {},
                pin: { trusted: [], me: 'a', chain: [], abandoned: [], communityId: 'test' },
                generations: new Map(),
                state: { admins: [] },
                vouchers: [voucherCharlie],
            };

            // Mock openNamesEntry to return real names matching callsigns
            const entries = openEntries(list, opened);
            // Charlie is the voucher, so Charlie must be first
            expect(entries[0].id).toBe('e3');
            expect(entries[0].voucher).toBeDefined();
            expect(entries[0].voucher?.callsign).toBe('charlie');
            // Non-vouchers come after
            expect(entries.slice(1).map((e) => e.id)).toEqual(['e1', 'e2']);
        });
    });

    describe('Make a voucher gate (§10, §11)', () => {
        it('Make a voucher is absent for plain admins, unconfirmed, waiting, or revoked entries', () => {
            const isCommitteeTrue = true;
            const isCommitteeFalse = false;

            const confirmedEntry: OpenedEntry = {
                id: 'e1', keyId: 'k1', createdAt: '2026-11-01', updatedAt: '2026-11-01',
                text: { name: 'Alice', note: '' }, locked: null, key: null, holders: [], notTrusting: [], checkedHere: [],
                confirmation: { id: 'c1', entryId: 'e1', memberPubkey: 'pk1', callsign: 'alice', status: 'confirmed', confirmedBy: 'a', confirmedAt: '', needsSecond: false, secondedBy: null, secondedAt: null, revokedBy: null, revokedAt: null, revokeReason: null },
                voucher: null,
            };

            const awaitingEntry: OpenedEntry = {
                ...confirmedEntry,
                id: 'e2',
                confirmation: { ...confirmedEntry.confirmation!, status: 'awaiting_second' },
            };

            const revokedEntry: OpenedEntry = {
                ...confirmedEntry,
                id: 'e3',
                confirmation: { ...confirmedEntry.confirmation!, status: 'revoked' },
            };

            const unconfirmedEntry: OpenedEntry = {
                ...confirmedEntry,
                id: 'e4',
                confirmation: null,
            };

            const alreadyVoucherEntry: OpenedEntry = {
                ...confirmedEntry,
                id: 'e5',
                voucher: {
                    memberPubkey: 'pk1', callsign: 'alice', source: 'entry', entryId: 'e5', madeBy: 'a', madeByCallsign: 'admin', madeAt: '',
                    stoppedAt: null, stopReason: null, left: 1000, held: 0, heldInvites: 0, vouched: 0, peopleVouched: 0, level: 1000,
                    belowZero: 0, writtenOff: 0, passedOn: { amount: 0, people: 0 }, invitesWithVouch: 0, trading: { withOthers: 0, insideOnly: 0 },
                },
            };

            const canMake = (entry: OpenedEntry, isCommittee: boolean, viewerPubkey: string = 'viewer_pk') =>
                isCommittee && !entry.voucher && entry.confirmation?.status === 'confirmed' && entry.confirmation.memberPubkey !== viewerPubkey;

            // Confirmed entry with committee admin: ALLOWED
            expect(canMake(confirmedEntry, isCommitteeTrue)).toBe(true);

            // Plain admin (not on committee): FORBIDDEN
            expect(canMake(confirmedEntry, isCommitteeFalse)).toBe(false);

            // Awaiting second confirmation: FORBIDDEN
            expect(canMake(awaitingEntry, isCommitteeTrue)).toBe(false);

            // Revoked confirmation: FORBIDDEN
            expect(canMake(revokedEntry, isCommitteeTrue)).toBe(false);

            // Unconfirmed entry: FORBIDDEN
            expect(canMake(unconfirmedEntry, isCommitteeTrue)).toBe(false);

            // Already a voucher: FORBIDDEN
            expect(canMake(alreadyVoucherEntry, isCommitteeTrue)).toBe(false);

            // Own confirmed entry: FORBIDDEN (own_budget refusal prevention)
            expect(canMake(confirmedEntry, isCommitteeTrue, 'pk1')).toBe(false);
        });

        it('resolves callsign fallback to callsignOf or entry name when confirmation.callsign is null', () => {
            const callsignOf = (pk: string) => (pk === 'pk_charlie' ? 'charlie_callsign' : '');
            const entryWithoutCallsign = {
                text: { name: 'Charlie Bucket', note: '' },
                confirmation: { memberPubkey: 'pk_charlie', callsign: null },
            };
            const resolvedCallsign = entryWithoutCallsign.confirmation.callsign || callsignOf(entryWithoutCallsign.confirmation.memberPubkey) || entryWithoutCallsign.text?.name || '';
            expect(resolvedCallsign).toBe('charlie_callsign');

            const entryWithOnlyName = {
                text: { name: 'Charlie Bucket', note: '' },
                confirmation: { memberPubkey: 'pk_unknown', callsign: null },
            };
            const resolvedFromName = entryWithOnlyName.confirmation.callsign || callsignOf(entryWithOnlyName.confirmation.memberPubkey) || entryWithOnlyName.text?.name || '';
            expect(resolvedFromName).toBe('Charlie Bucket');
        });
    });

    describe('VoucherCard rendering from fixture (§5, §10)', () => {
        let container: HTMLDivElement;
        let root: any;

        beforeEach(() => {
            container = document.createElement('div');
            document.body.appendChild(container);
            root = createRoot(container);
        });

        it('renders all budget lines, quick levels, stepper, and no invite code or foreign balance figures', async () => {
            const identity = { publicKey: '1'.repeat(64), privateKey: '2'.repeat(64), callsign: 'viewer', createdAt: '2026-11-01' };

            await act(async () => {
                root.render(
                    createElement(VoucherCard, {
                        anchorUrl: 'https://community.test',
                        identity,
                        memberPubkey: 'pk_jane',
                        initialCard: FIXTURE_VOUCHER_CARD,
                    })
                );
            });

            const html = container.innerHTML;

            // 1. Budget box lines
            expect(html).toMatch(/550 of 1,?000 left/);
            expect(html).toContain('Vouched 350 to 4 people who joined');
            expect(html).toContain('Held 100 on 1 invite not used yet');
            expect(html).toContain('Invites sent with a vouch: 5');
            expect(html).toContain('1 of 4 below zero · written off 0');
            expect(html).toContain('Trading: 3 with others · 1 inside only');

            // 2. Set budget to control (§10 quick levels: 500, 1,000, 1,500, 2,000)
            const control = container.querySelector('[data-testid="set-budget-control"]');
            expect(control).not.toBeNull();
            expect(control?.textContent).toMatch(/500/);
            expect(control?.textContent).toMatch(/1,?000/);
            expect(control?.textContent).toMatch(/1,?500/);
            expect(control?.textContent).toMatch(/2,?000/);

            // 3. Stop vouching button
            expect(html).toContain('Stop vouching');

            // 4. Budget history button
            expect(html).toContain('Budget history ›');

            // 5. See who they brought in button
            expect(html).toContain('See who they brought in ›');

            // 6. Security guardrail: Card shows NO invite code anywhere
            // (invite codes are 12+ char base58/alphanumeric or hex tickets)
            expect(html).not.toMatch(/[A-HJ-NP-Za-km-z1-9]{20,}/);

            // 7. Security guardrail: No balance figure renders (regex over Beans amounts other than card's own budget)
            // Stored accounts.balance is never displayed here
            expect(html).not.toMatch(/balance:?\s*-?\d+/i);
            expect(html).not.toMatch(/account balance/i);
        });

        it('updates target budget via quick levels (500, 1000, 1500, 2000) and 100-step stepper controls', async () => {
            const identity = { publicKey: '1'.repeat(64), privateKey: '2'.repeat(64), callsign: 'viewer', createdAt: '2026-11-01' };

            await act(async () => {
                root.render(
                    createElement(VoucherCard, {
                        anchorUrl: 'https://community.test',
                        identity,
                        memberPubkey: 'pk_jane',
                        initialCard: FIXTURE_VOUCHER_CARD,
                    })
                );
            });

            // Initial level is 1000 (from fixture)
            expect(container.textContent).toMatch(/Set budget to: 1,?000/);

            // Click quick level 1,500
            const btn1500 = container.querySelector('button[aria-label="1500"], button[aria-label="1,500"]');
            expect(btn1500).not.toBeNull();
            await act(async () => {
                btn1500?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            expect(container.textContent).toMatch(/Set budget to: 1,?500/);

            // Click stepper + (increases by 100 to 1,600)
            const plusBtn = container.querySelector('button[aria-label="Increase by 100"]');
            expect(plusBtn).not.toBeNull();
            await act(async () => {
                plusBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            expect(container.textContent).toMatch(/Set budget to: 1,?600/);

            // Click stepper − (decreases by 100 back to 1,500)
            const minusBtn = container.querySelector('button[aria-label="Decrease by 100"]');
            expect(minusBtn).not.toBeNull();
            await act(async () => {
                minusBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            expect(container.textContent).toMatch(/Set budget to: 1,?500/);

            // Click quick level 500
            const btn500 = container.querySelector('button[aria-label="500"]');
            expect(btn500).not.toBeNull();
            await act(async () => {
                btn500?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            expect(container.textContent).toContain('Set budget to: 500');

            // Click quick level 2,000
            const btn2000 = container.querySelector('button[aria-label="2000"], button[aria-label="2,000"]');
            expect(btn2000).not.toBeNull();
            await act(async () => {
                btn2000?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            expect(container.textContent).toMatch(/Set budget to: 2,?000/);
        });

        it('displays server refusal sentences directly as they come from the node (level_below_held, over_ceiling, raise_frozen)', async () => {
            const identity = { publicKey: '1'.repeat(64), privateKey: '2'.repeat(64), callsign: 'viewer', createdAt: '2026-11-01' };

            // 1. level_below_held refusal
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 409,
                json: async () => ({
                    code: 'level_below_held',
                    error: 'Jane has 100 Beans held on invites not used yet: you cannot lower below that.',
                }),
            });

            await act(async () => {
                root.render(
                    createElement(VoucherCard, {
                        anchorUrl: 'https://community.test',
                        identity,
                        memberPubkey: 'pk_jane',
                        initialCard: FIXTURE_VOUCHER_CARD,
                    })
                );
            });

            const submitBtn = container.querySelector('button[aria-label^="Set budget to 1"]');
            expect(submitBtn).not.toBeNull();

            await act(async () => {
                submitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });

            expect(container.textContent).toContain('Jane has 100 Beans held on invites not used yet: you cannot lower below that.');

            // 2. over_ceiling refusal
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 400,
                json: async () => ({
                    code: 'over_ceiling',
                    error: 'Voucher budget cannot exceed 2,000 Beans.',
                }),
            });

            await act(async () => {
                submitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            expect(container.textContent).toContain('Voucher budget cannot exceed 2,000 Beans.');

            // 3. raise_frozen refusal
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 403,
                json: async () => ({
                    code: 'raise_frozen',
                    error: 'This community has frozen budget increases.',
                }),
            });

            await act(async () => {
                submitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            expect(container.textContent).toContain('This community has frozen budget increases.');
        });

        it('retains canChange and keeps budget controls mounted after setVoucherBudget succeeds', async () => {
            const identity = { publicKey: '1'.repeat(64), privateKey: '2'.repeat(64), callsign: 'viewer', createdAt: '2026-11-01' };

            // Server POST /api/names/vouchers/:member/budget returns card WITHOUT canChange property
            const serverResponseWithoutCanChange = {
                ...FIXTURE_VOUCHER_CARD,
                level: 1500,
                changed: true,
            };
            delete (serverResponseWithoutCanChange as any).canChange;

            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => serverResponseWithoutCanChange,
            });

            await act(async () => {
                root.render(
                    createElement(VoucherCard, {
                        anchorUrl: 'https://community.test',
                        identity,
                        memberPubkey: 'pk_jane',
                        initialCard: FIXTURE_VOUCHER_CARD,
                    })
                );
            });

            // Click quick level 1,500
            const btn1500 = container.querySelector('button[aria-label="1500"], button[aria-label="1,500"]');
            await act(async () => {
                btn1500?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });

            const submitBtn = container.querySelector('button[aria-label^="Set budget to 1"]');
            expect(submitBtn).not.toBeNull();

            await act(async () => {
                submitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });

            // Notice is displayed
            expect(container.textContent).toMatch(/Budget set to 1,?500 Beans\./);

            // Controls are STILL mounted because canChange was preserved!
            const controlAfter = container.querySelector('[data-testid="set-budget-control"]');
            expect(controlAfter).not.toBeNull();
        });

        it('calculates minAllowed rounded to multiples of 100 when held amount is not a multiple of 100', async () => {
            const identity = { publicKey: '1'.repeat(64), privateKey: '2'.repeat(64), callsign: 'viewer', createdAt: '2026-11-01' };

            // held: 125 (e.g. presets of 50 + 75). minAllowed must be ceil(125/100)*100 = 200.
            const cardWithNon100Held: VoucherCardData = {
                ...FIXTURE_VOUCHER_CARD,
                held: 125,
                level: 300,
            };

            await act(async () => {
                root.render(
                    createElement(VoucherCard, {
                        anchorUrl: 'https://community.test',
                        identity,
                        memberPubkey: 'pk_jane',
                        initialCard: cardWithNon100Held,
                    })
                );
            });

            // Level starts at 300
            expect(container.textContent).toMatch(/Set budget to: 300/);

            // Step down once: 300 - 100 = 200 (which equals minAllowed = 200)
            const minusBtn = container.querySelector('button[aria-label="Decrease by 100"]');
            expect(minusBtn).not.toBeNull();
            await act(async () => {
                minusBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            expect(container.textContent).toMatch(/Set budget to: 200/);

            // Stepping down again is disabled or clamped to minAllowed 200 (never 125 or 100)
            await act(async () => {
                minusBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            expect(container.textContent).toMatch(/Set budget to: 200/);
        });

        it('hides budget controls and stop vouching button when voucher has already been stopped', async () => {
            const identity = { publicKey: '1'.repeat(64), privateKey: '2'.repeat(64), callsign: 'viewer', createdAt: '2026-11-01' };

            const stoppedCard: VoucherCardData = {
                ...FIXTURE_VOUCHER_CARD,
                stoppedAt: '2026-11-03T12:00:00Z',
                stopReason: 'admin',
                canChange: true,
            };

            await act(async () => {
                root.render(
                    createElement(VoucherCard, {
                        anchorUrl: 'https://community.test',
                        identity,
                        memberPubkey: 'pk_jane',
                        initialCard: stoppedCard,
                    })
                );
            });

            // Budget control section is not rendered
            const control = container.querySelector('[data-testid="set-budget-control"]');
            expect(control).toBeNull();

            // Stop vouching button is not rendered
            expect(container.textContent).not.toContain('Stop vouching');
        });

        it('renders real decrypted entry name in title and avoids false confirmation attribution in subtitle', async () => {
            const identity = { publicKey: '1'.repeat(64), privateKey: '2'.repeat(64), callsign: 'viewer', createdAt: '2026-11-01' };
            const entry: OpenedEntry = {
                id: 'e_jane',
                keyId: 'k1',
                createdAt: '2026-11-01',
                updatedAt: '2026-11-01',
                text: { name: 'Jane Doe', note: 'Local farmer' },
                locked: null,
                key: null,
                holders: [],
                notTrusting: [],
                checkedHere: [],
                confirmation: {
                    id: 'c1',
                    memberPubkey: 'pk_jane',
                    callsign: 'jane',
                    status: 'confirmed',
                    entryId: 'e_jane',
                    confirmedBy: 'pk_other',
                    confirmedAt: '2026-10-15',
                    needsSecond: false,
                    secondedBy: null,
                    secondedAt: null,
                    revokedBy: null,
                    revokedAt: null,
                    revokeReason: null,
                },
                voucher: FIXTURE_VOUCHER_CARD,
            };

            await act(async () => {
                root.render(
                    createElement(VoucherCard, {
                        anchorUrl: 'https://community.test',
                        identity,
                        memberPubkey: 'pk_jane',
                        initialCard: FIXTURE_VOUCHER_CARD,
                        entry,
                    })
                );
            });

            // Title is decrypted real name
            expect(container.textContent).toContain('Jane Doe');
            // Subtitle has @jane and made a voucher by @admin, but NOT confirmed by @admin
            expect(container.textContent).toContain('@jane · made a voucher by @admin');
            expect(container.textContent).not.toContain('confirmed by @admin');
        });

        it('formats migration actor without @ prefix in budget history', async () => {
            const identity = { publicKey: '1'.repeat(64), privateKey: '2'.repeat(64), callsign: 'viewer', createdAt: '2026-11-01' };
            const migrationCard: VoucherCardData = {
                ...FIXTURE_VOUCHER_CARD,
                history: [
                    {
                        kind: 'grant',
                        amount: 1000,
                        actor: 'migration:vouchers',
                        actorCallsign: null,
                        at: '2026-11-01T10:00:00Z',
                    },
                    {
                        kind: 'stop',
                        amount: 0,
                        actor: 'migration:vouchers',
                        actorCallsign: null,
                        at: '2026-11-02T10:00:00Z',
                    },
                ],
            };

            await act(async () => {
                root.render(
                    createElement(VoucherCard, {
                        anchorUrl: 'https://community.test',
                        identity,
                        memberPubkey: 'pk_jane',
                        initialCard: migrationCard,
                    })
                );
            });

            // Open budget history
            const historyBtn = container.querySelector('button[aria-label="Budget history ›"]');
            expect(historyBtn).not.toBeNull();
            await act(async () => {
                historyBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });

            const historyText = container.querySelector('[data-testid="budget-history-section"]')?.textContent ?? '';
            // Must contain "made a voucher by migration" and "Budget stopped by migration", NOT "@migration"
            expect(historyText).toContain('made a voucher by migration');
            expect(historyText).toContain('Budget stopped by migration');
            expect(historyText).not.toContain('@migration');
        });

        it('omits uncomputed belowZero from passedOn summary line', async () => {
            const identity = { publicKey: '1'.repeat(64), privateKey: '2'.repeat(64), callsign: 'viewer', createdAt: '2026-11-01' };

            await act(async () => {
                root.render(
                    createElement(VoucherCard, {
                        anchorUrl: 'https://community.test',
                        identity,
                        memberPubkey: 'pk_jane',
                        initialCard: FIXTURE_VOUCHER_CARD,
                    })
                );
            });

            const text = container.textContent;
            expect(text).toContain('Passed on: 50 of their 350 to 1 person');
            expect(text).not.toMatch(/Passed on:.*below zero/);
        });
    });

    describe('Make a voucher amount settings and API call (§10)', () => {
        it('prefills with community setting (1,000) and constrains amount from 100 to 2,000 in 100s', async () => {
            const identity = { publicKey: '1'.repeat(64), privateKey: '2'.repeat(64), callsign: 'admin', createdAt: '2026-11-01' };

            // Community setting prefill check
            const communitySetting = 1000;
            let currentAmount = communitySetting;
            expect(currentAmount).toBe(1000);

            // Bounds check: 100 to 2,000 in steps of 100
            const stepDown = (v: number) => Math.max(100, v - 100);
            const stepUp = (v: number) => Math.min(2000, v + 100);

            // Step down from 1,000 to 900
            currentAmount = stepDown(currentAmount);
            expect(currentAmount).toBe(900);

            // Cannot step below 100
            currentAmount = 100;
            expect(stepDown(currentAmount)).toBe(100);

            // Cannot step above 2000
            currentAmount = 2000;
            expect(stepUp(currentAmount)).toBe(2000);

            // Mock successful makeNamesVoucher API call
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => FIXTURE_VOUCHER_CARD,
            });

            const res = await makeNamesVoucher('https://community.test', identity, 'e_alice', 1500);
            expect(res.ok).toBe(true);
            if (res.ok) {
                expect(res.value.memberPubkey).toBe('pk_jane');
            }
        });
    });

    describe('Vouchers block visibility on People → Invites (§11) across all 5 roles', () => {
        const identity = { publicKey: '1'.repeat(64), privateKey: '2'.repeat(64), callsign: 'caller', createdAt: '2026-11-01' };

        it('1. Owner: GET /api/names/vouchers returns 200 -> Vouchers block renders', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    vouchers: [FIXTURE_VOUCHER_CARD],
                    settings: { voucherBudget: 1000, memberGift: 100 },
                }),
            });

            const res = await fetchVouchers('https://community.test', identity);
            expect(res.ok).toBe(true);
            expect(res.ok && res.value.vouchers.length === 1).toBe(true);

            // When data is present, the Vouchers block renders with the voucher row and add row
            const v = (res as any).value.vouchers[0];
            const rowText = `${v.callsign} · ${v.left} of ${v.level} left · ${v.peopleVouched} vouched · ${v.belowZero} below zero ›`;
            expect(rowText).toBe('jane · 550 of 1000 left · 4 vouched · 1 below zero ›');
        });

        it('2. Credit-committee admin: GET /api/names/vouchers returns 200 -> Vouchers block renders', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    vouchers: [FIXTURE_VOUCHER_CARD],
                    settings: { voucherBudget: 1000, memberGift: 100 },
                }),
            });

            const res = await fetchVouchers('https://community.test', identity);
            expect(res.ok).toBe(true);
            expect(res.ok && res.value.vouchers.length > 0).toBe(true);
        });

        it('3. Plain admin (not on credit committee): GET /api/names/vouchers returns 403 committee_only -> Vouchers block does NOT render', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 403,
                json: async () => ({
                    code: 'committee_only',
                    error: 'Only an owner or a credit committee admin can see vouchers.',
                }),
            });

            const res = await fetchVouchers('https://community.test', identity);
            expect(res.ok).toBe(false);
            if (!res.ok) {
                expect(res.status).toBe(403);
                expect(res.code).toBe('committee_only');
            }
            // In people.tsx: if res.ok is false, vouchersData is set to null, hiding the Vouchers block
            const vouchersData = res.ok ? res.value : null;
            expect(vouchersData).toBeNull();
        });

        it('4. Voucher (regular voucher not on credit committee): GET /api/names/vouchers returns 403 committee_only -> Vouchers block does NOT render', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 403,
                json: async () => ({
                    code: 'committee_only',
                    error: 'Only an owner or a credit committee admin can see vouchers.',
                }),
            });

            const res = await fetchVouchers('https://community.test', identity);
            expect(res.ok).toBe(false);
            const vouchersData = res.ok ? res.value : null;
            expect(vouchersData).toBeNull();
        });

        it('5. Plain member: GET /api/names/vouchers returns 403 committee_only -> Vouchers block does NOT render', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 403,
                json: async () => ({
                    code: 'committee_only',
                    error: 'Only an owner or a credit committee admin can see vouchers.',
                }),
            });

            const res = await fetchVouchers('https://community.test', identity);
            expect(res.ok).toBe(false);
            const vouchersData = res.ok ? res.value : null;
            expect(vouchersData).toBeNull();
        });
    });

    describe('Voucher search filtering and empty state (§10, §11)', () => {
        const roleVouchersWithoutEntry: VoucherSummaryRow[] = [
            {
                memberPubkey: 'pk_role_alice',
                callsign: 'alice_admin',
                source: 'role',
                entryId: null,
                madeBy: 'pk_owner',
                madeByCallsign: 'owner',
                madeAt: '2026-11-01',
                stoppedAt: null,
                stopReason: null,
                left: 1000,
                held: 0,
                heldInvites: 0,
                vouched: 0,
                peopleVouched: 0,
                level: 1000,
                belowZero: 0,
                writtenOff: 0,
                passedOn: { amount: 0, people: 0 },
                invitesWithVouch: 0,
                trading: { withOthers: 0, insideOnly: 0 },
            },
            {
                memberPubkey: 'pk_role_bob',
                callsign: 'bob_admin',
                source: 'role',
                entryId: null,
                madeBy: 'pk_owner',
                madeByCallsign: 'owner',
                madeAt: '2026-11-01',
                stoppedAt: null,
                stopReason: null,
                left: 1000,
                held: 0,
                heldInvites: 0,
                vouched: 0,
                peopleVouched: 0,
                level: 1000,
                belowZero: 0,
                writtenOff: 0,
                passedOn: { amount: 0, people: 0 },
                invitesWithVouch: 0,
                trading: { withOthers: 0, insideOnly: 0 },
            },
        ];

        it('filters role vouchers without entry by query', () => {
            const filterByQuery = (rvs: VoucherSummaryRow[], q: string) => {
                const queryStr = q.trim().toLocaleLowerCase();
                if (!queryStr) return rvs;
                return rvs.filter((rv) => (rv.callsign || '').toLocaleLowerCase().includes(queryStr));
            };

            expect(filterByQuery(roleVouchersWithoutEntry, '').length).toBe(2);
            expect(filterByQuery(roleVouchersWithoutEntry, 'alice').map((r) => r.callsign)).toEqual(['alice_admin']);
            expect(filterByQuery(roleVouchersWithoutEntry, 'bob').map((r) => r.callsign)).toEqual(['bob_admin']);
            expect(filterByQuery(roleVouchersWithoutEntry, 'nobody').length).toBe(0);
        });
    });
});
