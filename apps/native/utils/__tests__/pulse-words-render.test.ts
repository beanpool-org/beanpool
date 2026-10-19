// @vitest-environment jsdom
/**
 * Channels and the Pulse in the member's language (words slice S3, sweep B5): app/channels.tsx, app/(tabs)/pulse.tsx
 * and app/pulse-intake.tsx rendered for real inside the real LanguageProvider, with what only they draw drawn for real
 * too: the clipboard and new-posts nudges, the feed card with its report box and its YouTube player, and the preview
 * card. React Native's host components are plain tags carrying their accessibility props, placeholders and the few
 * layout props the 320 dp checks read; the node, the platforms' sign-in (utils/pulse-oauth) and the feed's reads are
 * stand-ins answering a small community.
 *
 * In the pseudo-locale (`xx`: every sentence accented, padded ~35 % and bracketed) any text, screen-reader label, hint,
 * placeholder or alert with letters outside a bracket bypassed t(). What members and platforms wrote is shown as
 * written: names, handles, links, post titles, and a platform's brand name (YouTube, TikTok …). The 320 dp × 1.3 checks
 * model widths as talk-words-render.test.ts does (a generous 0.62 em a letter).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement, Fragment, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ said: [] as string[], buttons: [] as Array<{ text?: string; onPress?: () => void }> }));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', radio: 'radio', alert: 'alert', switch: 'switch' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityHint, accessibilityRole, testID, placeholder, numberOfLines, adjustsFontSizeToFit, minimumFontScale, horizontal, onLayout, value, onChangeText, disabled } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityHint) attrs['data-hint'] = accessibilityHint;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (adjustsFontSizeToFit) attrs['data-shrinks'] = 'true';
        if (minimumFontScale !== undefined) attrs['data-min-scale'] = String(minimumFontScale);
        if (horizontal) attrs['data-horizontal'] = 'true';
        const s = flat(props.style);
        if (s.flexWrap) attrs['data-wrap'] = s.flexWrap;
        if (s.flexShrink || s.flex) attrs['data-flex-shrink'] = String(s.flexShrink ?? s.flex);
        if (typeof s.fontSize === 'number') attrs['data-font'] = String(s.fontSize);
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    const FlatList = ({ data, renderItem, keyExtractor, ListHeaderComponent, ListFooterComponent, ListEmptyComponent }: Record<string, any>) => createElement('div', null,
        ListHeaderComponent,
        (data ?? []).length
            ? data.map((item: any, index: number) => createElement(Fragment, { key: keyExtractor ? keyExtractor(item, index) : index }, renderItem({ item, index })))
            : (typeof ListEmptyComponent === 'function' ? createElement(ListEmptyComponent) : ListEmptyComponent),
        typeof ListFooterComponent === 'function' ? createElement(ListFooterComponent) : ListFooterComponent);
    class Value { constructor(public v = 0) {} setValue() {} setOffset() {} stopAnimation() {} interpolate() { return this; } addListener() { return ''; } removeListener() {} removeAllListeners() {} }
    const animation = () => ({ start(cb?: () => void) { cb?.(); }, stop() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        FlatList,
        Animated: {
            FlatList, View: el('div'), ScrollView: el('div'), Value, event: () => () => {}, timing: animation, spring: animation, decay: animation,
            loop: () => ({ start() {}, stop() {} }), sequence: () => ({ start() {}, stop() {} }),
            diffClamp: () => new Value(), add: () => new Value(), multiply: () => new Value(), subtract: () => new Value(), modulo: () => new Value(),
        },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'), Switch: el('div'),
        TouchableOpacity: el('button'), SafeAreaView: el('div'), RefreshControl: () => null, ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        Alert: {
            alert: (title: string, body?: string, buttons?: Array<{ text?: string; onPress?: () => void }>) => {
                alerts.said.push(title);
                if (body) alerts.said.push(body);
                for (const b of buttons ?? []) { if (b.text) alerts.said.push(b.text); alerts.buttons.push(b); }
            },
        },
        Linking: { openURL: async () => {}, openSettings: async () => {} },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        AccessibilityInfo: { announceForAccessibility: () => {}, isScreenReaderEnabled: async () => false, isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) },
        Easing: { out: (f: unknown) => f, cubic: () => 0, ease: () => 0, inOut: (f: unknown) => f },
        Keyboard: { addListener: listener, dismiss() {} },
        LayoutAnimation: { configureNext() {}, create: () => ({}), Presets: { easeInEaseOut: {} } },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const params = vi.hoisted(() => ({ now: {} as Record<string, string> }));
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: { push() {}, navigate() {}, replace() {}, back() {}, setParams() {}, canGoBack: () => true },
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]),
        useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
        useLocalSearchParams: () => params.now,
        ErrorBoundary: () => null,
    };
});
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
vi.mock('expo-haptics', () => ({
    impactAsync: async () => {}, notificationAsync: async () => {}, selectionAsync: async () => {},
    ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' }, NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));
const clip = vi.hoisted(() => ({ text: '' }));
vi.mock('expo-clipboard', () => ({ hasStringAsync: async () => clip.text.length > 0, getStringAsync: async () => clip.text, setStringAsync: async () => true }));
/** The YouTube player's WebView: its props, so a test can say what the player sent. */
const webview = vi.hoisted(() => ({ props: null as null | Record<string, any> }));
vi.mock('react-native-webview', () => ({ WebView: (props: Record<string, any>) => { webview.props = props; return createElement('div', { 'data-webview': 'true' }); } }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('react-native-keyboard-controller', () => {
    const pass = ({ children }: { children?: unknown }) => createElement('div', null, children as any);
    return { KeyboardAvoidingView: pass, KeyboardAwareScrollView: pass, KeyboardController: { dismiss: async () => {} }, useKeyboardState: () => false };
});
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown; patternEnabled: boolean }) => unknown) => make({ theme: 'light', colors: lightColors, patternEnabled: false }),
    };
});
const ME = { publicKey: 'me-key', privateKey: 'me-priv', callsign: 'Ana' };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: ME }) }));
// A member's picture: drawn from what they chose, never words.
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));

