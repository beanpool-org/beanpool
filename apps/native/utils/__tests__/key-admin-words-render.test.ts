// @vitest-environment jsdom
/**
 * The names list (app/names-list.tsx) and claiming a community (app/claim-community.tsx) in the member's language
 * (words S3, sweep B10), rendered for real inside the real LanguageProvider with React Native's host components as plain
 * tags (key-words-harness.ts). The names list's opening, its keys and its signed requests are stubbed at the screen's own
 * imports (utils/names-list.ts, names-debts.ts, names-invite.ts): the list arrives opened, with two entries; the claim's
 * server answers what each test says.
 *
 * In the pseudo-locale any text, label, hint, placeholder or alert with letters outside a bracket bypassed t(). Shown as
 * written: members' callsigns, the names and notes admins typed, a community's name and address, codes. Named here with
 * why, the lines the list's lower layers write that stay English (they hold the list's keys or sign its requests; the PR
 * lists them): an entry this phone can't open (NAMES_COPY.lockedEntry), and Community health's own rows
 * (community-health.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = ReactAll;

const alerts = vi.hoisted(() => ({ said: [] as string[], buttons: [] as Array<{ text?: string; onPress?: () => unknown }> }));
vi.mock('react-native', async () => {
    const native = (await import('./key-words-harness')).nativeMock(alerts);
    // The alert's buttons too, so a test can press one.
    const alert = native.Alert.alert;
    native.Alert.alert = (title: string, body?: string, buttons?: Array<{ text?: string; onPress?: () => unknown }>) => {
        alerts.buttons = buttons ?? [];
        alert(title, body, buttons);
    };
    return native;
});
const nav = vi.hoisted(() => ({ params: {} as Record<string, string | undefined> }));
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    const r = { replace() {}, push() {}, back() {}, canGoBack: () => true, navigate() {} };
    return {
        router: r, useRouter: () => r,
        useLocalSearchParams: () => nav.params,
        useFocusEffect: (cb: () => void | (() => void)) => useEffect(() => cb(), [cb]),
        ErrorBoundary: () => null,
    };
});
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
const camera = vi.hoisted(() => ({ onScanned: null as null | ((r: { data: string }) => void), granted: true }));
vi.mock('expo-camera', async () => {
    const { createElement: h } = await import('react');
    return {
        useCameraPermissions: () => [{ granted: camera.granted, canAskAgain: true }, async () => ({ granted: camera.granted })],
        CameraView: ({ onBarcodeScanned }: { onBarcodeScanned?: (r: { data: string }) => void }) => { camera.onScanned = onBarcodeScanned ?? null; return h('div'); },
    };
});
vi.mock('react-native-qrcode-svg', async () => {
    const { createElement: h } = await import('react');
    return { default: () => h('div', { 'data-qr': 'true' }) };
});
vi.mock('react-native-safe-area-context', async () => {
    const { createElement: h } = await import('react');
    return { useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }), SafeAreaView: ({ children }: { children?: unknown }) => h('div', null, children as any) };
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
const ME = 'a'.repeat(64);
// One object, as the provider keeps it: the screens read again whenever it changes.
const who = vi.hoisted(() => ({ identity: { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(64), callsign: 'Sally' }, setIdentity() {} }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => who }));
vi.mock('expo-clipboard', () => ({ getStringAsync: async () => '' }));
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)), randomUUID: () => 'uuid' };
});
vi.mock('expo-local-authentication', () => ({
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    hasHardwareAsync: async () => false, isEnrolledAsync: async () => false, getEnrolledLevelAsync: async () => 0,
    authenticateAsync: async () => ({ success: false }),
}));
vi.mock('../node-post', () => ({ anchorUrl: async () => 'https://mullum.example' }));
vi.mock('../community-switch', () => ({ communitySwitched: () => {} }));
const MEMBERS = [{ publicKey: 'c'.repeat(64), callsign: 'Bea' }];
vi.mock('../db', () => ({ getAllCommunityMembers: async () => MEMBERS, createDecision: async () => ({}), closeDB: async () => {}, initDB: async () => {} }));

// ── The names list, opened: three admins (this phone, Wren whom it trusts, Ash whom it hasn't checked), two entries ──
const WREN = 'd'.repeat(64);
const ASH = 'e'.repeat(64);
const entry = (over: Record<string, unknown>) => ({
    id: 'e1', keyId: 'k3', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', text: null, locked: null,
    key: { n: 3, maker: WREN }, holders: [], notTrusting: [], checkedHere: [], confirmation: null, ...over,
});
const ENTRIES = [
    entry({ id: 'e1', text: { name: 'Mary Smith', note: 'From the seed swap' } }),
    entry({ id: 'e2', locked: 'no_key', key: { n: 2, maker: WREN }, holders: ['Wren'] }),
];
const names = vi.hoisted(() => ({ notices: [] as string[] }));
vi.mock('../names-list', async (importOriginal) => {
    const real = await importOriginal<typeof import('../names-list')>();
    const opened = () => ({
        state: {
            admins: [
                { pubkey: ME, callsign: 'Sally', role: 'owner', keyIds: ['k3'], holdsCurrent: true },
                { pubkey: WREN, callsign: 'Wren', role: 'admin', keyIds: ['k3'], holdsCurrent: true },
                { pubkey: ASH, callsign: 'Ash', role: 'admin', keyIds: [], holdsCurrent: false },
            ],
            callsigns: {},
            settings: { twoAdminsToConfirm: true, namesShownToMembers: false },
            counts: { entries: 2, confirmed: 1, awaitingSecond: 1, byKey: {}, locked: 1 },
            me: { pubkey: ME, role: 'owner', owner: true },
        },
        plan: { kind: 'ready' },
        pin: { trusted: [WREN], chain: [{ id: 'k3', n: 3 }] },
        ring: {}, generations: new Map(),
        list: { current: null, entries: [], confirmations: [] },
        notices: names.notices, made: null, sentTo: [], toCheck: [],
    });
    return {
        ...real,
        openNamesList: async () => ({ ok: true, value: opened() }),
        fetchNamesLog: async () => ({ ok: true, value: { log: [] } }),
        readBoundInvites: async () => ({ ok: true, value: { invites: [] } }),
        openEntries: () => ENTRIES,
        confirmableMembers: () => MEMBERS,
        unkeptRemovalsOf: () => [],
        // Community health got no answer: names-list.ts call()'s own words for that.
        fetchHealthSummary: async () => ({ ok: false, status: 0, code: null, message: real.UNREACHABLE }),
        fetchHealthExceptions: async () => ({ ok: false, status: 0, code: null, message: real.UNREACHABLE }),
        fetchHealthLog: async () => ({ ok: false, status: 0, code: null, message: real.UNREACHABLE }),
    };
});
vi.mock('../names-debts', async (importOriginal) => ({ ...(await importOriginal<typeof import('../names-debts')>()), fetchNamesDebts: async () => ({ ok: true, value: [] }) }));
vi.mock('../names-invite', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../names-invite')>()),
    inviteThisPerson: async () => ({ ok: true, code: 'ABCD-1234', offline: false }),
}));
vi.mock('../member-statements', () => ({ makeOfflineTicket: async () => 'ticket' }));

// ── Claiming: the server's answers ────────────────────────────────────────────────────────────────────────────────
const claim = vi.hoisted(() => ({ status: null as any, outcome: { kind: 'owner' } as any, member: true }));
vi.mock('../membership-probe', () => ({ fetchMembership: async () => new Response(JSON.stringify({ isMember: claim.member }), { status: 200 }) }));
vi.mock('../../components/useManageNode', () => ({ useManageNode: () => ({ start() {}, busy: false, dialog: null }) }));
const lock = vi.hoisted(() => ({ prompts: [] as Array<string | undefined> }));
vi.mock('../node-admin', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../node-admin')>()),
    requireDeviceUnlock: async (_name: string, prompt?: string) => { lock.prompts.push(prompt); return 'ok'; },
}));
vi.mock('../node-claim', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../node-claim')>()),
    readClaimStatus: async () => claim.status,
    readNodeAddresses: async () => ['beans.example.org'],
    claimCommunity: async () => claim.outcome,
    // The claim the screen sends (utils/claim-key.ts claimWithKey), with what the node said to it.
    claimAndHear: async () => ({ outcome: claim.outcome, heard: 'refused' }),
}));

import { pseudoLocalise, setLanguage, type UiLang } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import NamesListScreen from '../../app/names-list';
import ClaimCommunityScreen from '../../app/claim-community';
import { NAMES_COPY, UNREACHABLE } from '../names-list';
import { HEALTH_COPY, healthLogSections } from '../community-health';
import { bypassing, unfit } from './key-words-harness';

/** Callsigns, what admins typed, a community's name and address, codes: shown as written. */
const WRITTEN = ['Sally', 'Wren', 'Ash', 'Bea', 'Mary Smith', 'From the seed swap', 'Beans Town', 'https://beans.example.org', 'beans.example.org',
    'ABCD-1234', 'claim-', 'xxxx-xxxx-xxxx-xxxx', '0000 0000 0000 0000 0000', 'https://mullum.example'];
