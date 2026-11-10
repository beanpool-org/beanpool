// @vitest-environment jsdom
/**
 * The names list with vouchers (slice V2; DESIGN-invites-and-names-list-amend2-fable.md §2, §5, Marty's §10), the whole
 * screen (app/names-list.tsx) rendered for real with the recipe of key-admin-words-render.test.ts. Only the list's opening
 * (its keys, pin and sealed history: openNamesList) is stubbed, handing the screen a list sealed with a real key, so the real
 * openEntries opens and sorts it. The vouchers come from the network: a small fake node answers GET /api/names/vouchers,
 * POST /api/names/vouchers and a voucher's card as routes/names-list.ts and engine/vouchers.ts do, by who signed: owners
 * and credit-committee admins get the block, a plain admin gets 403 committee_only, and anyone who isn't an owner or admin
 * gets 403 admins_only (and the list itself refused, as the node refuses it).
 *
 * Which check fails if the screen's committee gate goes: names-list.tsx offers Make a voucher only through
 * `canMakeVoucher(e, isCommittee, …)`, with `isCommittee = voucherBlock !== null` (the node's answer). Passing `true` for
 * either fails "a plain admin: the list opens, with no Make a voucher, no Voucher tags and no Vouchers filter".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = ReactAll;

const alerts = vi.hoisted(() => ({ said: [] as string[] }));
vi.mock('react-native', async () => (await import('./key-words-harness')).nativeMock(alerts));
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    const r = { replace() {}, push() {}, back() {}, canGoBack: () => true, navigate() {} };
    return {
        router: r, useRouter: () => r, useLocalSearchParams: () => ({}),
        useFocusEffect: (cb: () => void | (() => void)) => useEffect(() => cb(), [cb]),
        ErrorBoundary: () => null,
    };
});
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-camera', async () => {
    const { createElement: h } = await import('react');
    return { useCameraPermissions: () => [{ granted: true, canAskAgain: true }, async () => ({ granted: true })], CameraView: () => h('div') };
});
vi.mock('react-native-qrcode-svg', async () => {
    const { createElement: h } = await import('react');
    return { default: () => h('div', { 'data-qr': 'true' }) };
});
vi.mock('react-native-safe-area-context', async () => {
    const { createElement: h } = await import('react');
    return {
        useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
        SafeAreaView: ({ children, edges }: { children?: unknown; edges?: string[] }) => h('div', { 'data-safe-area': (edges ?? []).join(',') }, children as any),
    };
});
vi.mock('react-native-keyboard-controller', async () => {
    const { createElement: h } = await import('react');
    const pass = ({ children }: { children?: unknown }) => h('div', null, children as any);
    return { KeyboardAwareScrollView: pass, KeyboardStickyView: pass, KeyboardAvoidingView: pass };
});
vi.mock('@expo/vector-icons', async () => {
    const { createElement: h } = await import('react');
    return { MaterialCommunityIcons: ({ name }: { name: string }) => h('i', { 'data-icon': name }) };
});
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { colors: lightColors, theme: 'light' };
    return { useTheme: () => ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx) };
});
const who = vi.hoisted(() => ({ identity: { publicKey: 'a'.repeat(64), privateKey: 'f'.repeat(64), callsign: 'Sally' }, setIdentity() {} }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => who }));
vi.mock('expo-clipboard', () => ({ getStringAsync: async () => '' }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } }));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)), randomUUID: () => 'uuid' };
});
vi.mock('expo-local-authentication', () => ({
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    hasHardwareAsync: async () => false, isEnrolledAsync: async () => false, getEnrolledLevelAsync: async () => 0, authenticateAsync: async () => ({ success: false }),
}));
vi.mock('../node-post', () => ({ anchorUrl: async () => 'https://mullum.example' }));
vi.mock('../community-switch', () => ({ communitySwitched: () => {} }));
vi.mock('../db', () => ({ getAllCommunityMembers: async () => [], createDecision: async () => ({}), closeDB: async () => {}, initDB: async () => {} }));
// Who signed: the fake node reads it from this header, as the real one reads the signature's key.
vi.mock('../crypto', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../crypto')>()),
    buildSignedHeaders: async (_m: string, _u: string, _b: string, _priv: string, pub: string) => ({ 'X-Signer': pub }),
}));

/** What openNamesList hands the screen for the signer (set in beforeEach: a list sealed with a real key). */
const names = vi.hoisted(() => ({ opened: null as null | ((pubkey: string) => unknown) }));
vi.mock('../names-list', async (importOriginal) => {
    const real = await importOriginal<typeof import('../names-list')>();
    return {
        ...real,
        openNamesList: async (_url: string, identity: { publicKey: string }) => names.opened!(identity.publicKey),
        fetchNamesLog: async () => ({ ok: true, value: { log: [] } }),
        readBoundInvites: async () => ({ ok: true, value: { invites: [] } }),
        unkeptRemovalsOf: () => [],
        fetchHealthSummary: async () => ({ ok: false, status: 0, code: null, message: real.UNREACHABLE }),
        fetchHealthExceptions: async () => ({ ok: true, value: { settings: { debtLinePct: 50, quietDays: 30 }, exceptions: [], departed: [] } }),
        fetchHealthLog: async () => ({ ok: false, status: 0, code: null, message: real.UNREACHABLE }),
    };
});
vi.mock('../names-debts', async (importOriginal) => ({ ...(await importOriginal<typeof import('../names-debts')>()), fetchNamesDebts: async () => ({ ok: true, value: [] }) }));
vi.mock('../member-statements', () => ({ makeOfflineTicket: async () => 'ticket' }));
vi.mock('../membership-probe', () => ({ fetchMembership: async () => new Response(JSON.stringify({ isMember: true }), { status: 200 }) }));
vi.mock('../../components/useManageNode', () => ({ useManageNode: () => ({ start() {}, busy: false, dialog: null }) }));