/** The node: what each signed read and write answers, by path. */
const node = vi.hoisted(() => ({ answers: new Map<string, { status: number; body: unknown }>(), sent: [] as Array<{ path: string; body: unknown }> }));
vi.mock('../node-post', () => ({
    anchorUrl: async () => 'https://mullum.example',
    getCachedAnchorUrl: () => 'https://mullum.example',
    signedPost: async (_url: string, p: string, body: unknown) => {
        node.sent.push({ path: p, body });
        const a = node.answers.get(p) ?? { status: 200, body: {} };
        return { ok: a.status < 400, status: a.status, json: async () => a.body, text: async () => JSON.stringify(a.body) };
    },
}));
/** The platforms' sign-in, as utils/pulse-oauth.ts gives it: its refusals are English, as it writes them. */
const oauth = vi.hoisted(() => ({ refusal: null as null | string }));
vi.mock('../pulse-oauth', () => {
    class PulseOAuthError extends Error {
        constructor(readonly reason: string, message: string) { super(message); this.name = 'PulseOAuthError'; }
    }
    const refuse = async () => { throw new PulseOAuthError('account-mismatch', oauth.refusal ?? 'Connection was cancelled.'); };
    return {
        PulseOAuthError,
        fetchPulseOAuthConfig: async () => ({ tiktok: { enabled: true, clientKey: 'tk' }, instagram: { enabled: true, appId: 'ig' } }),
        getStoredOAuthToken: async (id: string) => (id === 'ch-ig' ? { channelId: id, platform: 'instagram', accessToken: 'x' } : null),
        restoreVerifiedBadge: async () => null,
        connectTikTokChannel: refuse,
        connectInstagramChannel: refuse,
        syncChannelVideos: async () => ({ synced: 0, deduplicated: 0 }),
        disconnectOAuthChannel: async () => ({}),
    };
});
/** The feed's reads and the card's report, as utils/pulse.ts gives them: its own English when they fail. */
const feed = vi.hoisted(() => ({ items: [] as any[], byCategory: new Map<string, any[]>(), fail: null as null | string, reportFails: null as null | string }));
vi.mock('../pulse', async (importOriginal) => {
    const real = await importOriginal<Record<string, any>>();
    return {
        ...real,
        fetchPulseFeed: async ({ category }: { category?: string } = {}) => {
            if (feed.fail) throw new Error(feed.fail);
            return { items: category ? feed.byCategory.get(category) ?? [] : feed.items, nextCursor: null };
        },
        mutePulseItem: async () => {},
        reportPulseItem: async () => { if (feed.reportFails) throw new Error(feed.reportFails); },
    };
});

