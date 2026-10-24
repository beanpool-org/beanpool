// @vitest-environment jsdom
/**
 * The rest of words sweep B11 in the member's language: the Community Pricing Guide (components/PricingGuideModal.tsx),
 * the Ledger's credit bar (components/CreditBar.tsx) and repayment card (components/RepaymentCard.tsx), Pay the Commons
 * (app/pay-commons.tsx, with components/repayment-lines.ts), a group's invite landing (app/group/[id].tsx), the "?" sheet
 * (components/HelpSheet.tsx), "one way back" (components/OneWayBackCard.tsx), the saved-communities picker
 * (components/SavedNodePicker.tsx) and the sync badge (components/SyncStatus.tsx), drawn for real inside the real
 * LanguageProvider. React Native's host components are plain tags (profile-events-words-harness.ts); the node and the
 * phone's stores are stubbed at their modules.
 *
 * In the pseudo-locale (`xx`: every sentence accented, padded ~35 % and bracketed) any text, screen-reader label, hint,
 * placeholder or alert with letters outside a bracket bypassed t(). What members and communities wrote is shown as written
 * (a group's name and text, names, a community's address); so is the pricing catalog's own list (core or the node's).
 *
 * The lower layers that sign never reach the words layer, so their sentences are worded again where shown: each is held
 * here to the English its source writes (utils/names-debts.ts REPAYMENT_COPY for every variant, utils/one-way-back.ts
 * ONE_WAY_BACK_TEXT).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// SavedNodePicker writes JSX with no React in scope (the app's Babel adds it); this runner's transform needs it global.
(globalThis as any).React = React;

const alerts = vi.hoisted(() => ({ said: [] as string[], buttons: [] as Array<{ text?: string; onPress?: () => unknown }> }));
const shared = vi.hoisted(() => ({ messages: [] as string[] }));
vi.mock('react-native', async () => {
    const native = (await import('./profile-events-words-harness')).nativeMock(alerts);
    return { ...native, Share: { share: async (c: { message?: string }) => { if (c.message) shared.messages.push(c.message); return {}; } } };
});
vi.mock('react-native-safe-area-context', async () => {
    const { createElement: h } = await import('react');
    return { SafeAreaView: ({ children }: { children?: unknown }) => h('div', null, children as any), useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) };
});
vi.mock('react-native-keyboard-controller', async () => {
    const { createElement: h } = await import('react');
    const pass = ({ children }: { children?: unknown }) => h('div', null, children as any);
    return { KeyboardAwareScrollView: pass, KeyboardAvoidingView: pass };
});
const nav = vi.hoisted(() => ({ params: {} as Record<string, string>, pushed: [] as unknown[] }));
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: { push: (to: unknown) => nav.pushed.push(to), replace: (to: unknown) => nav.pushed.push(to), back: () => {}, canGoBack: () => true },
        useLocalSearchParams: () => nav.params,
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb() ?? undefined, [cb]),
        ErrorBoundary: () => null,
    };
});
vi.mock('@expo/vector-icons', async () => {
    const { createElement: h } = await import('react');
    return { MaterialCommunityIcons: ({ name }: { name: string }) => h('i', { 'data-icon': name }) };
});
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-haptics', () => ({ selectionAsync: async () => {}, impactAsync: async () => {}, notificationAsync: async () => {}, ImpactFeedbackStyle: {}, NotificationFeedbackType: {} }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)), randomUUID: () => '00000000-0000-4000-8000-000000000001' };
});
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const { onboardingColors } = await import('../onboarding-colors');
    const ctx = { colors: lightColors, theme: 'light' };
    return { useTheme: () => ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx), useOnboardingColors: () => onboardingColors('light') };
});
const who = vi.hoisted(() => ({ identity: { publicKey: '9'.repeat(64), privateKey: '8'.repeat(64), callsign: 'Wren' } }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: who.identity }) }));
vi.mock('../node-post', async (importOriginal) => ({ ...(await importOriginal<object>()), anchorUrl: async () => 'https://mullum.example' }));
/** The node, for Pay the Commons and the repayment card. */
const debt = vi.hoisted(() => ({ repayment: null as any, pay: null as any }));
vi.mock('../names-debts', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    fetchMyRepayment: vi.fn(async () => ({ ok: true, value: debt.repayment })),
    payTheCommons: vi.fn(async () => debt.pay),
}));
/** The node, for a group's landing. */
const grp = vi.hoisted(() => ({ group: undefined as any, members: [] as any[], error: null as null | Error, joinError: null as null | Error, left: [] as string[][] }));
vi.mock('../db', () => ({
    getGroupForLanding: vi.fn(async () => { if (grp.error) throw grp.error; return grp.group; }),
    getGroupActiveMembers: vi.fn(async () => grp.members),
    joinGroupApi: vi.fn(async () => { if (grp.joinError) throw grp.joinError; return {}; }),
    leaveGroupApi: vi.fn(async (groupId: string, pk: string) => { grp.left.push([groupId, pk]); return true; }),
    getMyPosts: vi.fn(async () => []),
}));
vi.mock('../../components/useYourGroups', () => ({ yourGroupsStore: { refresh: () => {} } }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => null }));
vi.mock('../haptics', () => ({ hapticSuccess: () => {}, hapticTick: () => {} }));
/** "One way back": the phone's record, and whether the key vault keeps a copy. */
const oneWay = vi.hoisted(() => ({ record: null as any, vault: false }));
vi.mock('../one-way-back', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    readOneWayBack: vi.fn(async () => oneWay.record),
    readOneWayBackAsked: vi.fn(async () => null),
    oneWayBackCommunity: () => null,
    oneWayBackPlace: () => 'card',
    withAccountDismissal: (found: unknown) => found,
    dismissOneWayBack: vi.fn(async () => {}),
    finishOneWayBack: vi.fn(async () => {}),
}));
vi.mock('../vault', () => ({ vaultCopyKnown: vi.fn(async () => oneWay.vault) }));
// The sign-in sheet is the key sweep's.
vi.mock('../../components/LinkSignInSheet', () => ({ LinkSignInSheet: () => null }));
vi.mock('../../services/pillar-sync', () => ({ getLastSyncTime: async () => Date.now() - 90_000 }));

