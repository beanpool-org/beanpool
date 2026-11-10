// @vitest-environment jsdom
/**
 * Arriving at the names list from a member's profile (invites-vouching I4, fix round 1 of #3035): the whole screen
 * (app/names-list.tsx) rendered for real with the recipe of vouchers-names-list-render.test.ts, opened with the params the
 * profile's button sends. The profile's button can be a step behind the node, so the arrival checks what the list already
 * holds: a person who already has a live confirmation is never added a second time (that would seal a duplicate entry the node
 * refuses to confirm, 409 already_confirmed), and a Make that cannot open says why instead of showing the bare list.
 *
 * Which check fails if the guard goes: removing the `params.act === 'add' && mine?.confirmation` branch of names-list.tsx
 * opens the add form for Bea, who is confirmed already ("an add for someone already confirmed ...").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = ReactAll;

const alerts = vi.hoisted(() => ({ said: [] as string[] }));
/** What a member's profile sends the names list (app/names-list.tsx reads act, forMember and forCallsign). */
const arrival = vi.hoisted(() => ({ params: {} as Record<string, string> }));
vi.mock('react-native', async () => (await import('./key-words-harness')).nativeMock(alerts));
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    const r = { replace() {}, push() {}, back() {}, canGoBack: () => true, navigate() {} };
    return {
        router: r, useRouter: () => r, useLocalSearchParams: () => arrival.params,
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
const ID = { zara: '1'.repeat(32), ann: '2'.repeat(32), mary: '3'.repeat(32), sally: '4'.repeat(32), tom: '5'.repeat(32) };
const conf = (id: string, entryId: string, memberPubkey: string, callsign: string, status = 'confirmed') => ({
    id, entryId, memberPubkey, callsign, status, confirmedBy: key('b'), confirmedAt: '2026-11-03T09:00:00Z', needsSecond: status === 'awaiting_second',
    secondedBy: null, secondedAt: null, revokedBy: null, revokedAt: null, revokeReason: null,
});
function sealedList(listKey: Uint8Array) {
    const entry = (id: string, name: string) => ({ id, keyId: KID, ciphertext: sealNamesEntry(listKey, id, KID, { name, note: '' }), createdBy: key('a'), createdAt: '2026-11-01T00:00:00.000Z', updatedBy: null, updatedAt: '' });
    return {
        current: null,
        entries: [entry(ID.zara, 'Zara Quinn'), entry(ID.ann, 'Ann Awaiting'), entry(ID.mary, 'Mary Smith'), entry(ID.sally, 'Sally Owner'), entry(ID.tom, 'Tom Unconfirmed')],
        confirmations: [
            conf('c1', ID.zara, PEOPLE.voucher.publicKey, 'zara'),
            conf('c2', ID.ann, key('7'), 'ann', 'awaiting_second'),
            conf('c3', ID.mary, PEOPLE.member.publicKey, 'Bea'),
            conf('c4', ID.sally, PEOPLE.owner.publicKey, 'Sally'),
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
        list: sealedList(listKey),
        notices: [], made: null, sentTo: [], toCheck: [],
    };
}

/** The node's block (one voucher: Zara, made from her entry) and her card. */
const ZARA = {
    memberPubkey: PEOPLE.voucher.publicKey, callsign: 'zara', source: 'entry', entryId: ID.zara, madeBy: key('a'), madeByCallsign: 'Sally', madeAt: '2026-11-05T10:00:00Z',
    stoppedAt: null, stopReason: null, left: 550, held: 100, heldInvites: 1, vouched: 350, peopleVouched: 4, level: 650, belowZero: 1, writtenOff: 0,
    passedOn: { amount: 50, people: 1, belowZero: 0 }, invitesWithVouch: 5, trading: { withOthers: 2, insideOnly: 1 },
};
const BLOCK = { vouchers: [ZARA], settings: { voucherBudget: 1000, memberGift: 100, presets: [25, 50, 75, 100], vouchMax: 100, vouchesPerPerson: 3, budgetMax: 2000 } };
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

const shown = () => host.textContent ?? '';
async function arriveAs(w: Who, params: Record<string, string>) {
    arrival.params = params;
    await renderAs(w);
}
const BEA = PEOPLE.member.publicKey;
const NEW_PERSON = key('6');
const AWAITING = key('7');

describe('the names list, arrived at from a profile', () => {
    it('an add for someone not on the list opens the one-step form, the callsign as the name', async () => {
        await arriveAs('owner', { act: 'add', forMember: NEW_PERSON, forCallsign: 'Pia' });
        expect(shown()).toContain('Add and confirm @Pia');
        const input = host.querySelector('input') as HTMLInputElement | null;
        expect(input?.value).toBe('Pia');
    });

    it('an add for someone already confirmed (the profile’s button was a step behind) opens no form and says so', async () => {
        await arriveAs('owner', { act: 'add', forMember: BEA, forCallsign: 'Bea' });
        expect(shown()).not.toContain('Add and confirm @Bea');
        expect(shown()).toContain('@Bea is confirmed against Mary Smith.');
        // Nothing was sealed or posted for it: the screen made its reads and no write went out.
        expect(node.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    });

    it('an add for someone whose confirmation waits for a second admin is no add either', async () => {
        await arriveAs('owner', { act: 'add', forMember: AWAITING, forCallsign: 'ann' });
        expect(shown()).not.toContain('Add and confirm @ann');
        expect(shown()).toContain('@ann is confirmed against Ann Awaiting.');
    });

    it('make for a confirmed member opens Make a voucher for the committee', async () => {
        await arriveAs('committeeAdmin', { act: 'make', forMember: BEA, forCallsign: 'Bea' });
        expect(shown()).toContain('Make @Bea a voucher?');
    });

    it('make for someone who is a voucher already says so, and opens nothing', async () => {
        await arriveAs('owner', { act: 'make', forMember: PEOPLE.voucher.publicKey, forCallsign: 'zara' });
        expect(shown()).not.toContain('Make @zara a voucher?');
        expect(shown()).toContain('@zara is a voucher already.');
    });

    it('make for someone whose confirmation is not complete says why', async () => {
        await arriveAs('owner', { act: 'make', forMember: AWAITING, forCallsign: 'ann' });
        expect(shown()).toContain('@ann isn’t confirmed on this list yet, so there is no voucher to make.');
    });

    it('make for someone who is not on the list says why', async () => {
        await arriveAs('owner', { act: 'make', forMember: NEW_PERSON, forCallsign: 'Pia' });
        expect(shown()).toContain('@Pia isn’t confirmed on this list yet, so there is no voucher to make.');
    });

    it('make for a plain admin (off the credit committee) says who makes vouchers', async () => {
        await arriveAs('plainAdmin', { act: 'make', forMember: BEA, forCallsign: 'Bea' });
        expect(shown()).not.toContain('Make @Bea a voucher?');
        expect(shown()).toContain(COMMITTEE_ONLY);
    });
});