import { pseudoLocalise, setLanguage, type UiLang } from '@beanpool/core';
import { DrawnInLanguage, LanguageProvider } from '../../components/LanguageProvider';
import { LanguageRow } from '../../components/LanguagePicker';
import { resetPulseVideoPlayer } from '../pulse-video-player';
import { youtubePlayerErrorMessage } from '../youtube-embed';
import ChannelsScreen from '../../app/channels';
import PulseScreen from '../../app/(tabs)/pulse';
import PulseIntakeScreen from '../../app/pulse-intake';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

const CHANNELS = [
    { id: 'ch-yt', platform: 'youtube', url: 'https://youtube.com/@kofi.makes', handle: '@kofi.makes', category: 'food', isPrimaryVideo: true, supportsAutolist: true, oauthVerifiedAt: null, syndicateToNode: true },
    { id: 'ch-tt', platform: 'tiktok', url: 'https://tiktok.com/@kofi', handle: '@kofi', category: 'craft', isPrimaryVideo: false, supportsAutolist: false, oauthVerifiedAt: '2026-10-01T00:00:00.000Z', syndicateToNode: true },
    { id: 'ch-ig', platform: 'instagram', url: null, handle: '@kofi.pots', category: 'art', isPrimaryVideo: false, supportsAutolist: false, oauthVerifiedAt: null, syndicateToNode: false },
    { id: 'ch-web', platform: 'website', url: 'https://kofi.example', handle: null, category: 'other', isPrimaryVideo: false, supportsAutolist: false, oauthVerifiedAt: null, syndicateToNode: true },
    { id: 'ch-rss', platform: 'rss', url: 'https://kofi.example/feed', handle: null, category: 'learn', isPrimaryVideo: false, supportsAutolist: true, oauthVerifiedAt: null, syndicateToNode: true },
];
const NUDGES = [{ channelId: 'ch-yt', platform: 'youtube', handle: '@kofi.makes', newPostsCount: 3, currentCount: 12 }];
const CLIPPED = 'https://www.tiktok.com/@kofi/video/7';
const FEED = [
    { id: 'p1', ownerPubkey: ME.publicKey, callsign: 'Ana', avatarUrl: null, platform: 'youtube', category: 'food', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Planting garlic by the moon', thumbnailUrl: null, publishedAt: iso(now - 5 * 60_000), source: 'member', isVerified: true },
    { id: 'p2', ownerPubkey: 'kofi-key', callsign: 'Kofi', avatarUrl: null, platform: 'instagram', category: 'art', url: 'https://www.instagram.com/p/abc/', title: null, thumbnailUrl: null, publishedAt: iso(now - 9 * DAY), source: 'member', isVerified: false },
    { id: 'p3', ownerPubkey: 'echo-key', callsign: 'Valley Echo', avatarUrl: null, platform: 'rss', category: 'community', url: 'https://echo.example/story', title: 'Hall roof fixed', thumbnailUrl: null, publishedAt: iso(now - 3 * 3600_000), source: 'official', isVerified: false },
    { id: 'p4', ownerPubkey: 'daily-key', callsign: 'Daily Pulse', avatarUrl: null, platform: 'website', category: 'learn', url: null, title: 'On giving', thumbnailUrl: null, publishedAt: iso(now - 2 * DAY), source: 'member', isVerified: false },
];
const PREVIEW = { url: 'https://www.instagram.com/p/kiln/', title: 'Kiln firing at dawn', thumbnailUrl: null, platform: 'instagram', category: 'craft', isDuplicate: true, channelId: 'ch-ig' };

/** A platform's brand: written as it is in every language. */
const BRANDS = ['YouTube', 'Instagram', 'TikTok', 'SoundCloud', 'Facebook'];
/** Everything members, platforms and the community wrote: shown as written, in every language. And one icon that
 *  Unicode counts as a letter (ℹ, the information sign). */
const OTHERS = [
    ...BRANDS, ...CHANNELS.flatMap((c) => [c.handle, c.url]), CLIPPED, ...FEED.flatMap((i) => [i.callsign, i.title, i.url]),
    PREVIEW.url, PREVIEW.title, ME.callsign, 'https://mullum.example', 'ℹ️',
].filter((s): s is string => typeof s === 'string' && /\p{L}/u.test(s)).sort((a, b) => b.length - a.length);

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    alerts.said.length = 0;
    alerts.buttons.length = 0;
    params.now = {};
    store.map.clear();
    clip.text = '';
    oauth.refusal = null;
    node.sent.length = 0;
    node.answers = new Map([
        ['/api/channels/mine', { status: 200, body: { channels: CHANNELS } }],
        ['/api/member/pulse/nudges', { status: 200, body: { nudges: [] } }],
        ['/api/member/pulse/preview', { status: 200, body: { preview: PREVIEW } }],
    ]);
    feed.items = FEED;
    feed.byCategory = new Map();
    feed.fail = null;
    feed.reportFails = null;
    webview.props = null;
    resetPulseVideoPlayer();
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderIn(lang: UiLang, screen: unknown) {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, screen as any) as any); });
    await settle();
}
const again = async (lang: UiLang, screen: unknown) => {
    act(() => root.unmount());
    root = createRoot(host);
    alerts.said.length = 0;
    await renderIn(lang, screen);
};
const click = async (el: Element | null | undefined, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(4);
};
const byLabel = (label: string) => host.querySelector(`[aria-label="${CSS.escape(label)}"]`);
const buttonWithText = (text: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === text) ?? null;
const xx = pseudoLocalise;