import { newNamesListKey, sealNamesEntry } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import NamesListScreen from '../../app/names-list';

const NODE = 'https://mullum.example';
const key = (c: string) => c.repeat(64);
const PEOPLE = {
    owner: { publicKey: key('a'), callsign: 'Sally', role: 'owner', committee: true },
    committeeAdmin: { publicKey: key('b'), callsign: 'Wren', role: 'admin', committee: true },
    plainAdmin: { publicKey: key('c'), callsign: 'Ash', role: 'admin', committee: false },
    voucher: { publicKey: key('d'), callsign: 'zara', role: 'member', committee: false },
    member: { publicKey: key('e'), callsign: 'Bea', role: 'member', committee: false },
} as const;
type Who = keyof typeof PEOPLE;
const ADMINS = [PEOPLE.owner, PEOPLE.committeeAdmin, PEOPLE.plainAdmin];
const COMMITTEE_ONLY = 'Only an owner or an admin on the credit committee makes vouchers and sets their budgets.';
const ADMINS_ONLY = 'Only the community’s owners and admins can open the names list.';

// ── The list: five entries, sealed with one real key ──────────────────────────────────────────────────────────────
const KID = '9'.repeat(64);
const ID = { zara: '1'.repeat(32), ann: '2'.repeat(32), mary: '3'.repeat(32), sally: '4'.repeat(32), tom: '5'.repeat(32), ash: '6'.repeat(32) };
/** On for the one test that puts an admin's confirmed entry on the list (Ash, no budget: an admin made after I5 has none). */
let adminEntryOnList = false;
const conf = (id: string, entryId: string, memberPubkey: string, callsign: string, status = 'confirmed') => ({
    id, entryId, memberPubkey, callsign, status, confirmedBy: key('b'), confirmedAt: '2026-11-03T09:00:00Z', needsSecond: status === 'awaiting_second',
    secondedBy: null, secondedAt: null, revokedBy: null, revokedAt: null, revokeReason: null,
});
function sealedList(listKey: Uint8Array, withAdminEntry = false) {
    const entry = (id: string, name: string) => ({ id, keyId: KID, ciphertext: sealNamesEntry(listKey, id, KID, { name, note: '' }), createdBy: key('a'), createdAt: '2026-11-01T00:00:00.000Z', updatedBy: null, updatedAt: '' });
    return {
        current: null,
        entries: [entry(ID.zara, 'Zara Quinn'), entry(ID.ann, 'Ann Awaiting'), entry(ID.mary, 'Mary Smith'), entry(ID.sally, 'Sally Owner'), entry(ID.tom, 'Tom Unconfirmed'),
            ...(withAdminEntry ? [entry(ID.ash, 'Ash Admin')] : [])],
        confirmations: [
            conf('c1', ID.zara, PEOPLE.voucher.publicKey, 'zara'),
            conf('c2', ID.ann, key('7'), 'ann', 'awaiting_second'),
            conf('c3', ID.mary, PEOPLE.member.publicKey, 'Bea'),
            conf('c4', ID.sally, PEOPLE.owner.publicKey, 'Sally'),
            ...(withAdminEntry ? [conf('c5', ID.ash, PEOPLE.plainAdmin.publicKey, 'Ash')] : []),
        ],
    };
}
function openedFor(listKey: Uint8Array, me: (typeof PEOPLE)[Who]) {
    return {
        state: {
            admins: ADMINS.map((a) => ({ pubkey: a.publicKey, callsign: a.callsign, role: a.role, keyIds: [KID], holdsCurrent: true })),
            callsigns: {},
            settings: { twoAdminsToConfirm: false, namesShownToMembers: false },
            counts: { entries: 5, confirmed: 3, awaitingSecond: 1, byKey: {}, locked: 0 },
            me: { pubkey: me.publicKey, role: me.role, owner: me.role === 'owner' },
        },
        plan: { kind: 'ready' },
        pin: { me: me.publicKey, trusted: ADMINS.map((a) => a.publicKey).filter((k) => k !== me.publicKey), chain: [{ id: KID, n: 1 }], abandoned: [], communityId: 'mullum' },
        ring: { [KID]: listKey }, generations: new Map(),
        list: sealedList(listKey, adminEntryOnList),
        notices: [], made: null, sentTo: [], toCheck: [],
    };
}

