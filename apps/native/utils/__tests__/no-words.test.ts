import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import React from 'react';

// Host components as plain tags, so the tree can be walked without a device (vitest.config.ts).
vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    StyleSheet: { create: <T,>(s: T) => s },
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    TouchableOpacity: 'TouchableOpacity',
}));

// "Who can open it ›" keeps its own open/closed state (a hook, which this hand-made renderer can't run): drawn here as
// a host with its label, and what it opens drawn as if open. onboarding-components-words-render.test.ts presses the real one.
vi.mock('../../components/WhoCanOpen', () => ({
    WhoCanOpen: (props: { label: string; children: unknown }) => React.createElement('WhoCanOpen', { label: props.label }, props.children),
}));

// The provider buttons draw SVG logos; only their titles matter here.
vi.mock('../../components/SsoButton', () => {
    const button = (name: string) => (props: { title: string; onPress: () => void }) =>
        React.createElement('SsoButton', { name, onPress: props.onPress }, props.title);
    return {
        AppleButton: button('apple'),
        GoogleButton: button('google'),
        FacebookButton: button('facebook'),
    };
});

import {
    KeeperProtectionPanel, VAULT_COPY_OPENERS, SIGN_IN_COPY_WORDS_ONLY, SIGN_IN_ROW,
} from '../../components/KeeperProtectionPanel';
import { noVault, useVault } from './fake-vault';

// The panel as a build with BeanPool's key vault shows it (V4). A build without one shows exactly what it did before the
// vault: no-words.no-vault.test.ts is main's suite for that, unchanged.
beforeAll(() => useVault());
afterAll(() => noVault());
import { NoWordsNotice } from '../../components/NoWordsNotice';
import { protectionFrom } from '../protection-state';
import {
    NO_WORDS_WAY_BACK, NO_WORDS_MENU, NO_WORDS_SIGN_OUT_ALERT, NO_WORDS_CONNECT, SSO_WORDS_NOTE, noWordsBeforeWipe,
} from '../no-words-copy';

type Host = { type: string; props: Record<string, any>; children: Node[] };
type Node = Host | string;

/** Expands function components (these two have no hooks) down to host elements. */
function render(node: unknown): Node[] {
    if (node === null || node === undefined || typeof node === 'boolean') return [];
    if (typeof node === 'string' || typeof node === 'number') return [String(node)];
    if (Array.isArray(node)) return node.flatMap(render);
    const el = node as React.ReactElement<Record<string, any>>;
    if (el.type === React.Fragment) return render(el.props.children);
    if (typeof el.type === 'function') return render((el.type as (p: unknown) => unknown)(el.props));
    return [{ type: el.type as string, props: el.props, children: render(el.props.children) }];
}

/** Everything a member reads, one Text per line. */
function textOf(nodes: Node[]): string {
    const lines: string[] = [];
    const walk = (n: Node, inText: boolean): string => {
        if (typeof n === 'string') return n;
        const inner = n.children.map(c => walk(c, inText || n.type === 'Text' || n.type === 'SsoButton')).join('');
        if ((n.type === 'Text' || n.type === 'SsoButton') && !inText) { lines.push(inner); return ''; }
        return inner;
    };
    nodes.forEach(n => walk(n, false));
    return lines.join('\n');
}

function findAll(nodes: Node[], type: string): Host[] {
    const out: Host[] = [];
    const walk = (n: Node) => {
        if (typeof n === 'string') return;
        if (n.type === type) out.push(n);
        n.children.forEach(walk);
    };
    nodes.forEach(walk);
    return out;
}

const WORDS_ONLY = protectionFrom(null);
const COVERED = protectionFrom({
    enrolled: ['sso'], generation: 1, skipped: [], available: 1,
    enrolledSso: ['facebook'], threshold: 1, isSingleBlob: true,
});

function panel(protection: typeof WORDS_ONLY, hasWords: boolean, onProtectSso = vi.fn(), waysBack = false) {
    return render(React.createElement(KeeperProtectionPanel, { protection, hasWords, onProtectSso, onDisconnectSso: vi.fn(), waysBack }));
}