/** Text with letters outside a pseudo-locale bracket, once what others wrote is taken out. */
function outsideBrackets(text: string | null | undefined): boolean {
    if (!text) return false;
    let rest = text;
    // Innermost first: a translated sentence can hold another as a value.
    for (let was = ''; was !== rest;) { was = rest; rest = rest.replace(/\[[^[\]]*\]/g, ''); }
    for (const o of OTHERS) rest = rest.split(o).join('');
    return /\p{L}/u.test(rest);
}
/** Every drawn text, label, hint, placeholder and alert that bypassed t(). */
function bypassing(): string[] {
    const out = new Set<string>();
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const whole = n.parentElement?.textContent ?? n.nodeValue;
        if (outsideBrackets(whole)) out.add(`text: ${JSON.stringify(whole)}`);
    }
    for (const [attr, kind] of [['aria-label', 'label'], ['data-hint', 'hint'], ['placeholder', 'placeholder']] as const) {
        for (const e of Array.from(host.querySelectorAll(`[${attr}]`))) {
            const v = e.getAttribute(attr);
            if (outsideBrackets(v)) out.add(`${kind}: ${JSON.stringify(v)}`);
        }
    }
    for (const said of alerts.said) if (outsideBrackets(said)) out.add(`alert: ${JSON.stringify(said)}`);
    return [...out];
}
/** How many drawn texts came through t() (bracketed), so a check on an empty screen can't pass by itself. */
const bracketed = () => Array.from(host.querySelectorAll('span')).filter((s) => /^\[.*\]$/su.test(s.textContent ?? '')).length;
/** The nudges wait 1.2 s after the screen draws, so they never hold up the app's start. */
const nudgesAppear = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 1300)); }); await settle(); };

