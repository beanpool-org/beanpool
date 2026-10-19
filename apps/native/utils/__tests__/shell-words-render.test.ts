// @vitest-environment jsdom
/**
 * The app shell in the member's language (words slice S3, sweep B11): "Update required" (components/ForceUpdateBlock.tsx),
 * the tour bar (components/TourBar.tsx), the header (components/GlobalHeader.tsx: words only), the guide's pages
 * (app/guide/[slug].tsx, app/guide/section/[id].tsx) and the re-key prompt app/_layout.tsx raises (components/
 * shell-lines.ts), drawn for real inside the real LanguageProvider. React Native's host components are plain tags
 * (profile-events-words-harness.ts); the update gate, the phone's lock and key store, the ways out of the block, the
 * guide's videos and the node are stubbed at their modules.
 *
 * "Update required" must never hold back a member who reads no English: every page of it is drawn in the pseudo-locale
 * (`xx`: every sentence accented, padded ~35 % and bracketed), where any text, screen-reader label or alert with letters
 * outside a bracket bypassed t(), and a language picked while it is up redraws it (it sits outside the navigator a pick
 * redraws). The 12 words are shown as they are, never through the words layer; a community's name as it wrote it.
 *
 * Other sweeps' components the block draws are stand-ins here: the 12 words' screen-capture guards and notes
 * (components/WordsOnScreen.tsx, the welcome sweep's), the add-words form and App Lock's surface (the key sweep's).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Module from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// ForceUpdateBlock writes JSX with no React in scope (the app's Babel adds it); this runner's transform needs it global.
(globalThis as any).React = React;
// The header's bean: an image the app bundles.
(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
vi.hoisted(() => {
    const Loader = (process as any).getBuiltinModule('node:module');
    Loader._extensions['.jpg'] = (m: { exports: unknown }) => { m.exports = 1; };
    Loader._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
});

const alerts = vi.hoisted(() => ({ said: [] as string[], buttons: [] as Array<{ text?: string; onPress?: () => unknown }> }));
/** The platform the block is drawn for: iOS draws its pages in its own overlay, Android in a window after a short wait. */
const plat = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android', select: (o: Record<string, unknown>) => o.ios ?? o.default }));
vi.mock('react-native', async () => {
    const native = (await import('./profile-events-words-harness')).nativeMock(alerts);
    return { ...native, Platform: plat };
});
vi.mock('react-native-screens', async () => {
    const { createElement: h } = await import('react');
    return { FullWindowOverlay: ({ children }: { children?: unknown }) => h('div', { 'data-overlay': 'true' }, children as any) };
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
const nav = vi.hoisted(() => ({ params: {} as Record<string, string>, pushed: [] as unknown[], path: '/' }));
vi.mock('expo-router', () => ({
    router: { push: (to: unknown) => nav.pushed.push(to), replace: (to: unknown) => nav.pushed.push(to), back: () => {}, canGoBack: () => true, canDismiss: () => false, dismissAll: () => {} },
    useLocalSearchParams: () => nav.params,
    usePathname: () => nav.path,
    ErrorBoundary: () => null,
}));
vi.mock('@expo/vector-icons', async () => {
    const { createElement: h } = await import('react');
    return { MaterialCommunityIcons: ({ name }: { name: string }) => h('i', { 'data-icon': name }) };
});
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.2.70' } } }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)), randomUUID: () => 'uuid' };
});
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
        getAllKeys: vi.fn(async () => [...store.map.keys()]),
        multiRemove: vi.fn(async () => {}),
    },
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { colors: lightColors, theme: 'light' };
    return { useTheme: () => ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx) };
});
const who = vi.hoisted(() => ({ identity: { publicKey: '9'.repeat(64), privateKey: '8'.repeat(64), callsign: 'Wren' } as any, words: true }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: who.identity, setIdentity: () => {} }) }));
vi.mock('../../app/NodeStatusContext', () => ({ useNodeStatus: () => ({ recheck: async () => 'member' }) }));
vi.mock('../../modules/boot-clock', () => ({ bootClockMs: () => null }));
vi.mock('../community-switch', () => ({ onCommunitySwitched: () => () => {}, communitySwitched: () => {} }));
/** The update gate shows the block at once, at this version. */
vi.mock('../force-update', () => ({
    createForceUpdateGate: ({ show }: { show: (b: { version: string }) => void }) => ({ start: async () => { show({ version: '1.3.0' }); }, appStateChanged: async () => {}, communitySwitched: async () => {} }),
    checkCommunityForUpdate: async () => null,
    STORE_URLS: { ios: { app: 'itms-apps://x', web: 'https://x' }, android: { app: 'market://x', web: 'https://x' } },
    appVersionHeaderValue: () => '1.2.70',
}));
vi.mock('../identity', () => ({ hasMnemonic: () => who.words }));
vi.mock('../LocalAuth', () => ({
    authenticateUser: vi.fn(async () => true), doorPrompts: () => 0, isAppLockPromptOpen: () => false, whenAppLockPromptsClose: async () => {},
}));
const WORDS = ['apple', 'banana', 'cherry', 'delta', 'eagle', 'falcon', 'grape', 'harbor', 'island', 'jungle', 'kettle', 'lemon'];
/** The ways out (utils/update-block-escape.ts) and the key store: set per case. */
const out = vi.hoisted(() => ({
    others: [] as Array<{ url: string; name: string }>,
    plan: null as any,
    switchError: null as null | Error,
    wordsError: null as null | Error,
    reasons: [] as string[],
}));
vi.mock('../update-block-escape', () => ({
    otherCommunitiesOnPhone: async () => out.others,
    planLeaveFromUpdateBlock: async () => out.plan,
    switchFromUpdateBlock: async () => { if (out.switchError) throw out.switchError; },
    leaveFromUpdateBlock: async () => ({ kind: 'left' }),
}));
vi.mock('../words-behind-lock', () => ({
    readWordsBehindLock: vi.fn(async (_id: unknown, reason: string) => { out.reasons.push(reason); if (out.wordsError) throw out.wordsError; return WORDS; }),
}));
vi.mock('../status-bar-hold', () => ({ holdStatusBarStyle: () => () => {} }));
vi.mock('../words-clipboard', () => ({ copyWordsForAMinute: async () => {} }));
vi.mock('../words-put-away', () => ({ usePutAwayAfterLeave: () => {} }));
vi.mock('../../components/AddWordsForm', () => ({ AddWordsForm: () => null }));
vi.mock('../../components/AppLock', () => ({ AppLockSurface: ({ children }: { children?: unknown }) => children }));
vi.mock('../../components/WordsOnScreen', () => {
    const pass = ({ children }: { children?: unknown }) => children;
    return { WordsOutsideScreens: pass, NoScreenCapture: pass, CopyClearsNote: () => null, NoScreenLockNote: () => null };
});
// The header's neighbours, drawn elsewhere: what needs you (its own tests) and the avatar (the profile sweep's).
vi.mock('../../components/NeedsYouIcons', () => ({ NeedsYouIcons: () => null }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => null }));
vi.mock('../db', () => ({ getMemberProfile: async () => null }));
vi.mock('../../services/pillar-sync', () => ({ getLastSyncTime: async () => Date.now() }));
const learn = vi.hoisted(() => ({ video: null as null | { url: string; title: string } }));
vi.mock('../use-learn-videos', () => ({ useLearnVideos: () => [] }));
vi.mock('../guide', async (importOriginal) => {
    const real = await importOriginal<typeof import('../guide')>();
    return { ...real, findGuideVideo: () => learn.video };
});
vi.mock('../use-guide', async () => {
    const { getBundledGuide } = await vi.importActual<typeof import('../guide')>('../guide');
    return { useGuide: () => ({ guide: getBundledGuide(), source: 'bundled' }) };
});