/** names-list.ts's sentence for an entry this phone can't open: it carries names and counts in English grammar, stays English. */
const LOCKED = NAMES_COPY.lockedEntry(2, 'Wren', ['Wren'], [], []);

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    alerts.said.length = 0;
    alerts.buttons = [];
    nav.params = {};
    names.notices = [];
    store.map.clear();
    claim.member = true;
    claim.outcome = { kind: 'owner' };
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async () => { for (let i = 0; i < 12; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderIn(lang: UiLang, Screen: () => unknown) {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, createElement(Screen as any)) as any); });
    await settle();
}
const click = async (el: Element | null | undefined, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle();
};
/** A button whose words are exactly this English in the pseudo-locale (a sentence, or a FILLED one with its names). */
const buttonSaying = (said: string) => Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '') === said) ?? null;
const buttonWith = (english: string) => Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(pseudoLocalise(english))) ?? null;
async function type(into: Element | null, value: string) {
    expect(into, 'the field').toBeTruthy();
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(into, value);
        into!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
}
const at = (english: string, values: Record<string, string>) => Object.entries(values).reduce((s, [k, v]) => s.split(`{${k}}`).join(v), pseudoLocalise(english));

describe('the names list in the pseudo-locale', () => {
    it('the list: who can read it, the admins\' buttons, the entries, the counts, the owners\' setting, a notice', async () => {
        names.notices = [NAMES_COPY.copyNotSaved];
        await renderIn('xx', NamesListScreen);
        expect(host.querySelector('[role="heading"]')?.textContent).toBe(pseudoLocalise(NAMES_COPY.title));
        expect(host.textContent).toContain(pseudoLocalise(NAMES_COPY.copyNotSaved));
        expect(buttonSaying(at('Send the keys to {who} again', { who: '@Wren' }))).not.toBeNull();
        expect(buttonSaying(at('Check {who}’s code', { who: '@Ash' }))).not.toBeNull();
        expect(host.textContent).toContain(pseudoLocalise('{n} entries').replace('{n}', '2'));
        expect(bypassing(host, [...WRITTEN, LOCKED], alerts.said)).toEqual([]);
        // 320 - 2 × 16 (the scroll) - 2 × 12 (an entry's card).
        expect(unfit(host, 320 - 32 - 24, WRITTEN)).toEqual([]);
    });

    it('adding a name, and deleting an entry asks first', async () => {
        await renderIn('xx', NamesListScreen);
        await click(buttonWith('Add a name'), 'Add a name');
        expect(host.textContent).toContain(pseudoLocalise('A name and a short note only: no address, date of birth or ID number. Sealed on this phone before it’s sent.'));
        expect(bypassing(host, [...WRITTEN, LOCKED], alerts.said)).toEqual([]);
        await click(buttonWith('Cancel'), 'Cancel');
        await click(buttonWith('Change'), 'Change');
        await click(buttonWith('Delete this entry'), 'Delete this entry');
        expect(alerts.said).toEqual([pseudoLocalise('Delete this entry?'), pseudoLocalise('It goes from the list for every admin. Your paper copy, if you keep one, is yours to update.'),
            pseudoLocalise('Cancel'), pseudoLocalise('Delete')]);
        expect(bypassing(host, [...WRITTEN, LOCKED], alerts.said)).toEqual([]);
    });

    it('confirming a member, inviting a person, and its share', async () => {
        await renderIn('xx', NamesListScreen);
        await click(buttonWith('Confirm a member'), 'Confirm a member');
        expect(host.textContent).toContain(at('Which member is {name}? Confirm only someone you know is them.', { name: 'Mary Smith' }));
        expect(host.querySelector(`[aria-label="${at('Confirm @{member} as {name}', { member: 'Bea', name: 'Mary Smith' })}"]`)).not.toBeNull();
        expect(bypassing(host, [...WRITTEN, LOCKED], alerts.said)).toEqual([]);
        await click(host.querySelector(`[aria-label="${pseudoLocalise('Back to the list')}"]`), 'Back');
        await click(buttonWith('Invite this person'), 'Invite this person');
        expect(host.textContent).toContain(at('Invite {name}', { name: 'Mary Smith' }));
        await click(buttonWith('Share'), 'Share');
        expect(alerts.said.at(-1)).toContain('ABCD-1234');
        expect(bypassing(host, [...WRITTEN, LOCKED], alerts.said)).toEqual([]);
    });

    it('checking an admin: why, this phone\'s key, the code box; and removing one\'s old key asks first', async () => {
        await renderIn('xx', NamesListScreen);
        await click(buttonSaying(at('Check {who}’s code', { who: '@Ash' })), 'Check @Ash');
        expect(host.textContent).toContain(at(NAMES_COPY.checkIntro('{who}').split('@{who}').join('{who}'), { who: '@Ash' }));
        expect(host.textContent).toContain(pseudoLocalise(NAMES_COPY.myKeyTitle));
        expect(bypassing(host, [...WRITTEN, LOCKED], alerts.said)).toEqual([]);
        expect(unfit(host, 320 - 32 - 24, WRITTEN)).toEqual([]);
        await click(host.querySelector(`[aria-label="${pseudoLocalise('Back to the list')}"]`), 'Back');
        await click(buttonSaying(at('Remove {who}’s old key', { who: '@Wren' })), 'Remove @Wren');
        expect(alerts.said[0]).toBe(at('Remove {who}’s old key?', { who: '@Wren' }));
        expect(bypassing(host, [...WRITTEN, LOCKED], alerts.said)).toEqual([]);
    });

    it('Community health: its own words through t(), and no answer in them too; the rows community-health.ts writes stay English, named here', async () => {
        await renderIn('xx', NamesListScreen);
        await click(buttonWith('Community health'), 'Community health');
        expect(host.textContent).toContain(pseudoLocalise(HEALTH_COPY.totalsHeading));
        // The exceptions got no answer: the banner says so in the member's language (exceptionsFailureText gives UNREACHABLE).
        expect(host.textContent).toContain(pseudoLocalise(UNREACHABLE));
        const sections = healthLogSections(null, 'unreadable');
        const english = [sections.balance, sections.trades].flatMap((s) => [s.heading, s.hint, s.empty]);
        expect(bypassing(host, [...WRITTEN, LOCKED, ...english], alerts.said)).toEqual([]);
    });
});