import { DEFAULT_PRICING_CATALOG, PRICING_CATEGORIES, pseudoLocalise, setLanguage, type UiLang } from '@beanpool/core';
import { LanguageProvider, DrawnInLanguage } from '../../components/LanguageProvider';
import { LanguagePickerSheet } from '../../components/LanguagePicker';
import { PricingGuideModal } from '../../components/PricingGuideModal';
import { CreditBar } from '../../components/CreditBar';
import { RepaymentCard } from '../../components/RepaymentCard';
import PayCommonsScreen from '../../app/pay-commons';
import GroupInviteLanding from '../../app/group/[id]';
import { HelpSheet } from '../../components/HelpSheet';
import { OneWayBackCard, ONE_WAY_BACK_LINES } from '../../components/OneWayBackCard';
import { SavedNodePicker } from '../../components/SavedNodePicker';
import { SyncStatus } from '../../components/SyncStatus';
import { beansWords, linkLeftWords, paidWords, payConfirmWords, repaymentBannerWords, repaymentLineWords, REPAYMENT_LINES } from '../../components/repayment-lines';
import { DEBT_UNREACHABLE, PAY_REFUSED_UNSAID, PAY_UNANSWERED_RETRY, REPAYMENT_COPY, beans } from '../names-debts';
import { ONE_WAY_BACK_TEXT } from '../one-way-back';
import { lightColors } from '../../constants/colors';
import { bypassing, bracketed, unfit } from './profile-events-words-harness';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    alerts.said.length = 0;
    alerts.buttons = [];
    shared.messages.length = 0;
    nav.params = {};
    nav.pushed.length = 0;
    store.map.clear();
    store.map.set('beanpool_anchor_url', 'https://mullum.example');
    debt.repayment = null;
    debt.pay = { ok: true, value: { transactionId: 'tx-42', amount: 12.5 } };
    grp.group = undefined;
    grp.members = [];
    grp.error = null;
    grp.joinError = null;
    grp.left = [];
    oneWay.record = { url: 'https://global.example', joinedAt: Date.now() - 86_400_000, done: null };
    oneWay.vault = false;
    globalThis.fetch = vi.fn(async () => { throw new TypeError('offline'); }) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderIn(lang: UiLang, element: unknown) {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, element as any) as any); });
    await settle();
}
const xx = (s: string) => pseudoLocalise(s);
const byLabel = (shown: string) => host.querySelector(`[aria-label="${shown.replace(/"/g, '\\"')}"]`);
const buttonReading = (shown: string) => Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(shown)) ?? null;
const click = async (el: Element | null | undefined, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(6);
};
const type = async (el: Element | null | undefined, text: string) => {
    expect(el).toBeTruthy();
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el as HTMLInputElement, text);
        (el as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle(2);
};
const pressAlert = async (shown: string) => {
    const b = alerts.buttons.find((x) => x.text === shown);
    expect(b, shown).toBeTruthy();
    await act(async () => { await b!.onPress?.(); });
    await settle();
};