import { pseudoLocalise, setLanguage, tourSteps, type UiLang } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import { LanguagePickerSheet } from '../../components/LanguagePicker';
import ForceUpdateBlock from '../../components/ForceUpdateBlock';
import { TourBar } from '../../components/TourBar';
import { GlobalHeader } from '../../components/GlobalHeader';
import GuideScreen from '../../app/guide/[slug]';
import GuideSectionScreen from '../../app/guide/section/[id]';
import { rekeyPromptWords } from '../../components/shell-lines';
import { KEY_SUCCESSION_PROMPT_NO, KEY_SUCCESSION_PROMPT_YES, keySuccessionPromptText } from '../key-succession';
import { getBundledGuide, findGuidePage, findGuideSection, relatedPages, sectionPages, splitBold } from '../guide';
import { lightColors } from '../../constants/colors';
import appConfig from '../../app.json';
import { bypassing, bracketed, unfit } from './profile-events-words-harness';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    alerts.said.length = 0;
    alerts.buttons = [];
    plat.OS = 'ios';
    nav.params = {};
    nav.pushed.length = 0;
    nav.path = '/';
    store.map.clear();
    who.identity = { publicKey: '9'.repeat(64), privateKey: '8'.repeat(64), callsign: 'Wren' };
    who.words = true;
    out.others = [{ url: 'https://lismore.example', name: 'Lismore Commons' }];
    out.plan = { hereName: 'Mullum Commons', next: { url: 'https://lismore.example', name: 'Lismore Commons' } };
    out.switchError = null;
    out.wordsError = null;
    out.reasons.length = 0;
    learn.video = null;
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
/** What communities wrote, and the 12 words, which are shown as they are. */
const WRITTEN = ['Mullum Commons', 'Lismore Commons', 'Wren', ...WORDS];