describe('Channels & Showcase in the pseudo-locale: every word on it came through t() (words S3f)', () => {
    it('the cards: how each keeps current, the local-feed switch, the category, connect / sync / share / make main / remove; the cross-post line', async () => {
        await renderIn('xx', createElement(ChannelsScreen));
        expect(host.textContent).toContain('@kofi.makes');
        expect(host.textContent).toContain(xx('You post video in more than one place. The feed uses your {platform} as the main one.').replace('{platform}', 'YouTube'));
        expect(host.textContent).toContain(xx('{listing} · main video channel').replace('{listing}', xx('Updates itself')));
        expect(host.textContent).toContain(xx('a tap per post'));
        expect(host.textContent).toContain(xx('shows as a card'));
        expect(host.textContent).toContain(xx('Reconnect to restore your verified badge'));
        expect(host.textContent).toContain(xx('Reconnect {platform}').replace('{platform}', 'Instagram'));
        expect(host.textContent).toContain(xx('Website'));
        expect(host.textContent).toContain(xx('Blog / RSS'));
        expect(byLabel(xx('Show {platform} on the local feed').replace('{platform}', 'TikTok'))).not.toBeNull();
        expect(bracketed()).toBeGreaterThan(20);
        expect(bypassing()).toEqual([]);
    });

    it('the category picker, the add form (its tiles, the example handle, the categories) and the bottom buttons', async () => {
        await renderIn('xx', createElement(ChannelsScreen));
        await click(byLabel(xx('Change the category for {platform}').replace('{platform}', 'YouTube')), 'Change');
        expect(byLabel(xx('Stop changing the category for {platform}').replace('{platform}', 'YouTube'))).not.toBeNull();
        expect(host.textContent).toContain(xx('{emoji} {label}').replace('{emoji}', '🔧').replace('{label}', xx('Repair & reuse')));
        expect(bypassing(), 'the picker').toEqual([]);
        await click(byLabel(xx('Add a channel')), 'Add a channel');
        expect(host.textContent).toContain(xx('Where do you post?'));
        expect(host.querySelector('input')!.getAttribute('placeholder')).toBe(xx('youtube.com/@you'));
        expect(byLabel(xx('{platform}, {listing}').replace('{platform}', 'Facebook').replace('{listing}', xx('a tap per post')))).not.toBeNull();
        expect(bypassing(), 'the add form').toEqual([]);
    });

    it('the alerts: remove, disconnect; a refused connect from utils/pulse-oauth.ts, in the member\'s language with the platform and handle as written', async () => {
        oauth.refusal = 'The Instagram account you signed in to is not @kofi.pots. Sign in to that account and connect again.';
        await renderIn('xx', createElement(ChannelsScreen));
        await click(byLabel(xx('Remove {platform}').replace('{platform}', xx('Website'))), 'Remove');
        expect(alerts.said).toContain(xx('{channel} will no longer appear on your profile.').replace('{channel}', xx('Website')));
        await click(byLabel(xx('Disconnect {platform} account').replace('{platform}', 'TikTok')), 'Disconnect');
        expect(alerts.said).toContain(xx('Disconnect {platform}?').replace('{platform}', 'TikTok'));
        await click(buttonWithText(xx('Reconnect {platform}').replace('{platform}', 'Instagram')), 'Reconnect Instagram');
        expect(host.textContent).toContain(xx('The {platform} account you signed in to is not {handle}. Sign in to that account and connect again.')
            .replace('{platform}', 'Instagram').replace('{handle}', '@kofi.pots'));
        expect(bypassing()).toEqual([]);
    });

    it('the clipboard and new-posts nudges', async () => {
        clip.text = CLIPPED;
        node.answers.set('/api/member/pulse/nudges', { status: 200, body: { nudges: NUDGES } });
        await renderIn('xx', createElement(ChannelsScreen));
        await nudgesAppear();
        expect(host.textContent).toContain(xx('Link from Clipboard'));
        expect(host.textContent).toContain(xx('Found a link to your {platform} channel. Would you like to share it to The Pulse?').replace('{platform}', 'TikTok'));
        expect(host.textContent).toContain(xx("You've posted {n} new things on {platform} since your last visit.").replace('{n}', '3').replace('{platform}', 'YouTube'));
        expect(bypassing()).toEqual([]);
    });

    it('no channels yet, and a list the node would not give', async () => {
        node.answers.set('/api/channels/mine', { status: 200, body: { channels: [] } });
        await renderIn('xx', createElement(ChannelsScreen));
        expect(host.textContent).toContain(xx('Already posting your work somewhere?'));
        expect(bypassing(), 'empty').toEqual([]);
        node.answers.set('/api/channels/mine', { status: 500, body: {} });
        await again('xx', createElement(ChannelsScreen));
        expect(host.textContent).toContain(xx('Could not load your channels.'));
        expect(bypassing(), 'error').toEqual([]);
    });
});