describe('what a phone with no 12 words is told', () => {
    it('the one line says why there are no words and what gets them back in', () => {
        expect(NO_WORDS_WAY_BACK).toBe(
            'This phone was restored with a sign-in, so it has no 12 words. A connected sign-in is how you get back in.');
        expect(noWordsBeforeWipe()).toBe(
            'This phone was restored with a sign-in, so it has no 12 words. Without a connected sign-in, you cannot get this account back.');
        expect(noWordsBeforeWipe('Alice')).toBe(
            'This phone was restored with a sign-in, so it has no 12 words for Alice. Without a connected sign-in, you cannot get Alice back.');
    });

    it('signing out never promises the words bring the account back', () => {
        expect(NO_WORDS_SIGN_OUT_ALERT).toContain('Without a connected sign-in, you cannot get this account back.');
        expect(NO_WORDS_SIGN_OUT_ALERT).not.toMatch(/restored anytime|recovery phrase/i);
    });

    // Was `not.toMatch(/view/i)`: #1147 hid "View" on a phone without words. Marty, 2026-09-25: the row stays, under
    // the name it has on a phone with words, and opens the add form (view-words.test.ts). What that assertion was
    // for still holds, pinned exactly: the line under it says there is no copy here, so it never promises words.
    it('the Settings row keeps its name, and says this phone has no copy', () => {
        expect(NO_WORDS_MENU).toEqual({ title: 'View Recovery Phrase', sub: 'No copy on this phone yet. Tap to add your 12 words.' });
        expect(NO_WORDS_MENU.sub).not.toMatch(/view your|backup seed/i);
    });
});

describe('KeeperProtectionPanel on a phone with no 12 words', () => {
    it('says the one line instead of "your 12 words are your primary recovery", and offers every sign-in', () => {
        const onProtectSso = vi.fn();
        const tree = panel(WORDS_ONLY, false, onProtectSso);
        const text = textOf(tree);

        expect(text).toContain('Connect a sign-in');
        expect(text).toContain(NO_WORDS_WAY_BACK);
        // Nothing else mentions words the phone doesn't have.
        expect(text.replace(NO_WORDS_WAY_BACK, '')).not.toMatch(/12 words|primary recovery|written down/i);

        const buttons = findAll(tree, 'SsoButton');
        expect(buttons.map(b => b.props.name)).toEqual(['google', 'facebook']);
        buttons[1].props.onPress();
        expect(onProtectSso).toHaveBeenCalledWith('facebook');
    });

    it('covered: nothing on the panel mentions 12 words', () => {
        const text = textOf(panel(COVERED, false));
        expect(text).toContain('Facebook Connected');
        expect(text).not.toMatch(/12 words|written down/i);
        // Was "It only works while your hub is running.": the copy is at BeanPool's key vault now (V4), not with a hub.
        // Was SSO_GROUP_NOTE: VR0's sign-in row says where the copy is, and that it holds the key alone on this phone.
        expect(text).toContain(`${SIGN_IN_ROW.vaultKeepsKey} ${SIGN_IN_ROW.whoCanOpen}`);
        expect(text).toContain(SIGN_IN_ROW.moreThanOne);
        expect(text).not.toMatch(/hub/i);
    });

    // Was "reads exactly as before", pinning "It does not hand your 12 words back". A sign-in connected from a
    // phone with the words now seals them too (keeper-enrolment.ts), so that sentence became untrue; the panel
    // now says which sign-ins give the words back, and everything else a member with words reads is unchanged.
    it('a phone with words is told which sign-ins give the words back, and otherwise reads as before', () => {
        const text = textOf(panel(WORDS_ONLY, true));
        expect(text).toContain('🔑 Your 12 words are your primary recovery');
        expect(text).toContain('Your 12 words are your primary key to your account. Write them down safely.');
        // Was "…restores your account on a new phone. [note] It only works while your hub is running — so keep the words
        // written down.": the hub sentence went with the copy moving to the key vault (V4); the words part stays. Was
        // SSO_GROUP_NOTE's two sentences: its second is the sign-in row's first now (VR0), so only the first is left here.
        expect(text).toContain(`${SIGN_IN_ROW.moreThanOne} ${SSO_WORDS_NOTE} Keep the words written down as well.`);
        expect(SIGN_IN_ROW.moreThanOne).toBe('Connect more than one, in case you lose one.');
        expect(SSO_WORDS_NOTE).toBe('A sign-in connected on this version of the app brings your 12 words back too. One connected on an earlier version brings back your account without them: tap Connect again to include them.');
        expect(text).not.toMatch(/does not hand your 12 words back/);
        expect(text).not.toContain(NO_WORDS_WAY_BACK);

        expect(textOf(panel(COVERED, true))).toContain('Keep the words written down as well.');
    });

    it('a connected sign-in can be connected again on a phone with words, to include them; never on one without', () => {
        const onProtectSso = vi.fn();
        const withWords = findAll(panel(COVERED, true, onProtectSso), 'TouchableOpacity');
        const again = withWords.find(b => b.props.accessibilityLabel === 'Connect Facebook again, to include your 12 words');
        expect(again).toBeDefined();
        expect(textOf([again!])).toBe('Connect again');
        again!.props.onPress();
        expect(onProtectSso).toHaveBeenCalledWith('facebook');
        // Disconnect is still there beside it.
        expect(withWords.map(b => b.props.accessibilityLabel)).toContain('Disconnect Facebook');

        const withoutWords = findAll(panel(COVERED, false), 'TouchableOpacity');
        expect(withoutWords.map(b => b.props.accessibilityLabel)).toEqual(['Disconnect Facebook']);
    });
});