/** The node's block (one voucher: Zara, made from her entry) and her card. Every figure is whole hundredths of a Bean, as the node sends them. */
const ZARA = {
    memberPubkey: PEOPLE.voucher.publicKey, callsign: 'zara', source: 'entry', entryId: ID.zara, madeBy: key('a'), madeByCallsign: 'Sally', madeAt: '2026-11-05T10:00:00Z',
    stoppedAt: null, stopReason: null, left: 55000, held: 10000, heldInvites: 1, vouched: 35000, peopleVouched: 4, level: 65000, belowZero: 1, writtenOff: 0,
    passedOn: { amount_c: 5000, people: 1, belowZero: 0 }, invitesWithVouch: 5, trading: { withOthers: 2, insideOnly: 1 },
};
const BLOCK = { vouchers: [ZARA], settings: { voucherBudget: 100000, memberGift: 10000, presets: [2500, 5000, 7500, 10000], vouchMax: 10000, vouchesPerPerson: 3, budgetMax: 200000 } };
const node = vi.hoisted(() => ({ calls: [] as Array<{ method: string; url: string; body: unknown }> }));
function fakeNode() {
    return vi.fn(async (url: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
        const u = String(url);
        const method = init?.method ?? 'GET';
        node.calls.push({ method, url: u, body: init?.body ? JSON.parse(init.body) : null });
        const signer = Object.values(PEOPLE).find((p) => p.publicKey === init?.headers?.['X-Signer']);
        const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
        if (!u.startsWith(`${NODE}/api/names/vouchers`)) return new Promise<Response>(() => {});
        if (!signer || (signer.role !== 'owner' && signer.role !== 'admin')) return json(403, { code: 'admins_only', error: ADMINS_ONLY });
        if (u === `${NODE}/api/names/vouchers` && method === 'GET') return signer.committee ? json(200, BLOCK) : json(403, { code: 'committee_only', error: COMMITTEE_ONLY });
        if (u === `${NODE}/api/names/vouchers` && method === 'POST') return signer.committee ? json(201, { ...ZARA, history: [], people: [] }) : json(403, { code: 'committee_only', error: COMMITTEE_ONLY });
        if (u === `${NODE}/api/names/vouchers/${encodeURIComponent(ZARA.memberPubkey)}`) return json(200, { ...ZARA, history: [], people: [], canChange: signer.committee });
        return json(404, { code: 'not_voucher', error: 'Not a voucher.' });
    }) as unknown as typeof fetch;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    alerts.said.length = 0;
    node.calls.length = 0;
    adminEntryOnList = false;
    const listKey = newNamesListKey();
    names.opened = (pubkey) => {
        const me = Object.values(PEOPLE).find((p) => p.publicKey === pubkey)!;
        if (me.role !== 'owner' && me.role !== 'admin') return { ok: false, status: 403, code: 'admins_only', message: ADMINS_ONLY };
        return { ok: true, value: openedFor(listKey, me) };
    };
    globalThis.fetch = fakeNode();
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 12; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderAs(w: Who) {
    const p = PEOPLE[w];
    who.identity = { publicKey: p.publicKey, privateKey: key('f'), callsign: p.callsign };
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, createElement(NamesListScreen as any)) as any); });
    await settle();
}
const buttons = (words: string) => Array.from(host.querySelectorAll('button')).filter((b) => (b.textContent ?? '').trim() === words);
const click = async (el: Element | null | undefined) => {
    expect(el).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle();
};
/** The names on the list, in the order the screen draws them. */
const namesInOrder = () => Array.from(host.querySelectorAll('span'))
    .map((s) => (s.textContent ?? '').trim())
    .filter((t) => ['Zara Quinn', 'Ann Awaiting', 'Mary Smith', 'Sally Owner', 'Tom Unconfirmed'].includes(t));