describe('the Pulse tab in the pseudo-locale (words S3f)', () => {
    it('the switch, the subtitle, the chips; each card\'s source, age, category and links; a post\'s title and its author as written', async () => {
        await renderIn('xx', createElement(PulseScreen));
        expect(host.textContent).toContain('Planting garlic by the moon');
        expect(host.textContent).toContain(xx('What your neighbours are creating and sharing'));
        expect(host.textContent).toContain(xx('{n}m ago').replace('{n}', '5'));
        expect(host.textContent).toContain(xx('View post on {platform}').replace('{platform}', 'Instagram'));
        expect(host.textContent).toContain(xx('🌱 Daily Reflection'));
        expect(byLabel(xx('Neighbours feed, {n} items').replace('{n}', '3'))).not.toBeNull();
        expect(byLabel(xx('Category: {category}').replace('{category}', xx('Food & growing')))).not.toBeNull();
        expect(bracketed()).toBeGreaterThan(15);
        expect(bypassing()).toEqual([]);
    });

    it('the Local lane, the report box and a refused report, hiding your own post', async () => {
        await renderIn('xx', createElement(PulseScreen));
        await click(byLabel(xx('Local feed, {n} item').replace('{n}', '1')), 'Local');
        expect(host.textContent).toContain(xx('\u{1F4F0} Local source'));
        expect(host.textContent).toContain(xx('News and notices from around the shire'));
        expect(bypassing(), 'local').toEqual([]);
        await click(byLabel(xx('Neighbours feed')) ?? byLabel(xx('Neighbours feed, {n} items').replace('{n}', '3')), 'Neighbours');
        feed.reportFails = 'Failed to report item (429)';
        await click(byLabel(xx('Report this post')), 'Report this post');
        expect(host.textContent).toContain(xx('Report this post — why?'));
        expect(host.textContent).toContain(xx('Spam or scam'));
        await click(buttonWithText(xx('Spam or scam')), 'Spam or scam');
        expect(host.textContent).toContain(xx('✓ {reason}').replace('{reason}', xx('Spam or scam')));
        await click(buttonWithText(xx('Submit report')), 'Submit report');
        expect(alerts.said).toContain(xx('Failed to report item ({status})').replace('{status}', '429'));
        await click(byLabel(xx('Hide this item from feed')), 'Hide');
        expect(alerts.said).toContain(xx('"{title}" will no longer be visible to your neighbours on the community feed.').replace('{title}', 'Planting garlic by the moon'));
        expect(bypassing()).toEqual([]);
    });

    it('a YouTube card playing here: starting, and the player\'s error with the way out to YouTube', async () => {
        await renderIn('xx', createElement(PulseScreen));
        await click(host.querySelector(`[aria-label^="${CSS.escape(xx('Play {post}').slice(0, 4))}"]`), 'Play');
        expect(host.textContent).toContain(xx('Starting video…'));
        expect(webview.props).not.toBeNull();
        await act(async () => { webview.props!.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'error', code: 100 }) } }); });
        await settle();
        expect(host.textContent).toContain(xx('This video is private, or it has been taken down.'));
        expect(host.textContent).toContain(xx('Open on {platform} ↗').replace('{platform}', 'YouTube'));
        expect(bypassing()).toEqual([]);
        // Every line the player can say, translated.
        setLanguage('xx');
        for (const code of [-1, 2, 5, 100, 101, 150, 153, 999]) expect(youtubePlayerErrorMessage(code)).toMatch(/^\[.*\]$/su);
    });

    it('the empty lanes and categories, and a feed that would not load', async () => {
        await renderIn('xx', createElement(PulseScreen));
        await click(byLabel(xx('Learn feed')), 'Learn');
        expect(host.textContent).toContain(xx('No learning guides yet'));
        expect(bypassing(), 'learn').toEqual([]);

        await again('xx', createElement(PulseScreen));
        await click(byLabel(xx('Art & music')), 'Art & music');
        expect(host.textContent).toContain(xx('No posts in this category yet'));
        expect(bypassing(), 'a category').toEqual([]);

        feed.items = [];
        await again('xx', createElement(PulseScreen));
        expect(host.textContent).toContain(xx('The Pulse is quiet right now'));
        expect(bypassing(), 'quiet').toEqual([]);

        feed.fail = 'Failed to load feed page (503)';
        await again('xx', createElement(PulseScreen));
        expect(host.textContent).toContain(xx('Failed to load feed page ({status})').replace('{status}', '503'));
        expect(host.textContent).toContain(xx('Retry'));
        expect(bypassing(), 'error').toEqual([]);
    });
});