describe('"Update required" in the pseudo-locale: every page, every word through t() (words S3l)', () => {
    it('the main page on an iPhone: the title, the store sentence, Update, another community, the account, Leave', async () => {
        await renderIn('xx', createElement(ForceUpdateBlock));
        expect(host.textContent).toContain(xx('Update required'));
        expect(host.textContent).toContain(xx('Your community needs a newer BeanPool than the one on this phone ({version}). Version {latest} is waiting in the App Store.')
            .replace('{version}', appConfig.expo.version).replace('{latest}', '1.3.0'));
        expect(byLabel(xx('Update BeanPool in the App Store'))).not.toBeNull();
        expect(host.textContent).toContain(xx('Use another community'));
        expect(byLabel(xx('Use {name}').replace('{name}', 'Lismore Commons'))).not.toBeNull();
        expect(host.textContent).toContain(xx('See my 12 words'));
        expect(host.textContent).toContain(xx('Leave this community'));
        expect(bracketed(host)).toBeGreaterThan(8);
        expect(bypassing(host, WRITTEN, alerts.said)).toEqual([]);
    });

    it('the main page on Android: Google Play, in its own sentence', async () => {
        plat.OS = 'android';
        await renderIn('xx', createElement(ForceUpdateBlock));
        await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
        await settle();
        expect(host.textContent).toContain(xx('Your community needs a newer BeanPool than the one on this phone ({version}). Version {latest} is waiting in Google Play.')
            .replace('{version}', appConfig.expo.version).replace('{latest}', '1.3.0'));
        expect(byLabel(xx('Update BeanPool in Google Play'))).not.toBeNull();
        expect(bypassing(host, WRITTEN, alerts.said)).toEqual([]);
    });

    it('the 12 words page: the lock asked in the member\'s language, the warning, Copy, Hide; each word as it is', async () => {
        await renderIn('xx', createElement(ForceUpdateBlock));
        await click(buttonReading(xx('See my 12 words')), 'See my 12 words');
        expect(out.reasons).toEqual([xx('Confirm your security to view your recovery phrase.')]);
        expect(host.textContent).toContain(xx('Your 12 words'));
        expect(host.textContent).toContain(xx('Never share them with anyone. Write them down on paper and keep it somewhere safe.'));
        expect(byLabel(xx('Word {n}: {word}').replace('{n}', '1').replace('{word}', 'apple'))).not.toBeNull();
        expect(host.textContent).toContain(xx('Copy words'));
        expect(host.textContent).toContain(xx('Hide them'));
        expect(bypassing(host, WRITTEN, alerts.said)).toEqual([]);
    });

    it('leaving with another community on the phone, and leaving the last one (the words first)', async () => {
        await renderIn('xx', createElement(ForceUpdateBlock));
        await click(buttonReading(xx('Leave this community')), 'Leave this community');
        expect(host.textContent).toContain(xx('Leave {name}?').replace('{name}', 'Mullum Commons'));
        expect(host.textContent).toContain(xx('This phone forgets {here}: its copy on this phone goes, and the app opens {next}. Your account, your 12 words and your other communities stay on this phone.')
            .replace('{here}', 'Mullum Commons').replace('{next}', 'Lismore Commons'));
        expect(host.textContent).toContain(xx('Leave {name}').replace('{name}', 'Mullum Commons'));
        expect(host.textContent).toContain(xx('Cancel'));
        expect(bypassing(host, WRITTEN, alerts.said)).toEqual([]);
        await click(buttonReading(xx('Cancel')), 'Cancel');
        out.plan = { hereName: 'Mullum Commons', next: null };
        await click(buttonReading(xx('Leave this community')), 'Leave this community');
        expect(host.textContent).toContain(xx('{here} is the only community on this phone, so leaving it takes your account off this phone, as Sign Out does. Nothing is deleted at {here}.')
            .split('{here}').join('Mullum Commons'));
        await click(buttonReading(xx('Show my 12 words first')), 'Show my 12 words first');
        expect(out.reasons.at(-1)).toBe(xx('Confirm authentication to take this account off this phone.'));
        expect(host.textContent).toContain(xx('Write these 12 words down first'));
        expect(host.textContent).toContain(xx("I've written them down: leave"));
        expect(bypassing(host, WRITTEN, alerts.said)).toEqual([]);
    });

    it('no 12 words on the phone, no account, and the ways out that failed', async () => {
        who.words = false;
        out.plan = { hereName: 'Mullum Commons', next: null };
        await renderIn('xx', createElement(ForceUpdateBlock));
        expect(host.textContent).toContain(xx('Add my 12 words to this phone'));
        await click(buttonReading(xx('Leave this community')), 'Leave this community');
        expect(host.textContent).toContain(xx('This phone was restored with a sign-in, so it has no 12 words. Without a connected sign-in, you cannot get this account back.'));
        expect(host.textContent).toContain(xx('Take my account off this phone'));
        expect(bypassing(host, WRITTEN, alerts.said)).toEqual([]);
        await click(buttonReading(xx('Cancel')), 'Cancel');
        out.switchError = new Error('');
        await click(byLabel(xx('Use {name}').replace('{name}', 'Lismore Commons')), 'Use Lismore Commons');
        expect(host.textContent).toContain(xx("Couldn't switch to {name}. {reason}").replace('{name}', 'Lismore Commons').replace('{reason}', xx('Please try again.')));
        expect(bypassing(host, WRITTEN, alerts.said)).toEqual([]);

        act(() => root.unmount());
        root = createRoot(host);
        who.identity = null;
        await renderIn('xx', createElement(ForceUpdateBlock));
        await click(buttonReading(xx('Leave this community')), 'Leave this community');
        expect(host.textContent).toContain(xx("You haven't joined {here} from this phone. Leaving forgets it here, so you can use another invite.").replace('{here}', 'Mullum Commons'));
        expect(bypassing(host, WRITTEN, alerts.said)).toEqual([]);
    });

    it('a words read that failed says why in the member\'s language', async () => {
        out.wordsError = new Error('');
        await renderIn('xx', createElement(ForceUpdateBlock));
        await click(buttonReading(xx('See my 12 words')), 'See my 12 words');
        expect(host.textContent).toContain(xx("Couldn't read your 12 words. {reason}").replace('{reason}', xx('Please try again.')));
        expect(bypassing(host, WRITTEN, alerts.said)).toEqual([]);
    });

    it('in English, word for word as before', async () => {
        await renderIn('en', createElement(ForceUpdateBlock));
        expect(bracketed(host)).toBe(0);
        for (const english of ['Update required', `Your community needs a newer BeanPool than the one on this phone (${appConfig.expo.version}). Version 1.3.0 is waiting in the App Store.`,
            'Updating keeps your account and everything on this phone.', 'Update', "Can't update? Ask the people who run your community.", 'Use another community',
            'This update is for this community only. Your other communities on this phone are still yours.', 'Your account',
            "Your account is yours, not the community's. You can still see your 12 words, or leave this community.", 'See my 12 words', 'Leave this community']) {
            expect(host.textContent, english).toContain(english);
        }
        expect(byLabel('Update BeanPool in the App Store')).not.toBeNull();
    });

    it('at 320 dp with 1.3× text: no word wider than the card (320 - 2 × 16 - 2 × 20), nothing stuck in a row', async () => {
        await renderIn('xx', createElement(ForceUpdateBlock));
        expect(unfit(host, 320 - 32 - 40, WRITTEN)).toEqual([]);
        await click(buttonReading(xx('Leave this community')), 'Leave');
        expect(unfit(host, 320 - 32 - 40, WRITTEN)).toEqual([]);
    });

    it('a language picked while it is up redraws it (it is outside the navigator a pick redraws)', async () => {
        const fr = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../words/fr.json'), 'utf8')) as Record<string, unknown>;
        await act(async () => {
            root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'] },
                createElement(ForceUpdateBlock), createElement(LanguagePickerSheet, { visible: true, onClose() {} })) as any);
        });
        await settle();
        await click(buttonReading('Leave this community'), 'Leave this community');
        expect(buttonReading('Cancel')).not.toBeNull();
        expect(typeof fr.Cancel).toBe('string');
        await click(host.querySelector('[data-testid="language-fr"]'), 'Français');
        await settle();
        // The block's own Cancel (not the picker's), now in French, with nothing redrawn by hand.
        const block = host.querySelector('[data-overlay]')!;
        expect(Array.from(block.querySelectorAll('button')).some((b) => b.textContent === fr.Cancel)).toBe(true);
        expect(Array.from(block.querySelectorAll('button')).some((b) => b.textContent === 'Cancel')).toBe(false);
    });
});

