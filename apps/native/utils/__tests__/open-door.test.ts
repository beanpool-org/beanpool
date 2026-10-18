/**
 * The door screen for any open-door community (utils/open-door.ts, utils/open-door-words.ts, app/join-open-door.tsx; slice
 * P5, DESIGN-global-entry-fable.md decision 6): which addresses it takes, where a tap and a link go, and what it says.
 *
 * - No lock-in: any plain https origin on any domain is a door; the global community's is only the default.
 * - A link only opens the screen: its work held for the member's tap (`from=link`), only for a phone with an account,
 *   never with another param it carried, and an address the screen refuses is said, never swapped for another door.
 * - The global community's door says exactly what it said before P5; another community's says the same under its name.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).__DEV__ = false;

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
}));
vi.mock('expo-linking', () => ({ addEventListener: vi.fn(() => ({ remove: vi.fn() })), openURL: vi.fn(async () => undefined) }));
vi.mock('expo-web-browser', () => ({
    openAuthSessionAsync: vi.fn(), openBrowserAsync: vi.fn(), dismissAuthSession: vi.fn(), dismissBrowser: vi.fn(async () => undefined),
    maybeCompleteAuthSession: vi.fn(),
}));
vi.mock('expo-apple-authentication', () => ({
    isAvailableAsync: vi.fn(async () => false), signInAsync: vi.fn(), AppleAuthenticationScope: { EMAIL: 0, FULL_NAME: 1 },
}));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(len)) }));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(), deleteItemAsync: vi.fn(),
}));
// The phone as the router reads it (as global-link.test.ts reads it), never written.
const phone = vi.hoisted(() => ({
    identity: null as null | { publicKey: string; callsign: string },
    pending: null as null | Record<string, unknown>,
    reads: 0,
}));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => { phone.reads++; return phone.identity; }) }));
vi.mock('../onboarding-state', () => ({ getPendingOnboarding: vi.fn(async () => { phone.reads++; return phone.pending; }) }));
vi.mock('../global-join-existing', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../global-join-existing')>()),
    accountClosedAtGlobal: vi.fn(async () => false),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async () => null),
        setItem: vi.fn(async () => { throw new Error('the router must write nothing'); }),
        removeItem: vi.fn(async () => { throw new Error('the router must write nothing'); }),
    },
}));

import { redirectSystemPath } from '../../app/+native-intent';
import {
    GLOBAL_DOOR_PATH, OPEN_DOOR_PATH, doorLinkFromSystemPath, doorLinkRoute, doorNodeAt, doorNodeFromParam, openDoorHref,
    openDoorHrefForTap, takeDoorTap,
} from '../open-door';
import {
    doorAnswerWords, doorKeeperWords, doorNameCheckWords, doorRefusalWords, doorScreenWords, globalPlace, joinedTitle, placeAt,
} from '../open-door-words';
import { DOOR_MESSAGES, nameCheckMessage, type DoorAnswer, type NameCheck } from '../global-join';
import { ACCOUNT_DOOR_MESSAGES, accountDoorMessage, joinedGlobalNotice } from '../global-join-existing';
import { GLOBAL_DOOR_MESSAGES } from '../node-profile';
import { GLOBAL_NODE_URL } from '../global-node-url';
import { askCommunityName } from '../community-name';

const ACCOUNT = { publicKey: 'ab'.repeat(16), callsign: 'Wren' };
const SELF = 'https://open.riverbend.example';

beforeEach(() => {
    phone.identity = null;
    phone.pending = null;
    phone.reads = 0;
});

describe('the addresses the door screen takes (doorNodeAt)', () => {
    it('the global community\'s, in any spelling, is the global door', () => {
        for (const a of [GLOBAL_NODE_URL, `${GLOBAL_NODE_URL}/`, 'HTTPS://Global.BeanPool.org', 'https://global.beanpool.org:443']) {
            expect(doorNodeAt(a), a).toEqual({ url: GLOBAL_NODE_URL, global: true });
        }
    });

    it('any other community\'s plain https origin, on any domain: its own door, in one spelling', () => {
        expect(doorNodeAt(SELF)).toEqual({ url: SELF, global: false });
        expect(doorNodeAt(' https://Open.Riverbend.Example/ ')).toEqual({ url: SELF, global: false });
        expect(doorNodeAt('https://commons.example.nz:8443')).toEqual({ url: 'https://commons.example.nz:8443', global: false });
        expect(doorNodeAt('https://203.0.113.7')).toEqual({ url: 'https://203.0.113.7', global: false });
        // A name under our domain is just another community's: nothing here assumes beanpool.org means global.
        expect(doorNodeAt('https://mullum.beanpool.org')).toEqual({ url: 'https://mullum.beanpool.org', global: false });
        // Cleartext only where the phone allows it anywhere: a private address (a LAN or this machine).
        expect(doorNodeAt('http://192.168.1.20:8080')).toEqual({ url: 'http://192.168.1.20:8080', global: false });
        expect(doorNodeAt('http://localhost:3000')).toEqual({ url: 'http://localhost:3000', global: false });
    });

    it('refused: anything the phone would not sign for or connect to, or that is not just an origin', () => {
        for (const a of [
            '', '   ', 'open.riverbend.example', 'riverbend', 'http://open.riverbend.example', 'http://203.0.113.7',
            'wss://open.riverbend.example', 'javascript:alert(1)', 'beanpool://join-open-door', 'file:///etc/passwd',
            'https://127.0.0.1\\@evil.test', 'https://user@open.riverbend.example', 'https://open.riverbend.example?x@evil.test',
            'https://open.riverbend.example/door', 'https://open.riverbend.example/?node=x', 'https://open.riverbend.example#x',
            'https://open riverbend.example', 'https://%65vil.test',
        ]) {
            expect(doorNodeAt(a), a).toBeNull();
        }
        expect(doorNodeAt(undefined)).toBeNull();
        expect(doorNodeAt(42)).toBeNull();
    });

    it('the screen\'s param: none (or blank) is the global community; anything else is read as an address, never defaulted', () => {
        expect(doorNodeFromParam(undefined)).toEqual({ url: GLOBAL_NODE_URL, global: true });
        expect(doorNodeFromParam('')).toEqual({ url: GLOBAL_NODE_URL, global: true });
        expect(doorNodeFromParam([SELF, GLOBAL_NODE_URL])).toEqual({ url: SELF, global: false });
        expect(doorNodeFromParam('http://open.riverbend.example')).toBeNull();
    });
});

describe('where a tap goes (openDoorHref)', () => {
    it('the global community: its door by the name every way to it already uses', () => {
        expect(openDoorHref(GLOBAL_NODE_URL)).toBe(GLOBAL_DOOR_PATH);
        expect(openDoorHref('https://global.beanpool.org/')).toBe('/join-global');
    });

    it('another community: the door screen with its address', () => {
        expect(openDoorHref(`${SELF}/`)).toEqual({ pathname: OPEN_DOOR_PATH, params: { node: SELF } });
    });

    it('an address the screen refuses still goes to the screen, which says so: never to another community\'s door', () => {
        expect(openDoorHref('http://open.riverbend.example')).toEqual({ pathname: '/join-open-door', params: { node: 'http://open.riverbend.example' } });
    });

    it('the member\'s Join in the app (openDoorHrefForTap): the same place, and that door alone may start its work as it opens, once, within a minute', () => {
        takeDoorTap(SELF);
        expect(openDoorHrefForTap(`${SELF}/`, 1_000)).toEqual(openDoorHref(`${SELF}/`));
        expect(takeDoorTap(SELF, 1_000)).toBe(true);
        // Read once: the next opening of the same door (a link to it, say) is not the member's tap.
        expect(takeDoorTap(SELF, 1_000)).toBe(false);
        // Another community's Join opens no other door.
        openDoorHrefForTap('https://commons.example.nz', 1_000);
        expect(takeDoorTap(SELF, 1_000)).toBe(false);
        expect(takeDoorTap('https://commons.example.nz', 1_000)).toBe(false);
        // Only just now.
        openDoorHrefForTap(SELF, 1_000);
        expect(takeDoorTap(SELF, 61_000)).toBe(false);
        // Nothing to hold at the global community's door (its own rule) nor at an address the screen refuses.
        expect(openDoorHrefForTap(GLOBAL_NODE_URL, 1_000)).toBe(GLOBAL_DOOR_PATH);
        expect(takeDoorTap(GLOBAL_NODE_URL, 1_000)).toBe(false);
        openDoorHrefForTap('http://open.riverbend.example', 1_000);
        expect(takeDoorTap('http://open.riverbend.example', 1_000)).toBe(false);
    });

    it('both routes are one screen: join-global re-exports join-open-door', () => {
        const app = path.resolve(__dirname, '../../app');
        expect(fs.readFileSync(path.join(app, 'join-global.tsx'), 'utf8')).toMatch(/^export \{ default, ErrorBoundary \} from '\.\/join-open-door';$/m);
        expect(fs.existsSync(path.join(app, 'join-open-door.tsx'))).toBe(true);
    });
});

describe('a link to the door only opens the screen (doorLinkFromSystemPath, doorLinkRoute, app/+native-intent.ts)', () => {
    const LINK = `beanpool://join-open-door?node=${encodeURIComponent(SELF)}`;

    it('read in every spelling a system hands over; every other param dropped', () => {
        for (const p of [LINK, `beanpool:///join-open-door?node=${encodeURIComponent(SELF)}`, `/join-open-door?node=${encodeURIComponent(SELF)}`,
            `join-open-door/?node=${encodeURIComponent(SELF)}&then=pair-device&from=tap#x`,
            // With no slashes, or one: Expo Router opens the same screen for both (expo-router extractExpoPathFromURL).
            `beanpool:join-open-door?node=${encodeURIComponent(SELF)}`, `beanpool:/join-open-door?node=${encodeURIComponent(SELF)}`]) {
            expect(doorLinkFromSystemPath(p), p).toEqual({ node: { url: SELF, global: false }, named: SELF });
        }
        expect(doorLinkFromSystemPath('beanpool://join-open-door')).toEqual({ node: { url: GLOBAL_NODE_URL, global: true }, named: null });
        expect(doorLinkFromSystemPath('beanpool://join-open-door?node=http%3A%2F%2Fevil.test')).toEqual({ node: null, named: 'http://evil.test' });
    });

    it('a node= that can\'t be read is a refused address, never the global community\'s door (PR #2131 review)', async () => {
        const garbled = doorLinkFromSystemPath('beanpool://join-open-door?node=%E0%A4%A')!;
        expect(garbled).toEqual({ node: null, named: '%E0%A4%A' });
        const to = doorLinkRoute(garbled, { account: true, wizardPending: false }, false, 1);
        expect(to).toBe(`/join-open-door?node=${encodeURIComponent('%E0%A4%A')}&from=link`);
        // The screen reads what the route carries as no address: its refusal page, not a door.
        expect(doorNodeFromParam(new URL(to!, 'https://x.invalid').searchParams.get('node')!)).toBeNull();
        phone.identity = ACCOUNT;
        expect(await redirectSystemPath({ path: 'beanpool://join-open-door?node=https%3A%2F%2Fopen.riverbend.example%ZZ', initial: false }))
            .toBe(`/join-open-door?node=${encodeURIComponent('https%3A%2F%2Fopen.riverbend.example%ZZ')}&from=link`);
    });

    it('join-global with an address goes as the door link does: no route the screen reads as another address without from=link (PR #2131 review)', async () => {
        const ATTACKER = 'https://attacker.example';
        for (const p of [`beanpool://join-global?node=${encodeURIComponent(ATTACKER)}`, `beanpool:///join-global/?then=pair-device&node=${encodeURIComponent(ATTACKER)}`,
            `/join-global?node=${encodeURIComponent(ATTACKER)}`, `JOIN-GLOBAL?node=${encodeURIComponent(ATTACKER)}#x`]) {
            expect(doorLinkFromSystemPath(p), p).toEqual({ node: { url: ATTACKER, global: false }, named: ATTACKER });
        }
        phone.identity = ACCOUNT;
        expect(await redirectSystemPath({ path: `beanpool://join-global?node=${encodeURIComponent(ATTACKER)}`, initial: false }))
            .toBe(`/join-open-door?node=${encodeURIComponent(ATTACKER)}&from=link`);
        // The global community's address by that name: as the global link goes, held.
        expect(await redirectSystemPath({ path: `beanpool://join-global?node=${encodeURIComponent(GLOBAL_NODE_URL)}`, initial: false }))
            .toBe('/join-global?from=link');
        phone.identity = null;
        expect(await redirectSystemPath({ path: `beanpool://join-global?node=${encodeURIComponent(ATTACKER)}`, initial: true })).toBe('/');
    });

    it('the root layout reads no door link as an invite: no "Switch Nodes?", no welcome with an invite (PR #2131 review)', async () => {
        // app/_layout.tsx skips a door link before it looks for an invite, as it does the pairing and global links.
        const layout = fs.readFileSync(path.resolve(__dirname, '../../app/_layout.tsx'), 'utf8');
        const skip = layout.indexOf('if (doorLinkFromSystemPath(currentUrl)) return;');
        expect(skip).toBeGreaterThan(-1);
        expect(skip).toBeLessThan(layout.indexOf('const inviteToken = extractInviteToken(currentUrl);'));
        // Each link the layout's invite reader took for the invite JOIN-OPEN-DOOR or JOIN-GLOBAL is one it skips: the
        // address as the operator page publishes it, encoded, by the old name, in capitals, and with no slashes.
        const ADDRESS = 'https://your.address';
        for (const link of [`beanpool://join-open-door?node=${ADDRESS}`, `beanpool://join-open-door?node=${encodeURIComponent(ADDRESS)}`,
            `beanpool://join-global?node=${encodeURIComponent(ADDRESS)}`, `BEANPOOL://JOIN-OPEN-DOOR?node=${encodeURIComponent(ADDRESS)}`,
            `beanpool:join-open-door?node=${encodeURIComponent(ADDRESS)}`, 'beanpool://join-open-door']) {
            expect(doorLinkFromSystemPath(link), link).not.toBeNull();
        }
        // One that also carries an invite is the door's all the same: the router opens the door and drops the invite, so
        // the layout offers nothing over it.
        const withInvite = `beanpool://join-open-door?node=${encodeURIComponent(ADDRESS)}&invite=INV-ABCD-EFGH`;
        expect(doorLinkFromSystemPath(withInvite)).toEqual({ node: { url: ADDRESS, global: false }, named: ADDRESS });
        phone.identity = ACCOUNT;
        expect(await redirectSystemPath({ path: withInvite, initial: false })).toBe(`/join-open-door?node=${encodeURIComponent(ADDRESS)}&from=link`);
        expect(await redirectSystemPath({ path: `beanpool:join-open-door?node=${encodeURIComponent(ADDRESS)}`, initial: false }))
            .toBe(`/join-open-door?node=${encodeURIComponent(ADDRESS)}&from=link`);
    });

    it('not a door link: join-global is left to Expo Router as before, and lookalikes are nothing', () => {
        for (const p of ['beanpool://join-global', 'beanpool://join-open-doorx', 'beanpool://x/join-open-door', 'https://evil.test/join-open-door', 42]) {
            expect(doorLinkFromSystemPath(p), String(p)).toBeNull();
        }
    });

    it('an account: that community\'s door, its work held for the tap; with no account or a wizard half done, as from the icon', () => {
        const link = doorLinkFromSystemPath(LINK)!;
        expect(doorLinkRoute(link, { account: true, wizardPending: false }, false, 1)).toBe(`/join-open-door?node=${encodeURIComponent(SELF)}&from=link`);
        expect(doorLinkRoute(link, { account: false, wizardPending: false }, true, 1)).toBe('/');
        expect(doorLinkRoute(link, { account: false, wizardPending: false }, false, 1)).toBeNull();
        expect(doorLinkRoute(link, { account: true, wizardPending: true }, true, 1)).toBe('/');
        expect(doorLinkRoute(link, { account: true, wizardPending: true }, false, 1)).toBeNull();
    });

    it('a refused address opens the screen that says so, held; the global community\'s goes as its own link does', () => {
        const refused = doorLinkFromSystemPath('beanpool://join-open-door?node=http%3A%2F%2Fevil.test')!;
        expect(doorLinkRoute(refused, { account: true, wizardPending: false }, false, 1)).toBe('/join-open-door?node=http%3A%2F%2Fevil.test&from=link');
        const global = doorLinkFromSystemPath(`beanpool://join-open-door?node=${encodeURIComponent(GLOBAL_NODE_URL)}`)!;
        expect(doorLinkRoute(global, { account: true, wizardPending: false }, false, 1)).toBe('/join-global?from=link');
        expect(doorLinkRoute(global, { account: false, wizardPending: false }, false, 7)).toBe('/welcome?door=global&at=7');
    });

    it('through the router: the phone read, nothing written, the route as above', async () => {
        phone.identity = ACCOUNT;
        expect(await redirectSystemPath({ path: LINK, initial: false })).toBe(`/join-open-door?node=${encodeURIComponent(SELF)}&from=link`);
        expect(phone.reads).toBeGreaterThan(0);
        phone.identity = null;
        expect(await redirectSystemPath({ path: LINK, initial: true })).toBe('/');
        // Left as before P5: Expo Router opens join-global (global-link.test.ts pins it as no link of its own).
        expect(redirectSystemPath({ path: 'beanpool://join-global', initial: false })).toBe('beanpool://join-global');
    });

    it('the screen holds a link\'s work until the tap and reads the node only through doorNodeFromParam', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../app/join-open-door.tsx'), 'utf8');
        expect(src).toContain('const door = doorNodeFromParam(nodeParam);');
        expect(src).toContain('if (!door) return <RefusedDoor />;');
        expect(src).toContain('useState(fromParam === FROM_LINK)');
        // Every request goes to the door's own address: none to the global community's by name.
        expect(src).not.toContain('GLOBAL_NODE_URL');
        for (const call of ['checkGlobalDoor(doorUrl)', 'signInAtDoor(provider, doorUrl,', 'checkNameAtDoor(doorUrl,', 'submitJoin(doorUrl,', 'submitWordsJoin(doorUrl,', 'startOneWayBack(account.identity.publicKey, doorUrl)']) {
            expect(src, call).toContain(call);
        }
        // The phone switches to the community whose door it is, and keeps the global community's marks for it alone.
        expect(src).toContain('...(door.global ? {} : { at: { url: doorUrl, name: knownName } })');
        expect(src).toContain("if (answer.kind === 'account_closed' && door.global) await rememberAccountClosed(");
    });
});

describe('what the door says', () => {
    const GLOBAL = globalPlace(GLOBAL_NODE_URL);
    const OTHER = placeAt(SELF, 'Riverbend Open');

    it('the global community\'s door: every sentence exactly as before P5', () => {
        const words = doorScreenWords(GLOBAL);
        expect(words).toEqual({
            header: 'Global community',
            title: '🌍 Join the global community',
            connecting: 'Connecting to the global community…',
            intro: 'Meet people from everywhere and find communities near you, as the account on this phone. Your key and your 12 words stay the same, and nothing changes in your other communities.',
            nameLabel: 'Your name in the global community',
            joining: 'Joining the global community…',
            notOpened: 'You joined the global community, but the app could not open it. Open it from Your communities in the BeanPool sheet (tap the bean).',
        });
        for (const reason of ['unreachable', 'not_global', 'door_closed', 'private_preview'] as const) {
            expect(doorRefusalWords(reason, GLOBAL)).toBe(GLOBAL_DOOR_MESSAGES[reason]);
        }
        const answers: Exclude<DoorAnswer, { kind: 'joined' }>[] = [
            { kind: 'already_joined', message: DOOR_MESSAGES.alreadyJoined },
            { kind: 'account_closed', message: DOOR_MESSAGES.accountClosed },
            { kind: 'phone_clock', message: DOOR_MESSAGES.phoneClock },
            { kind: 'door_closed', message: DOOR_MESSAGES.doorClosed },
            { kind: 'removed', message: DOOR_MESSAGES.removed },
            { kind: 'unreachable', message: DOOR_MESSAGES.unreachable },
        ];
        for (const a of answers) expect(doorAnswerWords(a, GLOBAL)).toBe(accountDoorMessage(a));
        const checks: NameCheck[] = [{ kind: 'timed_out' }, { kind: 'taken', suggestions: ['Wren2'], suggestionsTimedOut: false }];
        for (const check of checks) {
            expect(doorNameCheckWords('Wren', check, GLOBAL)).toBe(nameCheckMessage('Wren', check));
        }
        expect(doorKeeperWords(GLOBAL, 'community').choose).toBe('The global community keeps a locked copy of your account for it, and the people who run it can open that copy. BeanPool never sees your password and never posts anything for you.');
        expect(doorKeeperWords(GLOBAL, 'vault').signIn).toBe('To keep out fake accounts, sign in once with an account you already have. That sign-in also becomes a way back into your account if you lose this phone: BeanPool keeps a locked copy of your account for it, and BeanPool can open that copy. BeanPool never sees your password and never posts anything for you.');
        expect(joinedTitle(GLOBAL, joinedGlobalNotice(null).title)).toBe("You're in the global community");
    });

    it('another community\'s door: the same, under its own name; never "the global community"', () => {
        const all = [
            ...Object.values(doorScreenWords(OTHER)),
            ...Object.values(doorKeeperWords(OTHER, 'community')), ...Object.values(doorKeeperWords(OTHER, 'vault')),
            ...(['unreachable', 'not_global', 'door_closed'] as const).map(r => doorRefusalWords(r, OTHER)),
            doorAnswerWords({ kind: 'already_joined', message: DOOR_MESSAGES.alreadyJoined }, OTHER),
            doorAnswerWords({ kind: 'account_closed', message: DOOR_MESSAGES.accountClosed }, OTHER),
            doorAnswerWords({ kind: 'phone_clock', message: DOOR_MESSAGES.phoneClock }, OTHER),
            doorAnswerWords({ kind: 'door_closed', message: DOOR_MESSAGES.doorClosed }, OTHER),
            doorAnswerWords({ kind: 'removed', message: DOOR_MESSAGES.removed }, OTHER),
            doorAnswerWords({ kind: 'unreachable', message: DOOR_MESSAGES.unreachable }, OTHER),
            doorNameCheckWords('Wren', { kind: 'timed_out' }, OTHER),
            doorNameCheckWords('Wren', { kind: 'taken', suggestions: [], suggestionsTimedOut: true }, OTHER),
            doorNameCheckWords('Wren', { kind: 'taken', suggestions: ['Wren2'], suggestionsTimedOut: false }, OTHER),
            doorNameCheckWords('Wren', { kind: 'taken', suggestions: [], suggestionsTimedOut: false }, OTHER),
            joinedTitle(OTHER, joinedGlobalNotice(null).title),
        ];
        for (const line of all) {
            expect(line, line).not.toMatch(/global community/i);
            expect(line, line).toContain('Riverbend Open');
        }
        expect(doorScreenWords(OTHER).header).toBe('Riverbend Open');
        expect(doorScreenWords(OTHER).title).toBe('Join Riverbend Open');
        expect(doorNameCheckWords('Wren', { kind: 'taken', suggestions: [], suggestionsTimedOut: false }, OTHER))
            .toBe('"Wren" is already taken in Riverbend Open. Choose another name.');
        // A build with the key vault says the copy only where the door works with it (ticket keys: known at the sign-in).
        expect(doorKeeperWords(OTHER, 'vault').choose).toMatch(/^If Riverbend Open works with the BeanPool key vault,/);
    });

    it('what a node says itself is shown as it came, at any door (its words are about "this community" already)', () => {
        const own: Exclude<DoorAnswer, { kind: 'joined' }>[] = [
            { kind: 'door_closed', message: 'This community is in a private preview. Ask its owner for an invite.' },
            { kind: 'removed', message: "The BeanPool identity this Google account joined with was removed from this community, so it can't join again." },
            { kind: 'try_again', message: 'Your join could not be completed, and nothing was saved. Please try again in a minute.' },
        ];
        for (const a of own) expect(doorAnswerWords(a, OTHER)).toBe(a.message);
        expect(doorAnswerWords({ kind: 'already_joined', message: 'x' }, GLOBAL)).toBe(ACCOUNT_DOOR_MESSAGES.otherAccount);
    });

    it('a community not yet named: its saved name, else its host; its host is shown under the title', () => {
        expect(placeAt(SELF)).toEqual({ global: false, name: 'open.riverbend.example', host: 'open.riverbend.example' });
        expect(placeAt(SELF, 'Riverbend')).toMatchObject({ name: 'Riverbend' });
        // The placeholder a node with no name says is no name.
        expect(placeAt(SELF, 'Local Discovery')).toMatchObject({ name: 'open.riverbend.example' });
    });
});

describe('the community\'s own name (askCommunityName)', () => {
    const answering = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

    it('its health answer\'s nodeName, else name; unsigned GET to that address only', async () => {
        const f = answering({ nodeName: ' Riverbend Open ' });
        expect(await askCommunityName(SELF, f)).toBe('Riverbend Open');
        expect((f as any).mock.calls[0][0]).toBe(`${SELF}/api/community/health`);
        expect((f as any).mock.calls[0][1]).toMatchObject({ method: 'GET' });
        expect((f as any).mock.calls[0][1].headers).toBeUndefined();
        expect(await askCommunityName(SELF, answering({ name: 'Riverbend' }))).toBe('Riverbend');
    });

    it('no name: none (a placeholder, an error, no answer)', async () => {
        expect(await askCommunityName(SELF, answering({ nodeName: 'Local Discovery' }))).toBeNull();
        expect(await askCommunityName(SELF, answering({ nodeName: 'Riverbend' }, 500))).toBeNull();
        expect(await askCommunityName(SELF, vi.fn(async () => { throw new TypeError('offline'); }) as unknown as typeof fetch)).toBeNull();
    });
});