describe('Add to Pulse in the pseudo-locale (words S3f)', () => {
    it('with no channels yet', async () => {
        node.answers.set('/api/channels/mine', { status: 200, body: { channels: [] } });
        await renderIn('xx', createElement(PulseIntakeScreen));
        expect(host.textContent).toContain(xx('No Channels Connected'));
        expect(host.querySelector('input')!.getAttribute('placeholder')).toBe(xx('https://instagram.com/p/... or tiktok.com/...'));
        expect(bypassing()).toEqual([]);
    });

    it('a shared link: the pickers, the preview card of a post already on Pulse, and the check before sending', async () => {
        params.now = { url: encodeURIComponent(PREVIEW.url) };
        await renderIn('xx', createElement(PulseIntakeScreen));
        expect(host.textContent).toContain(PREVIEW.title);
        expect(host.textContent).toContain(xx('Already published to Pulse. Submitting will update the title or category.'));
        expect(host.textContent).toContain(xx('Update on Pulse'));
        expect(byLabel(xx('Preview of {platform} post: {title}').replace('{platform}', 'Instagram').replace('{title}', PREVIEW.title))).not.toBeNull();
        expect(bypassing(), 'the preview').toEqual([]);
        await click(byLabel(xx('Publish to Pulse')), 'Publish to Pulse');
        expect(host.textContent).toContain(xx('Excluded from this publish'));
        await click(byLabel(xx('Share to Pulse')), 'Share to Pulse');
        expect(host.textContent).toContain(xx('Review toggle is currently opted out. Toggle "Publish to Pulse" to submit.'));
        expect(bypassing(), 'opted out').toEqual([]);
    });
});

describe('in English nothing is bracketed, and the words are as they were', () => {
    it('Channels', async () => {
        clip.text = CLIPPED;
        node.answers.set('/api/member/pulse/nudges', { status: 200, body: { nudges: NUDGES } });
        await renderIn('en', createElement(ChannelsScreen));
        await nudgesAppear();
        expect(bracketed()).toBe(0);
        expect(host.textContent).toContain('You post video in more than one place. The feed uses your YouTube as the main one.');
        expect(host.textContent).toContain('Updates itself · main video channel');
        expect(host.textContent).toContain('a tap per post');
        expect(host.textContent).toContain('🌐 Website');
        expect(host.textContent).toContain('Reconnect Instagram');
        expect(host.textContent).toContain("You've posted 3 new things on YouTube since your last visit.");
        expect(host.textContent).toContain('Found a link to your TikTok channel. Would you like to share it to The Pulse?');
        expect(byLabel('Show TikTok on the local feed')).not.toBeNull();
        await click(byLabel('Remove Blog / RSS'), 'Remove');
        expect(alerts.said).toEqual(['Remove this channel?', 'Blog / RSS will no longer appear on your profile.', 'Keep it', 'Remove']);
    });

    it('the Pulse tab', async () => {
        await renderIn('en', createElement(PulseScreen));
        expect(bracketed()).toBe(0);
        expect(host.textContent).toContain('5m ago');
        expect(host.textContent).toContain('View post on Instagram');
        expect(host.textContent).toContain('Open on YouTube ↗');
        expect(byLabel('Neighbours feed, 3 items')).not.toBeNull();
        expect(byLabel('Local feed, 1 item')).not.toBeNull();
        expect(byLabel('Play Planting garlic by the moon by Ana on YouTube, verified creator')).not.toBeNull();
        expect(byLabel('Open Planting garlic by the moon by Ana on YouTube, verified creator on YouTube')).not.toBeNull();
        expect(byLabel('Category: Food & growing')).not.toBeNull();
        expect(host.textContent).toContain('🌱 Food & growing');
    });

    it('Add to Pulse', async () => {
        params.now = { url: encodeURIComponent(PREVIEW.url) };
        await renderIn('en', createElement(PulseIntakeScreen));
        expect(bracketed()).toBe(0);
        expect(host.textContent).toContain('Share a single post or video from your external channels to your local community feed.');
        expect(host.textContent).toContain('Instagram · @kofi.pots');
        expect(host.textContent).toContain('Making & craft');
        expect(host.textContent).toContain('Update on Pulse');
    });
});