describe('the tour bar in the pseudo-locale', () => {
    const steps = tourSteps('phone', { global: false, beans: true });
    const home = { chips: ['offers', 'events'], onHome: (type: string) => type === 'events', chipName: (type: string) => (type === 'offers' ? 'Offers near you' : 'Coming up'), addChip: () => {}, moreCards: () => {} };
    const bar = (index: number) => createElement(TourBar, { steps, index, home, colors: lightColors, bottomInset: 0, onNext() {}, onSkip() {}, onDone() {} } as any);

    it('a step: its caption in capitals the language\'s way, its words, Skip and Next', async () => {
        await renderIn('xx', bar(0));
        const caption = host.querySelector('[data-testid="tour-step-caption"]')!.textContent!;
        expect(caption).toMatch(/^\[.*\]$/s);
        expect(caption).toBe(caption.toUpperCase());
        expect(host.querySelector('[data-testid="tour-words"]')!.textContent).toBe(xx(steps[0].words));
        expect(byLabel(xx('Next: step {n} of {total}').replace('{n}', '2').replace('{total}', String(steps.length)))).not.toBeNull();
        expect(byLabel(xx('Skip the tour'))).not.toBeNull();
        expect(bypassing(host)).toEqual([]);
    });

    it('the last step: the chips (a card\'s name is Home\'s), More cards, Done', async () => {
        await renderIn('xx', bar(steps.length - 1));
        expect(byLabel(xx('Put {name} on Home').replace('{name}', 'Offers near you'))).not.toBeNull();
        expect(host.textContent).toContain(xx('{name} · On Home ✓').replace('{name}', 'Coming up'));
        expect(host.textContent).toContain(xx('More cards ›'));
        expect(byLabel(xx('Done: end the tour'))).not.toBeNull();
        expect(bypassing(host, ['Offers near you', 'Coming up'])).toEqual([]);
    });

    it('in English the caption reads "STEP 1 OF n" and the words are the tour\'s', async () => {
        await renderIn('en', bar(0));
        expect(host.querySelector('[data-testid="tour-step-caption"]')!.textContent).toBe(`STEP 1 OF ${steps.length}`);
        expect(host.querySelector('[data-testid="tour-words"]')!.textContent).toBe(steps[0].words);
        expect(host.textContent).toContain('Next ›');
    });
});