/** The pricing catalog's own words (core's list, or the node's): shown as written. */
const CATALOG = DEFAULT_PRICING_CATALOG.flatMap((i: any) => [i.name, i.description, i.seasonalityHint, i.unit].filter(Boolean)) as string[];

describe('the Community Pricing Guide in the pseudo-locale', () => {
    it('the header, the count, the search, the category chips, the tip, the items\' labels and the report sheet', async () => {
        await renderIn('xx', createElement(PricingGuideModal, { isOpen: true, onClose() {}, onSelectOfferItem() {} }));
        expect(host.textContent).toContain(xx('💡 Community Pricing Guide'));
        expect(host.textContent).toContain(xx('{n} items & services benchmarked').replace('{n}', String(DEFAULT_PRICING_CATALOG.length)));
        expect(host.querySelector(`[placeholder="${xx('Search produce, services, trades...')}"]`)).not.toBeNull();
        expect(host.textContent).toContain(xx('{emoji} {name}').replace('{emoji}', '🌟').replace('{name}', xx('All Items')));
        expect(host.textContent).toContain(xx('{emoji} {name}').replace('{emoji}', PRICING_CATEGORIES[0].emoji).replace('{name}', xx(PRICING_CATEGORIES[0].label)));
        expect(host.textContent).toContain(xx('Tap any item to auto-fill your offer listing with community price estimates.'));
        expect(host.textContent).toContain(xx('Offer →'));
        const first = DEFAULT_PRICING_CATALOG[0] as any;
        expect(byLabel(xx('Report price estimate for {name}').replace('{name}', first.name))).not.toBeNull();
        expect(bypassing(host, CATALOG, alerts.said)).toEqual([]);
        await click(byLabel(xx('Report price estimate for {name}').replace('{name}', first.name)), 'Report');
        expect(host.textContent).toContain(xx('🚩 Report Price: {name}').replace('{name}', first.name));
        expect(host.textContent).toContain(xx('📈 Too High'));
        expect(host.textContent).toContain(xx('Submit Feedback'));
        expect(bypassing(host, CATALOG, alerts.said)).toEqual([]);
    });

    it('a search with no matches', async () => {
        await renderIn('xx', createElement(PricingGuideModal, { isOpen: true, onClose() {} }));
        await type(host.querySelector(`[placeholder="${xx('Search produce, services, trades...')}"]`), 'zzzz');
        expect(host.textContent).toContain(xx('No items match "{query}"').replace('{query}', 'zzzz'));
        expect(host.textContent).toContain(xx('Community estimates based on local marketplace trades and seasonal averages.'));
        expect(bypassing(host, [...CATALOG, 'zzzz'], alerts.said)).toEqual([]);
    });
});

describe('the credit bar in the pseudo-locale, and its offer ladder\'s English word for word', () => {
    const bar = (props: Record<string, unknown>) => createElement(CreditBar, { colors: lightColors, ...props } as any);

    it('its spoken line, the bubble, the anchors, the hints and the ladder', async () => {
        await renderIn('xx', bar({ balance: 12.5, floor: -100, usableFloor: -25, liveOffers: 1, knownGrant: 0 }));
        expect(host.querySelector('[aria-label]')!.getAttribute('aria-label')).toMatch(/^\[.*\]$/s);
        expect(host.querySelector('[data-testid="credit-bar-label"]')!.textContent).toBe(xx('{balance} B').replace('{balance}', '+12.5'));
        for (const english of ['your limit', 'sweet spot', 'fee-free', '← carry credit', 'hold credit →']) expect(host.textContent, english).toContain(xx(english));
        expect(bypassing(host)).toEqual([]);
    });

    it('in English, as before: the ladder\'s two sentences with their bold parts and non-breaking spaces', async () => {
        await renderIn('en', bar({ balance: -10, floor: -100, usableFloor: -25, liveOffers: 1, knownGrant: 0 }));
        const ladder = Array.from(host.querySelectorAll('span')).find((s) => (s.textContent ?? '').startsWith('🎣'))!;
        expect(ladder.textContent).toMatch(/^🎣 1 offer unlocks\u00A0−25( · 2 offers\u00A0→\u00A0−\d+)?$/);
        act(() => root.unmount());
        root = createRoot(host);
        await renderIn('en', bar({ balance: 0, floor: -100, usableFloor: 0, liveOffers: 0, knownGrant: 0 }));
        const post = Array.from(host.querySelectorAll('span')).find((s) => (s.textContent ?? '').startsWith('🎣'))!;
        expect(post.textContent).toMatch(/^🎣 Post an offer to open your credit line — \d+ offers? unlocks? your\u00A0full\u00A0−100\.$/);
        expect(host.querySelector('[data-testid="credit-bar-label"]')!.textContent).toBe('+0 B');
        expect(bracketed(host)).toBe(0);
    });
});

