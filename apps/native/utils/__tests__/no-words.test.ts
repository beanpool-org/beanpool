import { describe, it, expect, vi } from 'vitest';
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

// The provider buttons draw SVG logos; only their titles matter here.
vi.mock('../../components/SsoButton', () => {
    const button = (name: string) => (props: { title: string; onPress: () => void }) =>
        React.createElement('SsoButton', { name, onPress: props.onPress }, props.title);
    return {
        AppleButton: button('apple'),
        GoogleButton: button('google'),
        FacebookButton: button('facebook'),
        GitHubButton: button('github'),
    };
});

import { KeeperProtectionPanel, SIGN_IN_COPY_OPENERS, SIGN_IN_COPY_WORDS_ONLY } from '../../components/KeeperProtectionPanel';
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

function panel(protection: typeof WORDS_ONLY, hasWords: boolean, onProtectSso = vi.fn()) {
    return render(React.createElement(KeeperProtectionPanel, { protection, hasWords, onProtectSso, onDisconnectSso: vi.fn() }));
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
        expect(buttons.map(b => b.props.name)).toEqual(['google', 'facebook', 'github']);
        buttons[1].props.onPress();
        expect(onProtectSso).toHaveBeenCalledWith('facebook');
    });

    it('covered: nothing on the panel mentions 12 words', () => {
        const text = textOf(panel(COVERED, false));
        expect(text).toContain('Facebook Connected');
        expect(text).not.toMatch(/12 words|written down/i);
        expect(text).toContain('It only works while your hub is running.');
    });

    // Was "reads exactly as before", pinning "It does not hand your 12 words back". A sign-in connected from a
    // phone with the words now seals them too (keeper-enrolment.ts), so that sentence became untrue; the panel
    // now says which sign-ins give the words back, and everything else a member with words reads is unchanged.
    it('a phone with words is told which sign-ins give the words back, and otherwise reads as before', () => {
        const text = textOf(panel(WORDS_ONLY, true));
        expect(text).toContain('🔑 Your 12 words are your primary recovery');
        expect(text).toContain('Your 12 words are your primary key to your account. Write them down safely.');
        expect(text).toContain(`restores your account on a new phone. ${SSO_WORDS_NOTE} It only works while your hub is running — so keep the words written down.`);
        expect(SSO_WORDS_NOTE).toBe('A sign-in connected on this version of the app brings your 12 words back too. One connected on an earlier version brings back your account without them: tap Connect again to include them.');
        expect(text).not.toMatch(/does not hand your 12 words back/);
        expect(text).not.toContain(NO_WORDS_WAY_BACK);

        expect(textOf(panel(COVERED, true))).toContain('so keep the words written down');
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

// Recovery seal S3 (Marty, card sso-copy-lock, D-2 = a): under a connected sign-in, who can open the copy it keeps.
describe('KeeperProtectionPanel: who can open a sign-in copy', () => {
    it('the sentences, word for word: the operators can, a stolen database cannot, the words alone keep everyone else out', () => {
        expect(SIGN_IN_COPY_OPENERS).toBe(
            "The people who run your community's server can open the copy of your account kept for your sign-in, because their server checks your sign-in. A stolen copy of the server's database can't, once the server has been updated for it.");
        expect(SIGN_IN_COPY_WORDS_ONLY).toBe('If you would rather nobody but you could get in, use only your 12 words.');
    });

    it('under a connected sign-in on a phone with words: all of it, after the sign-in and before the not-a-login note', () => {
        const text = textOf(panel(COVERED, true));
        const line = `${SIGN_IN_COPY_OPENERS} ${SIGN_IN_COPY_WORDS_ONLY}`;
        expect(text.split('\n')).toContain(line);
        expect(text.indexOf('Facebook Connected')).toBeLessThan(text.indexOf(line));
        expect(text.indexOf(line)).toBeLessThan(text.indexOf('This is not a login'));
    });

    it('on a phone with no 12 words: who can open it, and never "use only your 12 words"', () => {
        const text = textOf(panel(COVERED, false));
        expect(text.split('\n')).toContain(SIGN_IN_COPY_OPENERS);
        expect(text).not.toContain(SIGN_IN_COPY_WORDS_ONLY);
    });

    it('with no sign-in connected, nothing: there is no copy to talk about', () => {
        expect(textOf(panel(WORDS_ONLY, true))).not.toContain(SIGN_IN_COPY_OPENERS);
        expect(textOf(panel(WORDS_ONLY, false))).not.toContain(SIGN_IN_COPY_OPENERS);
    });

    it('covered with one sign-in: the footnote no longer says the server cannot open it alone', () => {
        const text = textOf(panel(COVERED, true));
        expect(text).not.toMatch(/Neither of them can open/);
        expect(text).toContain("Your sign-in account can't restore your account alone — it takes your community's server too.");
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