describe('the header in the pseudo-locale (words only)', () => {
    it('no community: the bean\'s label, Connect, help, settings, profile', async () => {
        await renderIn('xx', createElement(GlobalHeader));
        expect(byLabel(xx('BeanPool: your community and help, not connected'))).not.toBeNull();
        expect(byLabel(xx('Connect to a community'))).not.toBeNull();
        expect(host.textContent).toContain(xx('Connect'));
        expect(byLabel(xx('Help for this screen'))).not.toBeNull();
        expect(byLabel(xx('Settings'))).not.toBeNull();
        expect(byLabel(xx('Open profile'))).not.toBeNull();
        expect(bypassing(host)).toEqual([]);
    });

    it('a member with an update waiting: the invite icon and the banner\'s words', async () => {
        store.map.set('beanpool_anchor_url', 'https://mullum.example');
        store.map.set('beanpool_latest_known_version', '99.0.0');
        await renderIn('xx', createElement(GlobalHeader));
        await settle(12);
        expect(byLabel(xx('Invite friends'))).not.toBeNull();
        const banner = host.textContent ?? '';
        if (banner.includes(xx('Upgrade'))) {
            expect(banner).toContain(xx('Update available — v{version} has the latest community features.').replace('{version}', '99.0.0'));
        }
        expect(bypassing(host)).toEqual([]);
    });
});