// ── 320 dp with text at 1.3×: longer languages never push words past an edge (checked with the pseudo-locale) ─────────
const FLOOR = 320;
const SCALE = 1.3;
const glyphEm = (c: string) => (/\p{M}/u.test(c) || /[\uFE0F\u200B\u200C\u200D]/.test(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 1.25 : 0.62);
const widthOf = (text: string, px: number) => Array.from(text).reduce((w, c) => w + glyphEm(c) * px, 0);

describe('Channels and the Pulse at 320 dp with 1.3× text, in the pseudo-locale', () => {
    it('the Pulse lane switch: each name one line in its third, shrinking to fit; its count on the corner, not beside it', async () => {
        await renderIn('xx', createElement(PulseScreen));
        const labels = Array.from(host.querySelectorAll('[role="radio"] > span[data-shrinks]'));
        expect(labels.length).toBe(3);
        // 16 dp gutters, 3 dp padding and gaps, 4 dp padding in each tab.
        const third = (FLOOR - 32 - 6 - 6) / 3 - 8;
        for (const label of labels) {
            expect(label.getAttribute('data-lines')).toBe('1');
            const min = Number(label.getAttribute('data-min-scale'));
            expect(widthOf(label.textContent!, 13 * SCALE) * min, label.textContent!).toBeLessThanOrEqual(third);
        }
    });

    it('the rows that hold words and buttons wrap or give way: the Channels header, each card\'s buttons, the nudges\' buttons; a label beside a switch shrinks', async () => {
        node.answers.set('/api/member/pulse/nudges', { status: 200, body: { nudges: NUDGES } });
        await renderIn('xx', createElement(ChannelsScreen));
        await nudgesAppear();
        expect(byLabel(xx('Go back'))!.parentElement!.getAttribute('data-wrap')).toBe('wrap');
        const rows = (label: string) => Array.from(host.querySelectorAll(`[aria-label="${CSS.escape(label)}"]`)).map((b) => b.parentElement!);
        for (const row of rows(xx('Remove {platform}').replace('{platform}', 'YouTube'))) expect(row.getAttribute('data-wrap')).toBe('wrap');
        for (const row of rows(xx('Share to Pulse'))) expect(row.getAttribute('data-wrap')).toBe('wrap');
        const switchRow = byLabel(xx('Show {platform} on the local feed').replace('{platform}', 'YouTube'))!.parentElement!;
        expect(switchRow.querySelector('span')!.getAttribute('data-flex-shrink')).toBe('1');
    });

    it('Add to Pulse\'s title shrinks between Back and the spacer rather than pushing past the edge', async () => {
        await renderIn('xx', createElement(PulseIntakeScreen));
        const title = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === xx('Add to Pulse'))!;
        expect(title.getAttribute('data-lines')).toBe('1');
        expect(title.getAttribute('data-shrinks')).toBe('true');
        expect(title.getAttribute('data-flex-shrink')).toBe('1');
    });
});

describe('the Pulse follows a language picked in Settings', () => {
    const NATIVE_WORDS = path.resolve(__dirname, '../../words');
    const fr = JSON.parse(fs.readFileSync(path.join(NATIVE_WORDS, 'fr.json'), 'utf8')) as Record<string, string>;
    const MENU = { menuBtn: {}, menuIconWrap: {}, menuIcon: {}, menuText: {}, menuSub: {}, menuChevron: {} };

    it('a pick redraws the tab in the new language: Back\'s spoken name and a category, with nothing by hand', async () => {
        await act(async () => {
            root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'] },
                createElement(DrawnInLanguage, null, createElement(LanguageRow as any, { styles: MENU }), createElement(PulseScreen))) as any);
        });
        await settle();
        expect(byLabel('Go back')).not.toBeNull();
        expect(byLabel('Community')).not.toBeNull();
        await click(host.querySelector('[data-testid="settings-language"]'), 'Settings → Language');
        await click(host.querySelector('[data-testid="language-fr"]'), 'Français');
        expect(fr['Go back']).toBeTruthy();
        expect(fr['Community']).toBeTruthy();
        expect(byLabel(fr['Go back'])).not.toBeNull();
        expect(byLabel(fr['Community'])).not.toBeNull();
        expect(byLabel('Go back')).toBeNull();
        expect(host.textContent).toContain('Planting garlic by the moon');
    });
});