describe('Pay the Commons and the repayment card in the pseudo-locale', () => {
    it('the form, a bad amount, the question before paying, the payment and its reference', async () => {
        await renderIn('xx', createElement(PayCommonsScreen));
        expect(host.textContent).toContain(xx(REPAYMENT_LINES.payTitle));
        expect(host.textContent).toContain(xx(REPAYMENT_LINES.payIntro));
        expect(host.textContent).toContain(xx('BEANS'));
        expect(host.querySelector(`[placeholder="${xx('For example {amount}').replace('{amount}', '12.50')}"]`)).not.toBeNull();
        expect(byLabel(xx('The pay-back code an admin gave you'))).not.toBeNull();
        expect(bypassing(host, [], alerts.said)).toEqual([]);
        await click(buttonReading(xx(REPAYMENT_LINES.payTitle)), 'Pay the Commons');
        expect(host.textContent).toContain(xx(REPAYMENT_COPY.badAmount));
        await type(byLabel(xx('How many Beans')), '12.50');
        await click(buttonReading(xx(REPAYMENT_LINES.payTitle)), 'Pay the Commons');
        expect(alerts.said).toEqual([xx(REPAYMENT_LINES.payTitle), xx('Pay {amount} to the Commons? This can’t be undone.').replace('{amount}', xx('{amount} Beans').replace('{amount}', '12.50')), xx('Cancel'), xx('Pay')]);
        await pressAlert(xx('Pay'));
        expect(host.textContent).toContain(xx('Paid {amount} to the Commons.').replace('{amount}', xx('{amount} Beans').replace('{amount}', '12.50')));
        await click(buttonReading(xx('Share the reference')), 'Share');
        expect(shared.messages).toEqual([xx('My payment to the Commons: {ref}').replace('{ref}', 'tx-42')]);
        expect(bypassing(host, ['tx-42'], alerts.said)).toEqual([]);
    });

    it('a lost answer, kept for Try again', async () => {
        debt.pay = { ok: false, status: 0, message: '' };
        await renderIn('xx', createElement(PayCommonsScreen));
        await type(byLabel(xx('How many Beans')), '5');
        await click(buttonReading(xx(REPAYMENT_LINES.payTitle)), 'Pay the Commons');
        await pressAlert(xx('Pay'));
        expect(host.textContent).toContain(xx(PAY_UNANSWERED_RETRY));
        expect(buttonReading(xx('Try again'))).not.toBeNull();
        expect(bypassing(host, [], alerts.said)).toEqual([]);
    });

    it("a refusal without the node's words (a proxy's 429 page): nothing was paid, in the member's language", async () => {
        // What payTheCommons answers a wordless 429 (names-debts.test.ts holds it to that): not unanswered, so no Try again.
        debt.pay = { ok: false, status: 429, message: PAY_REFUSED_UNSAID };
        await renderIn('xx', createElement(PayCommonsScreen));
        await type(byLabel(xx('How many Beans')), '5');
        await click(buttonReading(xx(REPAYMENT_LINES.payTitle)), 'Pay the Commons');
        await pressAlert(xx('Pay'));
        expect(host.textContent).toContain(xx(PAY_REFUSED_UNSAID));
        expect(host.textContent).not.toContain(PAY_REFUSED_UNSAID);
        expect(buttonReading(xx('Try again'))).toBeNull();
        expect(bypassing(host, [], alerts.said)).toEqual([]);
    });

    it('the repayment card: what is left, and the way to pay', async () => {
        debt.repayment = { amount: 200, repaid: 50, left: 150, debtId: 'a'.repeat(32) };
        await renderIn('xx', createElement(RepaymentCard));
        expect(host.textContent).toContain(repaymentBannerWords({ amount: 200, left: 150 }));
        expect(host.textContent).toMatch(/^\[/);
        expect(host.querySelector(`[data-hint="${xx('Pay Beans you hold to the Commons, or pay back a debt')}"]`)).not.toBeNull();
        expect(bypassing(host)).toEqual([]);
    });

    it("the sentences are names-debts.ts's, word for word in English, for every variant", () => {
        for (const n of [0.5, 1, 12, 12.5, 300]) expect(beansWords(n), String(n)).toBe(beans(n));
        const r = { amount: 200, repaid: 0, left: 200, debtId: 'x' };
        expect(repaymentBannerWords(r)).toBe(REPAYMENT_COPY.banner(r));
        expect(linkLeftWords(300)).toBe(REPAYMENT_COPY.linkLeft(300));
        expect(String(REPAYMENT_LINES.payTitle)).toBe(REPAYMENT_COPY.payTitle);
        expect(String(REPAYMENT_LINES.payIntro)).toBe(REPAYMENT_COPY.payIntro);
        for (const forDebt of [false, true]) {
            for (const sharedLeft of [null, 80]) {
                for (const openDebt of [false, true]) {
                    expect(payConfirmWords(200, forDebt, sharedLeft, openDebt), `${forDebt} ${sharedLeft} ${openDebt}`).toBe(REPAYMENT_COPY.payConfirm(200, forDebt, sharedLeft, openDebt));
                }
            }
        }
        for (const forDebt of [false, true]) {
            for (const answer of [{}, { settled: true }, { leftAfter: 40 }]) {
                for (const openDebt of [false, true]) {
                    expect(paidWords(200, 'tx-9', forDebt, answer, openDebt), `${forDebt} ${JSON.stringify(answer)} ${openDebt}`).toBe(REPAYMENT_COPY.paid(200, 'tx-9', forDebt, answer, openDebt));
                }
            }
        }
        for (const s of [DEBT_UNREACHABLE, PAY_UNANSWERED_RETRY, PAY_REFUSED_UNSAID, REPAYMENT_COPY.badAmount, REPAYMENT_COPY.badCode]) {
            expect(repaymentLineWords(s)).toBe(s);
            setLanguage('xx');
            expect(repaymentLineWords(s)).toMatch(/^\[.*\]$/s);
            setLanguage('en');
        }
        expect(repaymentLineWords('The Commons is closed today.')).toBe('The Commons is closed today.');
    });
});

describe("a group's invite landing in the pseudo-locale", () => {
    const GROUP = { id: 'g1', name: 'Seed Savers', category: 'garden', joinPolicy: 'invite_only', memberCount: 4, viewerStatus: 'invited',
        description: 'We swap seeds every spring.', viewerInvitedBy: { pubkey: '1'.repeat(64), callsign: 'Rosa', avatarUrl: null } };
    const MEMBERS = ['Rosa', 'Kofi', 'Ana', 'Lee'].map((callsign, i) => ({ memberPubkey: String(i + 1).repeat(64), callsign, role: i === 0 ? 'convenor' : 'member', avatarUrl: null }));
    const WRITTEN = ['Seed Savers', 'We swap seeds every spring.', 'Rosa', 'Kofi', 'Ana', 'Lee'];

    it('invited: who asked, the facts, the members and the convenor, the notice, Join, Not now', async () => {
        nav.params = { id: 'g1', invited: '1' };
        grp.group = GROUP;
        grp.members = MEMBERS;
        await renderIn('xx', createElement(GroupInviteLanding));
        expect(host.textContent).toContain(xx('**{name}** invited you to join').replace(/\*\*/g, '').replace('{name}', 'Rosa'));
        expect(host.textContent).toContain(xx("The group chat is visible to its members and this node's operator. Private things belong in a direct message."));
        expect(host.textContent).toContain(xx('Not now'));
        expect(bypassing(host, WRITTEN, alerts.said)).toEqual([]);
    });

    it("a join the node refused without its words, or the group's keys couldn't be read: the phone's sentences worded, the node's as given", async () => {
        nav.params = { id: 'g1', invited: '1' };
        grp.group = GROUP;
        grp.members = MEMBERS;
        await renderIn('xx', createElement(GroupInviteLanding));
        const cases: Array<[string, string]> = [
            ['The node answered 502.', xx('The node answered {status}.').replace('{status}', '502')],
            ["This phone couldn't check who is in this group just now. Nothing was sent; try again in a moment.",
                xx("This phone couldn't check who is in this group just now. Nothing was sent; try again in a moment.")],
            ['This node is serving an older key than one this app already holds.', xx('This node is serving an older key than one this app already holds.')],
            ['This group is full.', 'This group is full.'],
        ];
        for (const [thrown, body] of cases) {
            grp.joinError = new Error(thrown);
            alerts.said.length = 0;
            await click(byLabel(xx('Join the group')), 'Join the group');
            expect(alerts.said, thrown).toEqual([xx('Could not join'), body]);
        }
        expect(bypassing(host, WRITTEN, alerts.said.slice(0, -1))).toEqual([]);
    });

    it('an open invitation can be declined: asked once in words, then the member\'s own row goes and the landing closes', async () => {
        nav.params = { id: 'g1', invited: '1' };
        grp.group = GROUP;
        grp.members = MEMBERS;
        await renderIn('xx', createElement(GroupInviteLanding));
        const decline = host.querySelector('[data-testid="invite-landing-decline"]');
        expect(decline?.textContent).toBe(xx('Decline invitation'));
        await click(decline, 'Decline invitation');
        expect(alerts.said).toEqual([xx('Decline the invitation?'),
            xx('You will not join {name}. Whoever invited you can invite you again.').replace('{name}', 'Seed Savers'), xx('Cancel'), xx('Decline')]);
        expect(grp.left).toEqual([]);
        await act(async () => { await alerts.buttons.find(b => b.text === xx('Decline'))?.onPress?.(); });
        expect(grp.left).toEqual([['g1', who.identity.publicKey]]);
        expect(bypassing(host, WRITTEN, alerts.said)).toEqual([]);
        // Only an open invitation: a member's own landing (they are in) has no Decline.
        act(() => root.unmount());
        root = createRoot(host);
        grp.group = { ...GROUP, viewerStatus: 'active' };
        await renderIn('xx', createElement(GroupInviteLanding));
        expect(host.querySelector('[data-testid="invite-landing-decline"]')).toBeNull();
    });

    it('the states that are not the group: unreachable, unavailable, an invitation withdrawn', async () => {
        nav.params = { id: 'g1' };
        grp.error = new Error('');
        await renderIn('xx', createElement(GroupInviteLanding));
        expect(host.textContent).toContain(xx("Couldn't open this group"));
        expect(host.textContent).toContain(xx('Try again'));
        expect(bypassing(host, WRITTEN, alerts.said)).toEqual([]);
        act(() => root.unmount());
        root = createRoot(host);
        grp.error = null;
        grp.group = null;
        await renderIn('xx', createElement(GroupInviteLanding));
        expect(host.textContent).toContain(xx("This group isn't available"));
        expect(bypassing(host, WRITTEN, alerts.said)).toEqual([]);
        act(() => root.unmount());
        root = createRoot(host);
        nav.params = { id: 'g1', invited: '1' };
        grp.group = { ...GROUP, viewerStatus: null, viewerInvitedBy: null };
        await renderIn('xx', createElement(GroupInviteLanding));
        expect(host.textContent).toContain(xx('This invitation is no longer open'));
        expect(host.textContent).toContain(xx('{name} is invite only, and your invitation was withdrawn. Ask whoever invited you to invite you again.').replace('{name}', 'Seed Savers'));
        expect(bypassing(host, WRITTEN, alerts.said)).toEqual([]);
    });

    it('in English, word for word: the inviter in bold inside the sentence, the members, the convenor', async () => {
        nav.params = { id: 'g1', invited: '1' };
        grp.group = { ...GROUP, joinPolicy: 'open' };
        grp.members = MEMBERS;
        await renderIn('en', createElement(GroupInviteLanding));
        expect(host.textContent).toContain('Rosa invited you to join');
        expect(host.textContent).toMatch(/Rosa, Kofi, Ana and 1 more\nConvenor: /);
        expect(bracketed(host)).toBe(0);
    });

    it('at 320 dp with 1.3× text, nothing too wide; a language picked while it is open redraws it', async () => {
        nav.params = { id: 'g1', invited: '1' };
        grp.group = GROUP;
        grp.members = MEMBERS;
        await renderIn('xx', createElement(GroupInviteLanding));
        expect(unfit(host, 320 - 40, WRITTEN)).toEqual([]);
        act(() => root.unmount());
        root = createRoot(host);
        const fr = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../words/fr.json'), 'utf8')) as Record<string, unknown>;
        await act(async () => {
            root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'] },
                createElement(DrawnInLanguage, null, createElement(GroupInviteLanding)),
                createElement(LanguagePickerSheet, { visible: true, onClose() {} })) as any);
        });
        await settle();
        expect(byLabel('Close')).not.toBeNull();
        await click(host.querySelector('[data-testid="language-fr"]'), 'Français');
        await settle();
        expect(typeof fr.Close).toBe('string');
        expect(byLabel(fr.Close as string)).not.toBeNull();
        expect(host.textContent).toContain(fr['Not now'] as string);
    });
});