describe('the guide\'s pages in the pseudo-locale: the screen\'s own words (the guide\'s are its own, slice S5)', () => {
    const guide = getBundledGuide();
    /** Everything the guide itself says on a page: its own words, translated by its own build. */
    const guideWords = (slug: string): string[] => {
        const page = findGuidePage(guide, slug)!;
        const section = findGuideSection(guide, page.section);
        const out: string[] = [page.title, page.summary, section?.title ?? ''];
        // Each bold or plain piece is drawn as a Text of its own (splitBold).
        const pieces = (text: string) => splitBold(text).flatMap((p) => [p.text, p.text.trim()]);
        for (const b of page.blocks as any[]) {
            if (b.type === 'ul') out.push(...b.items.flatMap((i: string) => pieces(i)));
            else out.push(...pieces(String(b.text)));
        }
        for (const r of relatedPages(guide, page)) out.push(r.title, r.summary);
        return out.filter(Boolean);
    };

    it('a page: Back, the header, part of, a video to watch, related', async () => {
        const slug = guide.guides.find((p) => relatedPages(guide, p).length > 0 && findGuideSection(guide, p.section))!.slug;
        nav.params = { slug };
        learn.video = { url: 'https://videos.example/1', title: 'How it works' };
        await renderIn('xx', createElement(GuideScreen));
        expect(byLabel(xx('Back'))).not.toBeNull();
        expect(host.textContent).toContain(xx('BEANPOOL GUIDE'));
        expect(byLabel(xx('Part of: {section}').replace('{section}', findGuideSection(guide, findGuidePage(guide, slug)!.section)!.title))).not.toBeNull();
        expect(host.textContent).toContain(xx('Watch: {title}').replace('{title}', 'How it works'));
        expect(host.textContent).toContain(xx('RELATED'));
        expect(bypassing(host, [...guideWords(slug), 'How it works'])).toEqual([]);
    });

    it('a page or a part that isn\'t there', async () => {
        nav.params = { slug: 'no-such-page' };
        await renderIn('xx', createElement(GuideScreen));
        expect(host.textContent).toContain(xx('This guide is not available. Go back and pick another one.'));
        expect(bypassing(host)).toEqual([]);
        act(() => root.unmount());
        root = createRoot(host);
        nav.params = { id: 'no-such-part' };
        await renderIn('xx', createElement(GuideSectionScreen));
        expect(host.textContent).toContain(xx('This part of the guide is not available. Go back and pick another one.'));
        expect(bypassing(host)).toEqual([]);
    });

    it('a part of the guide: its chrome bracketed, its pages the guide\'s own', async () => {
        const section = guide.sections[0];
        nav.params = { id: section.id };
        await renderIn('xx', createElement(GuideSectionScreen));
        expect(host.textContent).toContain(xx('BEANPOOL GUIDE'));
        const own = [section.title, section.summary, ...sectionPages(guide, section).flatMap((p) => [p.title, p.summary])].filter(Boolean);
        expect(bypassing(host, own)).toEqual([]);
    });
});

describe("the re-key prompt (app/_layout.tsx) is key-succession.ts's, in the member's language", () => {
    it('in English the same sentence from the same date, and the same buttons; bracketed in the pseudo-locale', () => {
        for (const at of ['2026-10-03T09:00:00.000Z', 'not a date']) {
            const words = rekeyPromptWords(at);
            expect(words.text, at).toBe(keySuccessionPromptText(at));
            expect(words.yes).toBe(KEY_SUCCESSION_PROMPT_YES);
            expect(words.no).toBe(KEY_SUCCESSION_PROMPT_NO);
        }
        setLanguage('xx');
        const words = rekeyPromptWords('2026-10-03T09:00:00.000Z');
        for (const s of [words.text, words.yes, words.no]) expect(s).toMatch(/^\[.*\]$/s);
    });
});
