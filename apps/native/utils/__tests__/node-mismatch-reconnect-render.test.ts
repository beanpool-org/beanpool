// @vitest-environment jsdom
/**
 * Damo's case (DESIGN-global-entry-fable.md §1, decision 4), the "This community doesn't recognise you" screen rendered
 * for real: a member of a local community, diverted here, types the global community's address into Reconnect. The
 * global community answers that this key is a stranger (it is: he never joined it).
 *
 * Before P1 the screen wrote the address as the phone's community BEFORE it asked, so the answer came too late: the phone
 * sat on the global community as a stranger, the saved list gained it unmarked (nodes.ts' auto-migration), and every
 * screen that read "in the list, not a guest" as "member" hid the door. Now the screen asks first, and a refusal leaves
 * the phone exactly where it was: the same community in use, the same saved list (read back from AsyncStorage). The
 * global community's door is open, so the screen offers Join with this account for it.
 *
 * Nothing is contacted: fetch answers the global community's membership probe and info only, and refuses anything else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// The screen doesn't import React (Metro's automatic JSX runtime); this runner compiles JSX the classic way.
(globalThis as any).React = ReactAll;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, value, onChangeText, disabled, testID, numberOfLines } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = numberOfLines;
        if (onPress) attrs.onClick = () => { if (!disabled) onPress({ stopPropagation() {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        SafeAreaView: el('div'), TouchableOpacity: el('button'),
        ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => s },
        Alert: { alert() {} },
        AppState: { addEventListener: listener, currentState: 'active' },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        Keyboard: { addListener: listener, dismiss() {} },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const nav = vi.hoisted(() => ({ replaced: [] as unknown[], pushed: [] as unknown[] }));
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    return {
        useRouter: () => ({ replace: (to: unknown) => nav.replaced.push(to), push: (to: unknown) => nav.pushed.push(to), back() {} }),
        router: { replace: (to: unknown) => nav.replaced.push(to), push: (to: unknown) => nav.pushed.push(to), back() {} },
        useFocusEffect: (cb: () => void | (() => void)) => useEffect(() => cb(), [cb]),
        ErrorBoundary: () => null,
    };
});
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-clipboard', () => ({ getStringAsync: async () => '', hasStringAsync: async () => false }));
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useOnboardingColors: () => ({ colors: lightColors, dark: false }),
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
const KEY = 'damo-real-member-key';
vi.mock('../../app/IdentityContext', () => ({
    useIdentity: () => ({ identity: { publicKey: KEY, privateKey: 'not-used', callsign: 'Damo' }, setIdentity() {} }),
}));
// The phone's recognition: the real one asks the community in use; here it reads where the phone is anchored now.
const recognition = vi.hoisted(() => ({ asked: 0, now: 'stranger' as 'stranger' | 'closed', nodeUrl: 'https://riverside.example' }));
vi.mock('../../app/NodeStatusContext', () => ({
    useNodeStatus: () => ({
        recognition: recognition.now,
        nodeUrl: recognition.nodeUrl,
        recheck: async () => {
            recognition.asked++;
            const anchor = store.map.get('beanpool_anchor_url');
            return anchor === 'https://global.beanpool.org' ? 'stranger' : 'unknown';
        },
    }),
}));
const dbCalls = vi.hoisted(() => ({ closed: 0, opened: 0 }));
vi.mock('../db', () => ({ closeDB: async () => { dbCalls.closed++; }, initDB: async () => { dbCalls.opened++; } }));
vi.mock('../../services/pillar-sync', () => ({ requestSync: async () => {} }));
vi.mock('../community-switch', () => ({ communitySwitched: () => {} }));
vi.mock('../crypto', () => ({ buildSignedHeaders: async () => ({ 'X-Test-Signed': '1' }) }));
vi.mock('../words-behind-lock', () => ({ readWordsBehindLock: async () => null }));
vi.mock('../words-put-away', () => ({ usePutAwayAfterLeave: () => {} }));
vi.mock('../LocalAuth', () => ({ authenticateUser: async () => false }));
vi.mock('../account-leaves-phone', () => ({ deleteAccountFromThisPhone: async () => {}, signOutOfThisPhone: async () => {} }));
vi.mock('../identity', () => ({ hasMnemonic: () => true, loadIdentity: async () => null }));
vi.mock('../delete-here', () => ({
    NO_OTHER_COMMUNITY_LINE: '', SIGN_OUT_FROM_SETTINGS_LINE: '', deletePlanFailedLine: () => '',
    otherCommunitiesKeeping: async () => [], stillKeptLine: () => '',
}));
vi.mock('../no-words-copy', () => ({ noWordsBeforeWipe: () => '' }));
// The phone's mark that global closed this key (global-join-existing.ts), as the hook and askGlobalStanding read it.
const closedMark = vi.hoisted(() => ({ on: false }));
vi.mock('../global-join-existing', () => ({
    isGlobalCommunity: (url: string | null | undefined) => !!url && url.trim().replace(/\/+$/, '').toLowerCase() === 'https://global.beanpool.org',
    accountClosedAtGlobal: async () => closedMark.on,
    rememberAccountClosed: async () => { closedMark.on = true; },
    forgetAccountClosed: async () => { closedMark.on = false; },
}));
const joins = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('../join-another-community', () => ({
    joinAnotherCommunity: async (opts: unknown) => { joins.calls.push(opts); throw new Error('not in this test'); },
    joinedNudge: () => ({ title: '', body: '', later: '' }), PROTECT_REDIRECT: '/', HOME_REDIRECT: '/',
}));
vi.mock('../../components/NoWordsNotice', () => ({ NoWordsNotice: () => null }));
vi.mock('../../components/WordsOnScreen', () => ({ NoScreenCapture: ({ children }: { children?: unknown }) => children, NoScreenLockNote: () => null }));

import NodeMismatchScreen from '../../app/node-mismatch';
import { getSavedNodes } from '../nodes';
import { SAVED_NODES_STORE_KEY } from '../storage-keys';

const LOCAL = 'https://riverside.example';
const GLOBAL = 'https://global.beanpool.org';
const asked: string[] = [];

/** The global community, open door, says this key is a stranger. Anything else: no answer. */
function globalSaysStranger() {
    return vi.fn(async (input: unknown) => {
        const u = String(input);
        asked.push(u);
        if (u === `${GLOBAL}/api/community/membership/${KEY}`) {
            return new Response(JSON.stringify({ isMember: false }), { status: 200 });
        }
        if (u === `${GLOBAL}/api/community/info`) {
            return new Response(JSON.stringify({
                name: 'Global community', profile: 'global',
                features: { openJoin: true, wordsDoor: true, door: 'open', invites: false, beans: false },
            }), { status: 200 });
        }
        throw new TypeError(`Network request failed: ${u}`);
    }) as typeof fetch;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    store.map.clear();
    asked.length = 0;
    nav.replaced.length = 0;
    nav.pushed.length = 0;
    recognition.asked = 0;
    recognition.now = 'stranger';
    recognition.nodeUrl = LOCAL;
    dbCalls.closed = 0;
    dbCalls.opened = 0;
    closedMark.on = false;
    // Damo's phone: a member of Riverside, the one community in its list, in use.
    store.map.set('beanpool_anchor_url', LOCAL);
    store.map.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: LOCAL, alias: 'Riverside', lastConnected: '2026-10-01T00:00:00.000Z' }]));
    globalThis.fetch = globalSaysStranger();
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => {}); };
const text = () => host.textContent ?? '';
const buttons = () => Array.from(host.querySelectorAll('button'));
const button = (label: string) => buttons().find(b => (b.getAttribute('aria-label') || b.textContent || '').trim() === label);