// Under a connected sign-in, who can open the copy it keeps. Recovery seal S3 said a community's operators could; the
// key vault (V4) moves every copy there, and D6 (Marty, 2026-09-28) is the honest words for it, in the one-custodian
// period until the reshare (D1).
describe('KeeperProtectionPanel: an account a claim made keeps its copy at its community, even in a vault build', () => {
    // #2433 review r4366342448: Safety Backup after a claim drew the vault's words ("BeanPool's key vault … in Iceland",
    // "in every community") for a copy SsoEnrolSheet put at the owner's own community (Marty, 24 Oct: no vault copy).
    it('says the community keeps it, names the community, warns it works only while that server runs; no vault words', () => {
        const text = textOf(render(React.createElement(KeeperProtectionPanel, {
            protection: COVERED, hasWords: true, copyAt: 'community', communityName: 'Valley Hub', onProtectSso: vi.fn(), onDisconnectSso: vi.fn(),
        })));
        expect(text).not.toContain(VAULT_COPY_OPENERS);
        expect(text).not.toMatch(/in every community/);
        expect(text).not.toMatch(/key vault|Iceland/);
        expect(text).toMatch(/Valley Hub/);
        expect(text).toMatch(/only works while your community's server is running/);
    });
    it('without copyAt, the same vault build still says the vault (nothing else changed)', () => {
        const text = textOf(panel(COVERED, true));
        expect(text).toContain(VAULT_COPY_OPENERS);
    });
});

describe('KeeperProtectionPanel: who can open a sign-in copy', () => {
    it('the sentences, word for word: BeanPool can (one person for now), the host can read memory, a court, the sign-in; the words alone keep everyone else out', () => {
        expect(VAULT_COPY_OPENERS).toBe(
            "BeanPool's key vault, a small server in Iceland, keeps the copy of your account that your sign-in opens. BeanPool can open these copies: for now one person, BeanPool's founder, looks after the vault, and it is moving to three people in different countries, two of whom must act together. The company that hosts it can read its memory while it runs. A court could order a copy opened, and anyone who takes over your sign-in account could get in.");
        expect(VAULT_COPY_OPENERS).not.toMatch(/community's server/);
        expect(SIGN_IN_COPY_WORDS_ONLY).toBe('If you would rather nobody but you could get in, use only your 12 words.');
    });

    it('under a connected sign-in on a phone with words: all of it, after the sign-in and before the not-a-login note', () => {
        const text = textOf(panel(COVERED, true));
        const line = `${VAULT_COPY_OPENERS} ${SIGN_IN_COPY_WORDS_ONLY}`;
        expect(text.split('\n')).toContain(line);
        expect(text.indexOf('Facebook Connected')).toBeLessThan(text.indexOf(line));
        expect(text.indexOf(line)).toBeLessThan(text.indexOf('This is not a login'));
    });

    it('on a phone with no 12 words: who can open it, and never "use only your 12 words"', () => {
        const text = textOf(panel(COVERED, false));
        expect(text.split('\n')).toContain(VAULT_COPY_OPENERS);
        expect(text).not.toContain(SIGN_IN_COPY_WORDS_ONLY);
    });

    // Android lists no Apple button, but a member who connected Apple on an iPhone still has a copy on the server.
    it('covered by a sign-in this phone lists no button for (Apple on Android): still says who can open its copy', () => {
        const appleOnly = protectionFrom({
            enrolled: ['sso'], generation: 1, skipped: [], available: 1,
            enrolledSso: ['apple'], threshold: 1, isSingleBlob: true,
        });
        expect(appleOnly.state).toBe('covered');
        const withWords = textOf(panel(appleOnly, true));
        expect(withWords).not.toContain('Apple Connected');
        expect(withWords.split('\n')).toContain(`${VAULT_COPY_OPENERS} ${SIGN_IN_COPY_WORDS_ONLY}`);
        const withoutWords = textOf(panel(appleOnly, false));
        expect(withoutWords.split('\n')).toContain(VAULT_COPY_OPENERS);
        expect(withoutWords).not.toContain(SIGN_IN_COPY_WORDS_ONLY);
    });

    // Was "with no sign-in connected, nothing: there is no copy to talk about" (not.toContain(VAULT_COPY_OPENERS)). Vault
    // rethink VR0 (Marty, 27 Oct, pick 10) says where the copy goes and who can open it at the moment it is made, so
    // before Protect with: under the row "A sign-in you link", which says how a linked sign-in works, one tap away and
    // never on the page by itself. With no copy yet, nothing says one exists: no provider is drawn as connected.
    it('with no sign-in connected: who can open a copy is one tap away under the row, before one is made', () => {
        for (const hasWords of [true, false]) {
            const tree = panel(WORDS_ONLY, hasWords);
            const [who] = findAll(tree, 'WhoCanOpen');
            expect(who.props.label).toBe(SIGN_IN_ROW.whoCanOpenButton);
            expect(textOf([who])).toBe(hasWords ? `${VAULT_COPY_OPENERS} ${SIGN_IN_COPY_WORDS_ONLY}` : VAULT_COPY_OPENERS);
            const text = textOf(tree);
            expect(text.indexOf(SIGN_IN_ROW.title)).toBeLessThan(text.indexOf(VAULT_COPY_OPENERS));
            expect(text).not.toMatch(/Connected/);
        }
    });

    it('covered with one sign-in: the footnote no longer says the server cannot open it alone', () => {
        const text = textOf(panel(COVERED, true));
        expect(text).not.toMatch(/Neither of them can open/);
        // Was "…it takes your community's server too.": the vault keeps the copy for every community now (V4), and
        // every restore waits a day unless a phone of the member's says it's them (D2). Was "another phone or computer of
        // yours … your devices are told": only the phone app is told of a restore or can answer it (the web app has no
        // vault client), so it says phones (vault words fact check, 16 Oct).
        expect(text).toContain("Protected by your sign-in account, in every community. It brings your account back on a new phone: it takes a day, or less if another phone of yours says it's you, and your other phones are told so they can stop it.");
        expect(text).not.toMatch(/community's server/);
        expect(text).not.toMatch(/computer/);
    });
});

// Vault rethink VR0 (DESIGN-vault-rethink-fable.md §4.5, §7; Marty, 27 Oct, picks 10 and 14): where the copy goes is said
// on the panel itself, before Protect with is tapped, at Safety Backup (both doors) and in Account Protection.
describe('KeeperProtectionPanel, VR0: the sign-in row names the key vault where the copy is made', () => {
    it('the sentences, word for word', () => {
        expect(SIGN_IN_ROW).toEqual({
            title: 'A sign-in you link',
            bringsBack: 'Google or Facebook brings your account back on a new phone.',
            bringsBackIos: 'Google, Apple or Facebook brings your account back on a new phone.',
            vaultKeeps: "BeanPool's key vault, a small server in Iceland, keeps a locked copy of your key and 12 words for it.",
            vaultKeepsKey: "BeanPool's key vault, a small server in Iceland, keeps a locked copy of your key for it.",
            whoCanOpen: 'The people who look after the vault can open that copy, and so can anyone who gets into your sign-in account.',
            wait: "It takes a day, or less if another phone of yours says it's you.",
            moreThanOne: 'Connect more than one, in case you lose one.',
            whoCanOpenButton: 'Who can open it',
        });
    });

    it('before any sign-in (the invite door): the row, all four sentences, above the Protect with buttons', () => {
        const tree = panel(WORDS_ONLY, true);
        const text = textOf(tree);
        const row = `${SIGN_IN_ROW.bringsBack} ${SIGN_IN_ROW.vaultKeeps} ${SIGN_IN_ROW.whoCanOpen} ${SIGN_IN_ROW.wait}`;
        expect(text.split('\n')).toContain(row);
        expect(text.indexOf(SIGN_IN_ROW.title)).toBeLessThan(text.indexOf(row));
        expect(text.indexOf(row)).toBeLessThan(text.indexOf('Protect with Google'));
        // The row's heading is a header, as the panel's own heading is.
        const title = findAll(tree, 'Text').find(n => n.children.join('') === SIGN_IN_ROW.title);
        expect(title?.props.accessibilityRole).toBe('header');
        // Apple only where it is offered.
        expect(text).not.toContain('Apple');
    });

    it('on an iPhone the row names Apple, which it offers', async () => {
        const rn = await import('react-native');
        const was = rn.Platform.OS;
        (rn.Platform as { OS: string }).OS = 'ios';
        try {
            const text = textOf(panel(WORDS_ONLY, true));
            expect(text).toContain(`${SIGN_IN_ROW.bringsBackIos} ${SIGN_IN_ROW.vaultKeeps}`);
            expect(text).toContain('Protect with Apple');
        } finally {
            (rn.Platform as { OS: string }).OS = was;
        }
    });

    it('a phone with no 12 words: the copy holds the key alone, and the row says so', () => {
        const text = textOf(panel(WORDS_ONLY, false));
        expect(text.split('\n')).toContain(`${SIGN_IN_ROW.bringsBack} ${SIGN_IN_ROW.vaultKeepsKey} ${SIGN_IN_ROW.whoCanOpen} ${SIGN_IN_ROW.wait}`);
        expect(text).not.toContain(SIGN_IN_ROW.vaultKeeps);
    });

    it('covered (the global door, joined with a sign-in): the footnote says it brings the account back and waits a day, the row the vault and who', () => {
        const text = textOf(panel(COVERED, true));
        expect(text.split('\n')).toContain(`${SIGN_IN_ROW.vaultKeeps} ${SIGN_IN_ROW.whoCanOpen}`);
        expect(text).not.toContain(SIGN_IN_ROW.bringsBack);
        expect(text).not.toContain(SIGN_IN_ROW.wait);
        expect(text.indexOf('Protected by your sign-in account')).toBeLessThan(text.indexOf(SIGN_IN_ROW.vaultKeeps));
        expect(text.indexOf(SIGN_IN_ROW.vaultKeeps)).toBeLessThan(text.indexOf('Facebook Connected'));
    });

    it("an account a claim made: none of it (its copy is at its community, never the vault's)", () => {
        for (const protection of [WORDS_ONLY, COVERED]) {
            const tree = render(React.createElement(KeeperProtectionPanel, {
                protection, hasWords: true, copyAt: 'community', communityName: 'Valley Hub', onProtectSso: vi.fn(),
            }));
            const text = textOf(tree);
            for (const line of Object.values(SIGN_IN_ROW)) expect(text).not.toContain(line);
            expect(findAll(tree, 'WhoCanOpen')).toEqual([]);
        }
    });

    it('Account Protection (waysBack), words on the phone, no sign-in yet: the sign-in row alone, the words being the row above', () => {
        const text = textOf(panel(WORDS_ONLY, true, vi.fn(), true));
        expect(text).not.toContain('Your 12 words are your primary recovery');
        expect(text).not.toContain('Your 12 words are your primary key to your account');
        expect(text.split('\n')[0]).toBe(SIGN_IN_ROW.title);
        expect(text).toContain(SIGN_IN_ROW.vaultKeeps);
        expect(text).toContain('Protect with Google');
    });

    it('waysBack changes nothing else: covered, and a phone with no 12 words, read as at Safety Backup', () => {
        expect(textOf(panel(COVERED, true, vi.fn(), true))).toBe(textOf(panel(COVERED, true)));
        expect(textOf(panel(WORDS_ONLY, false, vi.fn(), true))).toBe(textOf(panel(WORDS_ONLY, false)));
        expect(textOf(panel(WORDS_ONLY, false, vi.fn(), true))).toContain(NO_WORDS_WAY_BACK);
    });
});

describe('NoWordsNotice', () => {
    it('way back: the one line, and a way on to Account Protection', () => {
        const onPress = vi.fn();
        const tree = render(React.createElement(NoWordsNotice, { kind: 'way-back', action: { label: NO_WORDS_CONNECT, onPress } }));

        expect(textOf(tree)).toBe(`🔑 ${NO_WORDS_WAY_BACK}\n🛡️ ${NO_WORDS_CONNECT}`);
        const [button] = findAll(tree, 'Pressable');
        expect(button.props.accessibilityRole).toBe('button');
        expect(button.props.accessibilityLabel).toBe('Connect a sign-in');
        button.props.onPress();
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('before a wipe: says the account cannot come back without a connected sign-in, by name where given', () => {
        expect(textOf(render(React.createElement(NoWordsNotice, { kind: 'before-wipe' }))))
            .toBe(`⚠️ ${noWordsBeforeWipe()}`);
        expect(textOf(render(React.createElement(NoWordsNotice, { kind: 'before-wipe', name: 'Alice' }))))
            .toBe('⚠️ This phone was restored with a sign-in, so it has no 12 words for Alice. Without a connected sign-in, you cannot get Alice back.');
    });

    it('no action, no button (a screen that cannot reach Account Protection)', () => {
        expect(findAll(render(React.createElement(NoWordsNotice, { kind: 'before-wipe' })), 'Pressable')).toEqual([]);
    });
});