describe('claiming a community in the pseudo-locale', () => {
    const ORIGIN = 'https://beans.example.org';

    it('no server yet: scan or type its address, and an address it won\'t use', async () => {
        await renderIn('xx', ClaimCommunityScreen);
        expect(host.querySelector('[role="heading"]')?.textContent).toBe(pseudoLocalise('Claim a community').toLocaleUpperCase());
        expect(bypassing(host, WRITTEN, alerts.said)).toEqual([]);
        expect(unfit(host, 320 - 32, WRITTEN)).toEqual([]);
    });

    it('a server with no owner: the code box and its hint, a name to give, and a claim the network braked', async () => {
        nav.params = { node: ORIGIN };
        claim.status = { kind: 'unclaimed', codeId: '0a1b2c3d', salt: '00'.repeat(32), communityName: 'Beans Town' };
        claim.member = false;
        claim.outcome = { kind: 'braked', retryAfter: 30 };
        await renderIn('xx', ClaimCommunityScreen);
        expect(host.textContent).toContain(at('Claim {name}', { name: 'Beans Town' }));
        expect(bypassing(host, WRITTEN, alerts.said)).toEqual([]);
        expect(unfit(host, 320 - 32, WRITTEN)).toEqual([]);
        await type(host.querySelector(`[aria-label="${pseudoLocalise('Claim code')}"]`), 'a1b2c3d4e5f67890');
        await type(host.querySelector(`[aria-label="${pseudoLocalise('Your callsign')}"]`), 'Sally');
        lock.prompts.length = 0;
        await click(buttonWith('Claim and become owner'), 'Claim');
        // The phone's lock asks in the member's language, by the community's name.
        expect(lock.prompts).toEqual([at("Confirm it's you to manage {name}", { name: 'Beans Town' })]);
        expect(host.textContent).toContain(pseudoLocalise('Too many tries from this network. Wait {n} seconds and try again.').replace('{n}', '30'));
        expect(bypassing(host, WRITTEN, alerts.said)).toEqual([]);
    });

    it('owned already, busy, can\'t be reached, and claimed', async () => {
        nav.params = { node: ORIGIN };
        for (const status of [{ kind: 'claimed' }, { kind: 'busy', retryAfter: 20 }, { kind: 'unreachable', message: "That address doesn't answer like a BeanPool server." }]) {
            claim.status = status;
            act(() => root.unmount());
            root = createRoot(host);
            await renderIn('xx', ClaimCommunityScreen);
            expect(bypassing(host, WRITTEN, alerts.said), status.kind).toEqual([]);
        }
        expect(host.textContent).toContain(pseudoLocalise("That address doesn't answer like a BeanPool server."));
    });
});