describe('the small ones in the pseudo-locale', () => {
    it('the "?" sheet: its stand-in title, Close, and its rows (the guide\'s words are its own)', async () => {
        await renderIn('xx', createElement(HelpSheet, {
            visible: true, sheet: { title: null, text: null, slug: 'market', section: null } as any, tourOpen: false, canTour: true, colors: lightColors,
            onReadPage() {}, onSearch() {}, onTour() {}, onClose() {},
        }));
        expect(host.textContent).toContain(xx('Help'));
        expect(byLabel(xx('Close help'))).not.toBeNull();
        expect(host.textContent).toContain(xx('Read the guide page ›'));
        expect(host.textContent).toContain(xx('Search the guide'));
        expect(host.textContent).toContain(xx('Take the tour again'));
        expect(bypassing(host)).toEqual([]);
    });

    it('"one way back", in Settings: the card and, after "I still have my 12 words", the quiet line', async () => {
        await renderIn('xx', createElement(OneWayBackCard, { place: 'settings', colors: lightColors }));
        expect(host.textContent).toContain(xx(ONE_WAY_BACK_LINES.body));
        expect(byLabel(xx(ONE_WAY_BACK_LINES.title))).not.toBeNull();
        expect(host.textContent).toContain(xx(ONE_WAY_BACK_LINES.addSignIn));
        expect(host.querySelector(`[data-hint="${xx('Says you checked you still have your 12 words written down')}"]`)).not.toBeNull();
        expect(bypassing(host)).toEqual([]);
        act(() => root.unmount());
        root = createRoot(host);
        oneWay.record = { ...oneWay.record, done: 'checked' };
        await renderIn('xx', createElement(OneWayBackCard, { place: 'settings', colors: lightColors }));
        expect(host.textContent).toContain(xx('A sign-in can be a second way back, and it lifts the limits on new 12-words accounts.'));
        expect(bypassing(host)).toEqual([]);
    });

    it('"one way back"\'s words are utils/one-way-back.ts\'s, word for word', () => {
        for (const k of Object.keys(ONE_WAY_BACK_TEXT) as Array<keyof typeof ONE_WAY_BACK_TEXT>) expect(String(ONE_WAY_BACK_LINES[k]), k).toBe(ONE_WAY_BACK_TEXT[k]);
        expect(Object.keys(ONE_WAY_BACK_LINES).sort()).toEqual(Object.keys(ONE_WAY_BACK_TEXT).sort());
    });

    it('the saved-communities picker\'s spoken row, and the sync badge', async () => {
        await renderIn('xx', createElement(SavedNodePicker, {
            nodes: [{ url: 'https://lismore.example', alias: 'Lismore Commons' }] as any, onPick() {}, label: xx('Your communities'), actionLabel: xx('Switch to'),
        }));
        expect(byLabel(xx('{action} {name}').replace('{action}', xx('Switch to')).replace('{name}', 'Lismore Commons'))).not.toBeNull();
        expect(bypassing(host, ['Lismore Commons', 'lismore.example'])).toEqual([]);
        act(() => root.unmount());
        root = createRoot(host);
        await renderIn('xx', createElement(SyncStatus));
        expect(host.textContent).toContain(xx('Online'));
        expect(host.querySelector('[aria-label]')!.getAttribute('aria-label')).toBe(xx('Sync status: Online, last synced {ago}').replace('{ago}', xx('{n}m ago').replace('{n}', '1')));
        expect(bypassing(host)).toEqual([]);
    });
});
