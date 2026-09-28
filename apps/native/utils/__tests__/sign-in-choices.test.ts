/**
 * The sign-ins a member is offered are Apple (on the iPhone), Google and Facebook, wherever the app offers one:
 * Account Protection's "Protect with" (components/KeeperProtectionPanel.tsx), the global door's "Continue with" and
 * the restore screen's "Recover with" (app/welcome.tsx). GitHub is not a BeanPool sign-in (owner, 2026-09-29): no
 * button, logo or row for it, and a provider name the app does not offer, whether a node's answer or a record an
 * earlier build saved on the phone, is dropped where it is read, so nothing renders or counts it.
 *
 * The panel is rendered with the real provider buttons (host components as plain tags, as no-words.test.ts does).
 * The welcome screen cannot be rendered here (see vitest.config.ts), so its lists are read from its source.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import * as fs from 'node:fs';
import * as path from 'node:path';

const rn = vi.hoisted(() => ({ Platform: { OS: 'android' as string } }));

vi.mock('react-native', () => ({
    Platform: rn.Platform,
    StyleSheet: { create: <T,>(s: T) => s },
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    TouchableOpacity: 'TouchableOpacity',
    DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
}));
vi.mock('react-native-svg', () => ({ default: 'Svg', Path: 'Path' }));
vi.mock('expo-apple-authentication', () => ({
    isAvailableAsync: vi.fn(async () => false),
    signInAsync: vi.fn(),
    AppleAuthenticationScope: { EMAIL: 0, FULL_NAME: 1 },
}));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn(), dismissAuthSession: vi.fn() }));
vi.mock('expo-linking', () => ({ addEventListener: vi.fn(() => ({ remove: vi.fn() })) }));
vi.mock('../node-post', () => ({ signedPost: vi.fn(), anchorUrl: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) },
}));

import * as SsoButtons from '../../components/SsoButton';
import { KeeperProtectionPanel } from '../../components/KeeperProtectionPanel';
import { protectionFrom } from '../protection-state';
import { resumePlan, type PendingOnboarding } from '../onboarding-state';
import { readNonceResponse } from '../sso-signin';
import { SSO_PROVIDERS, SSO_PROVIDER_NAMES, isSsoProvider, offeredProviders } from '../sso-providers';

type Host = { type: string; props: Record<string, any>; children: Node[] };
type Node = Host | string;

/** Expands function components (none of these has hooks) down to host elements. */
function render(node: unknown): Node[] {
    if (node === null || node === undefined || typeof node === 'boolean') return [];
    if (typeof node === 'string' || typeof node === 'number') return [String(node)];
    if (Array.isArray(node)) return node.flatMap(render);
    const el = node as React.ReactElement<Record<string, any>>;
    if (el.type === React.Fragment) return render(el.props.children);
    if (typeof el.type === 'function') return render((el.type as (p: unknown) => unknown)(el.props));
    return [{ type: el.type as string, props: el.props, children: render(el.props.children) }];
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

/** Everything on screen as one string: the text, and every label a screen reader is given. */
function everythingShown(nodes: Node[]): string {
    const parts: string[] = [];
    const walk = (n: Node) => {
        if (typeof n === 'string') { parts.push(n); return; }
        if (typeof n.props.accessibilityLabel === 'string') parts.push(n.props.accessibilityLabel);
        n.children.forEach(walk);
    };
    nodes.forEach(walk);
    return parts.join('\n');
}

function panel(protection: ReturnType<typeof protectionFrom>, hasWords: boolean, onProtectSso = vi.fn()) {
    return render(React.createElement(KeeperProtectionPanel, { protection, hasWords, onProtectSso, onDisconnectSso: vi.fn() }));
}

/** The "Protect with" buttons: the real ones, which the panel draws as TouchableOpacity with the title as label. */
function protectButtons(tree: Node[]): Host[] {
    return findAll(tree, 'TouchableOpacity').filter((b) => /^Protect with /.test(b.props.accessibilityLabel ?? ''));
}

beforeEach(() => {
    rn.Platform.OS = 'android';
});

describe('the sign-ins the app offers', () => {
    it('are Apple, Google and Facebook, and nothing else', () => {
        expect([...SSO_PROVIDERS]).toEqual(['apple', 'google', 'facebook']);
        expect(SSO_PROVIDER_NAMES).toEqual({ apple: 'Apple', google: 'Google', facebook: 'Facebook' });
        expect(isSsoProvider('github')).toBe(false);
        expect(offeredProviders(['github', 'google', 'twitter', 7, null, 'apple'])).toEqual(['google', 'apple']);
        expect(offeredProviders('google')).toEqual([]);
    });

    it('the provider buttons are Apple, Google and Facebook: there is no GitHub button or logo to draw', () => {
        const exported = Object.keys(SsoButtons).sort();
        expect(exported).toEqual(['AppleButton', 'AppleLogo', 'FacebookButton', 'FacebookLogo', 'GoogleButton', 'GoogleLogo']);
        expect(exported.join(' ')).not.toMatch(/github/i);
    });
});

describe('Account Protection offers only those', () => {
    for (const [os, offered] of [
        ['android', ['google', 'facebook']],
        ['ios', ['apple', 'google', 'facebook']],
    ] as const) {
        for (const hasWords of [true, false]) {
            it(`${os}, ${hasWords ? 'with' : 'without'} the 12 words: one "Protect with" button per offered sign-in, in order, and no GitHub`, () => {
                rn.Platform.OS = os;
                const onProtectSso = vi.fn();
                const tree = panel(protectionFrom(null), hasWords, onProtectSso);

                const buttons = protectButtons(tree);
                expect(buttons.map((b) => b.props.accessibilityLabel))
                    .toEqual(offered.map((p) => `Protect with ${SSO_PROVIDER_NAMES[p]}`));
                buttons.forEach((b) => b.props.onPress());
                expect(onProtectSso.mock.calls.map((c) => c[0])).toEqual([...offered]);
                expect(everythingShown(tree)).not.toMatch(/github/i);
            });
        }
    }

    it('a sign-in list naming a provider the app does not offer shows only the ones it does', () => {
        rn.Platform.OS = 'ios';
        const protection = protectionFrom({
            enrolled: ['sso', 'sso'], generation: 1, skipped: [], available: 2,
            enrolledSso: ['github', 'google'], threshold: 1, isSingleBlob: true,
        });
        expect(protection.enrolledSso).toEqual(['google']);

        const tree = panel(protection, true);
        const shown = everythingShown(tree);
        expect(shown.match(/\w+ connected as a recovery provider/g)).toEqual(['Google connected as a recovery provider']);
        expect(shown).not.toMatch(/github/i);
        // Google is connected, so its button gives way to its row; the others are still offered.
        expect(protectButtons(tree).map((b) => b.props.accessibilityLabel)).toEqual(['Protect with Apple', 'Protect with Facebook']);
        // One sign-in, said as one: the footnote for several is not shown.
        expect(shown).not.toMatch(/Protected by \d+ sign-in accounts/);
    });

    it('a list naming only a provider the app does not offer shows no connected row at all', () => {
        const tree = panel(protectionFrom({
            enrolled: ['sso'], generation: 1, skipped: [], available: 1, enrolledSso: ['github'], threshold: 1, isSingleBlob: true,
        }), true);
        const shown = everythingShown(tree);
        expect(shown).not.toMatch(/github/i);
        expect(shown).not.toMatch(/connected as a recovery provider/);
        expect(protectButtons(tree).map((b) => b.props.accessibilityLabel)).toEqual(['Protect with Google', 'Protect with Facebook']);
    });
});

describe('what the phone reads from outside its own code', () => {
    it("a node's nonce answer: only the providers the app offers", () => {
        expect(readNonceResponse({ nonce: 'n', providers: ['apple', 'google', 'facebook', 'github'] }).providers)
            .toEqual(['apple', 'google', 'facebook']);
        expect(readNonceResponse({ nonce: 'n', providers: ['github'] }).providers).toEqual([]);
    });

    const KEY = 'ab'.repeat(32);
    const STORED = { publicKey: KEY, privateKey: '07'.repeat(32), callsign: 'Sam', createdAt: '2026-09-26T00:00:00Z' } as any;
    const saved = (enrolledSso: string[]): PendingOnboarding => ({
        step: 'seedBackup', flow: 'global', inviteCode: '', anchorUrl: 'https://global.beanpool.org', callsign: 'Sam', redeemed: true,
        joinEnrolment: {
            enrolled: enrolledSso.map(() => 'sso' as const), generation: 1, skipped: [], available: enrolledSso.length,
            enrolledSso, threshold: 1, isSingleBlob: true, wordsSealed: true,
        },
    });

    it('a join record an earlier build saved, naming only a sign-in the app does not offer: no enrolment, so Safety Backup offers the connect', () => {
        const plan = resumePlan(saved(['github']), STORED);
        expect(plan).toMatchObject({ action: 'resume', mode: 'seedBackup', joinEnrolment: null });
        if (plan.action !== 'resume') throw new Error('expected resume');
        expect(protectionFrom(plan.joinEnrolment).state).toBe('words-only');
    });

    it('a join record naming it beside one the app offers: that one alone, counted again', () => {
        const plan = resumePlan(saved(['google', 'github']), STORED);
        if (plan.action !== 'resume') throw new Error('expected resume');
        expect(plan.joinEnrolment).toMatchObject({ enrolledSso: ['google'], enrolled: ['sso'], available: 1, wordsSealed: true });
    });

    it('a join record naming only offered sign-ins is kept exactly as saved', () => {
        const record = saved(['apple', 'google']);
        const plan = resumePlan(record, STORED);
        if (plan.action !== 'resume') throw new Error('expected resume');
        expect(plan.joinEnrolment).toBe(record.joinEnrolment);
    });
});

describe('the welcome screen and the other sign-in screens', () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf-8');
    const called = (src: string, fn: string) => [...src.matchAll(new RegExp(`${fn}\\('(\\w+)'\\)`, 'g'))].map((m) => m[1]);

    it('the global door offers "Continue with" Apple, Google and Facebook, and nothing else', () => {
        expect(called(read('app/welcome.tsx'), 'handleGlobalSignIn')).toEqual(['apple', 'google', 'facebook']);
    });

    it('the restore screen offers "Recover with" Apple, Google and Facebook, and nothing else', () => {
        expect(called(read('app/welcome.tsx'), 'handleSsoRecover')).toEqual(['apple', 'google', 'facebook']);
    });

    it.each([
        'app/welcome.tsx',
        'app/(tabs)/settings.tsx',
        'app/+native-intent.ts',
        'components/SsoButton.tsx',
        'components/SsoEnrolSheet.tsx',
        'components/KeeperProtectionPanel.tsx',
        'utils/sso-signin.ts',
        'utils/sso-recovery.ts',
        'utils/sso-sheet-connect.ts',
        'utils/sso-providers.ts',
        'utils/keeper-enrolment.ts',
        'utils/protection-state.ts',
        'utils/global-join.ts',
    ])('%s never mentions GitHub', (rel) => {
        expect(read(rel)).not.toMatch(/github/i);
    });

    it('no screen answers a GitHub return', () => {
        expect(fs.readdirSync(path.resolve(__dirname, '../../app/auth')).join(' ')).not.toMatch(/github/i);
    });
});