const askedForBlock = () => node.calls.some((c) => c.method === 'GET' && c.url === `${NODE}/api/names/vouchers`);

describe('the names list with vouchers, exactly as the node answers', () => {
    for (const w of ['owner', 'committeeAdmin'] as const) {
        it(`${w}: vouchers first with their tag, Make a voucher only on a complete confirmation that isn't theirs, the Vouchers filter`, async () => {
            await renderAs(w);
            expect(askedForBlock()).toBe(true);
            expect(namesInOrder()).toEqual(['Zara Quinn', 'Ann Awaiting', 'Mary Smith', 'Sally Owner', 'Tom Unconfirmed']);
            expect(host.textContent).toContain('550 of 650 left');
            expect(buttons('See voucher card ›')).toHaveLength(1);
            // One offer: Mary Smith's (Bea, confirmed). Not Zara (a voucher), Ann (waiting for a second admin), Tom
            // (unconfirmed), nor, for the owner, Sally's own entry.
            const offers = buttons('Make a voucher');
            expect(offers).toHaveLength(w === 'owner' ? 1 : 2);
            expect(buttons('Vouchers')).toHaveLength(1);
            expect(host.textContent).toContain('1 voucher');
        });
    }

    it('a plain admin: the list opens, with no Make a voucher, no Voucher tags and no Vouchers filter', async () => {
        await renderAs('plainAdmin');
        expect(askedForBlock()).toBe(true);
        // The list itself is open (sealed with the real key, opened by the real openEntries), by name.
        expect(namesInOrder()).toEqual(['Ann Awaiting', 'Mary Smith', 'Sally Owner', 'Tom Unconfirmed', 'Zara Quinn']);
        expect(buttons('Make a voucher')).toHaveLength(0);
        expect(buttons('See voucher card ›')).toHaveLength(0);
        expect(buttons('Vouchers')).toHaveLength(0);
        expect(host.textContent).not.toContain('550 of 650 left');
        expect(host.textContent).not.toMatch(/\d+ vouchers?\b/);
    });

    // Only an owner makes an admin a voucher (I5): the node answers a committee admin 403 owner_only, so the list doesn't offer it.
    it('an admin’s confirmed entry: Make a voucher is offered to an owner and not to a committee admin (the node would refuse them)', async () => {
        adminEntryOnList = true;
        await renderAs('owner');
        expect(host.textContent).toContain('Ash Admin');
        // Mary Smith (Bea) and Ash's: the owner may make either one.
        expect(buttons('Make a voucher')).toHaveLength(2);
        act(() => root.unmount());
        root = createRoot(host);
        await renderAs('committeeAdmin');
        expect(host.textContent).toContain('Ash Admin');
        // Mary Smith's and Sally's (an owner, who this fake node shows with no budget): not Ash's, an admin's.
        expect(buttons('Make a voucher')).toHaveLength(2);
    });

    for (const w of ['voucher', 'member'] as const) {
        it(`a voucher and a member: the node refuses the list and the block (${w}), and nothing of vouchers shows`, async () => {
            await renderAs(w);
            expect(host.textContent).toContain(ADMINS_ONLY);
            expect(buttons('Make a voucher')).toHaveLength(0);
            expect(buttons('Vouchers')).toHaveLength(0);
            expect(host.textContent).not.toContain('Zara Quinn');
        });
    }

    it('Make a voucher: prefilled from the community’s setting, stepped on the 100 grid, and the amount posted', async () => {
        await renderAs('owner');
        await click(buttons('Make a voucher')[0]);
        expect(host.textContent).toContain('Make @Bea a voucher?');
        // Figures from whole hundredths (formatHundredths): 1,000 and more grouped, as on the web.
        expect(host.textContent).toContain('1,000 Beans');
        await click(host.querySelector('[aria-label="Increase budget by 100"]'));
        expect(host.textContent).toContain('1,100 Beans');
        await click(buttons('Make a voucher').at(-1));
        const posted = node.calls.filter((c) => c.method === 'POST' && c.url === `${NODE}/api/names/vouchers`);
        // The budget is `amount_c`, whole hundredths (engine/vouchers.ts makeVoucher refuses the old `amount` with 400).
        expect(posted.map((c) => c.body)).toEqual([{ entryId: ID.mary, amount_c: 110000 }]);
        expect(host.textContent).toContain('Made @Bea a voucher with a budget of 1,100 Beans.');
    });

    it('Community health’s Vouchers section names each voucher by @callsign, also one the phone has no member row for', async () => {
        await renderAs('owner');
        await click(buttons('Community health')[0]);
        const heading = Array.from(host.querySelectorAll('span')).find((x) => (x.textContent ?? '') === 'VOUCHERS');
        expect(heading).toBeTruthy();
        const names = Array.from(host.querySelectorAll('span')).map((x) => (x.textContent ?? '').trim());
        expect(names).toContain('@zara');
        expect(names).not.toContain('zara');
    });

    it('a voucher’s card from the list: in the safe area, with who confirmed them (§5 second line)', async () => {
        await renderAs('committeeAdmin');
        await click(buttons('See voucher card ›')[0]);
        const modal = host.querySelector('[data-modal]');
        expect(modal).not.toBeNull();
        expect(modal!.querySelector('[data-safe-area*="top"]')).not.toBeNull();
        expect(modal!.textContent).toContain('Zara Quinn · Voucher');
        expect(modal!.textContent).toContain('@zara: confirmed by @Wren, 3 Nov · made a voucher by @Sally, 5 Nov');
        expect(modal!.textContent).toContain('Set budget to: 700');
    });
});