function type(into: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(into, value);
    into.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The address field: the one input on the screen (folded behind "Enter another address" where the page folds it). */
async function addressField(): Promise<HTMLInputElement> {
    let input = host.querySelector('input');
    if (!input) {
        const unfold = buttons().find(b => /another address/i.test(b.textContent ?? ''));
        if (unfold) { await act(async () => { unfold.click(); }); await settle(); }
        input = host.querySelector('input');
    }
    if (!input) throw new Error('no address field on the screen');
    return input;
}

describe("Damo's case: Reconnect to the global community, which says this key is a stranger", () => {
    it('leaves the phone where it was: the same community in use, the same saved list, no database swapped', async () => {
        await act(async () => { root.render(createElement(NodeMismatchScreen) as any); });
        await settle();

        await act(async () => { type(await addressField(), 'global.beanpool.org'); });
        await settle();
        const reconnect = button('Reconnect');
        expect(reconnect).toBeTruthy();
        await act(async () => { reconnect!.click(); });
        await settle();

        // Nothing moved: the community in use, the saved list as it was (as the next screen to read it sees it, after
        // nodes.ts' auto-migration of the anchor), no guest mark, no database swapped, no navigation.
        expect(store.map.get('beanpool_anchor_url')).toBe(LOCAL);
        expect((await getSavedNodes()).map(n => n.url)).toEqual([LOCAL]);
        expect(JSON.parse(store.map.get(SAVED_NODES_STORE_KEY)!).map((n: { url: string }) => n.url)).toEqual([LOCAL]);
        expect(store.map.get('beanpool_guest_nodes') ?? null).toBeNull();
        expect(dbCalls.closed).toBe(0);
        expect(dbCalls.opened).toBe(0);
        expect(nav.replaced).toEqual([]);
        // It was asked first, by the membership probe to the global community itself.
        expect(asked).toContain(`${GLOBAL}/api/community/membership/${KEY}`);
    });

    it("then offers the global community's open door for the account on this phone", async () => {
        await act(async () => { root.render(createElement(NodeMismatchScreen) as any); });
        await settle();
        await act(async () => { type(await addressField(), 'global.beanpool.org'); });
        await settle();
        await act(async () => { button('Reconnect')!.click(); });
        await settle();

        // Never "double-check the address": the address was right, the person just hasn't joined.
        expect(text()).not.toMatch(/Double-check the address/);
        const join = button('Join with this account');
        expect(join).toBeTruthy();
        await act(async () => { join!.click(); });
        await settle();
        expect(nav.pushed).toContain('/join-global');
        // Still nothing moved.
        expect(store.map.get('beanpool_anchor_url')).toBe(LOCAL);
    });
});

/** A fetch where the global community answers as given, and Riverside's info is `riverside` (null: no answer). */
function network(opts: { global: 'stranger' | 'unreachable'; riverside?: Record<string, unknown> | null }) {
    return vi.fn(async (input: unknown) => {
        const u = String(input);
        asked.push(u);
        if (u.startsWith(GLOBAL) && opts.global === 'unreachable') throw new TypeError(`Network request failed: ${u}`);
        if (u === `${LOCAL}/api/community/info` && opts.riverside) {
            return new Response(JSON.stringify(opts.riverside), { status: 200 });
        }
        return (globalSaysStranger() as any)(input);
    }) as typeof fetch;
}
const render = async () => { await act(async () => { root.render(createElement(NodeMismatchScreen) as any); }); await settle(); };
const globalRow = () => buttons().find(b => (b.getAttribute('aria-label') ?? '').startsWith('Global community, '));

describe("the not-recognised screen's pages (§C.1, §C.3)", () => {
    it('open: the phone is on the global community as a stranger → Join with this account first; no global row; the address folded', async () => {
        recognition.nodeUrl = GLOBAL;
        store.map.set('beanpool_anchor_url', GLOBAL);
        await render();
        expect(text()).toContain("You're not a member here yet");
        expect(text()).toContain('The global community lets anyone join. Your account is fine: join with it, or go back to one of your communities.');
        const all = buttons().map(b => (b.getAttribute('aria-label') || b.textContent || '').trim());
        expect(all.indexOf('Join with this account')).toBeGreaterThanOrEqual(0);
        expect(all.indexOf('Join with this account')).toBeLessThan(all.findIndex(l => /Delete this account/.test(l)));
        expect(globalRow()).toBeUndefined();
        expect(host.querySelector('input')).toBeNull();
        expect(text()).toContain('Not this community? Enter another address');
    });

    it('invite: a local community → the address field, an invite, and the global row by its state (door open: Join)', async () => {
        globalThis.fetch = network({ global: 'stranger', riverside: { profile: 'local', features: { invites: true } } });
        await render();
        expect(text()).toContain("This community doesn't recognise you");
        expect(text()).toContain("This usually means the address is wrong, or you haven't joined it yet.");
        expect(button('Reconnect')).toBeTruthy();
        expect(button('Paste an invite')).toBeTruthy();
        expect(globalRow()?.getAttribute('aria-label')).toBe('Global community, Join with this account: 12 words or a sign-in');
        expect(globalRow()!.textContent).toContain('Join with this account: 12 words or a sign-in');
        expect(globalRow()!.querySelector('[data-lines]')).toBeNull();
        await act(async () => { globalRow()!.click(); });
        expect(nav.pushed).toContain('/join-global');
    });

    it('invite, offline: the global row stays, saying it can\'t be reached (never hidden); everything else as before', async () => {
        globalThis.fetch = network({ global: 'unreachable' });
        await render();
        expect(globalRow()?.getAttribute('aria-label')).toBe("Global community, Can't reach it right now. Tap to try again.");
        // Its line is never clipped (PR #2098 review): at 320 dp and 1.3× it takes three or four lines here.
        expect(globalRow()!.querySelector('[data-lines]')).toBeNull();
        expect(button('Reconnect')).toBeTruthy();
        expect(button('Paste an invite')).toBeTruthy();
    });

    // PR #2098 review 4302678601: a vote can bring a removed member back. The phone's old mark must not beat global's
    // answer now, or a member reads "Your account there was closed."
    it("the global row: a key global once closed, brought back by a vote, now answered member → the member row, and the mark forgotten", async () => {
        closedMark.on = true;
        const riverside = network({ global: 'stranger', riverside: { profile: 'local', features: { invites: true } } });
        globalThis.fetch = vi.fn(async (input: unknown) => {
            const u = String(input);
            if (u === `${GLOBAL}/api/community/membership/${KEY}`) { asked.push(u); return new Response(JSON.stringify({ isMember: true }), { status: 200 }); }
            return (riverside as any)(input);
        }) as typeof fetch;
        await render();
        expect(globalRow()?.getAttribute('aria-label')).toBe('Global community, global.beanpool.org');
        expect(text()).not.toContain('Your account there was closed.');
        expect(closedMark.on).toBe(false);
    });

    it("preview: the community's own sentence, and the invite field for an owner's or admin's invite", async () => {
        globalThis.fetch = network({ global: 'stranger', riverside: { profile: 'local', features: { privatePreview: true } } });
        await render();
        expect(text()).toContain('This community is in a private preview. Ask its owner for an invite.');
        expect(text()).toContain('Got an invite from its owner or an admin?');
        expect(button('Join with this invite')).toBeTruthy();
    });

    it("closed: the community closed this key's account → told so by name, with the global row; no address field", async () => {
        recognition.now = 'closed';
        globalThis.fetch = network({ global: 'stranger', riverside: { profile: 'local', features: { invites: true } } });
        await render();
        expect(text()).toContain('Your account in Riverside was closed');
        expect(text()).toContain('You deleted it, or the community removed it. Your other communities are not affected.');
        expect(text()).not.toMatch(/trouble connecting|check your connection/i);
        expect(host.querySelector('input')).toBeNull();
        expect(globalRow()).toBeTruthy();
        expect(buttons().some(b => /Delete this account from this phone/.test(b.textContent ?? ''))).toBe(true);
    });

    // PR #2098 review, BLOCKING 4302678596: Delete account is the one request a community still takes from a closed key,
    // and the only way left to erase the profile a removal keeps. The closed page says so and leads there.
    it("closed: Delete my account at Riverside opens Settings' Delete account, for the community the phone is on", async () => {
        recognition.now = 'closed';
        globalThis.fetch = network({ global: 'stranger', riverside: { profile: 'local', features: { invites: true } } });
        await render();
        expect(text()).toContain('If Riverside removed you, it still keeps your profile, so a vote could bring you back. Deleting your account there erases it.');
        const all = buttons().map(b => (b.getAttribute('aria-label') || b.textContent || '').trim());
        const there = all.indexOf('Delete my account at Riverside');
        expect(there).toBeGreaterThanOrEqual(0);
        // The phone-only delete stays, last.
        expect(there).toBeLessThan(all.findIndex(l => /Delete this account from this phone/.test(l)));
        await act(async () => { button('Delete my account at Riverside')!.click(); });
        expect(nav.pushed).toEqual([{ pathname: '/(tabs)/settings', params: { section: 'delete' } }]);
        // Nothing moved: Settings deletes at the community the phone is on, which is Riverside.
        expect(store.map.get('beanpool_anchor_url')).toBe(LOCAL);
        expect(nav.replaced).toEqual([]);
    });

    it('no such button for a stranger: it has no account there to delete', async () => {
        globalThis.fetch = network({ global: 'stranger', riverside: { profile: 'local', features: { invites: true } } });
        await render();
        expect(text()).toContain("This community doesn't recognise you");
        expect(buttons().some(b => /Delete my account at/.test(b.textContent ?? ''))).toBe(false);
    });

    it("nor on a closed page about a community the phone is NOT on (Reconnect asked it): Delete account goes to the one in use", async () => {
        const ELSEWHERE = 'https://hilltop.example';
        globalThis.fetch = vi.fn(async (input: unknown) => {
            const u = String(input);
            asked.push(u);
            if (u === `${ELSEWHERE}/api/community/membership/${KEY}`) {
                return new Response(JSON.stringify({ error: 'closed', code: 'account_closed' }), { status: 403 });
            }
            if (u === `${ELSEWHERE}/api/community/info`) {
                return new Response(JSON.stringify({ name: 'Hilltop', profile: 'local', features: { invites: true } }), { status: 200 });
            }
            return (network({ global: 'stranger', riverside: { profile: 'local', features: { invites: true } } }) as any)(input);
        }) as typeof fetch;
        await render();
        await act(async () => { type(await addressField(), 'hilltop.example'); });
        await settle();
        await act(async () => { button('Reconnect')!.click(); });
        await settle();
        expect(text()).toContain('Your account in hilltop.example was closed');
        expect(text()).toContain('Your phone is still on Riverside. Nothing was changed.');
        expect(buttons().some(b => /Delete my account at/.test(b.textContent ?? ''))).toBe(false);
        expect(store.map.get('beanpool_anchor_url')).toBe(LOCAL);
    });
});
