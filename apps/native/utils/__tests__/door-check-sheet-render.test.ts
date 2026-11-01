// @vitest-environment jsdom
/**
 * The person check's sheet (components/DoorCheckSheet.tsx), rendered for real with the embedded browser as a stand-in: it
 * opens the check's page, says who runs the check, and every way out ends the check, so the door's screen can say what
 * happened: a token, Close, a page that fails, a page that never brings up its widget. Its colours are the app's, so it
 * reads in light and dark.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = ReactAll;

const web = vi.hoisted(() => ({ props: null as any }));

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const attrs: Record<string, unknown> = {};
        if (props.onPress) attrs.onClick = () => props.onPress();
        if (props.accessibilityLabel) attrs['aria-label'] = props.accessibilityLabel;
        const s = Object.assign({}, ...[props.style].flat(4).filter((x: unknown) => x && typeof x === 'object'));
        if (s.backgroundColor) attrs['data-bg'] = s.backgroundColor;
        if (s.color) attrs['data-color'] = s.color;
        return createElement(tag, attrs, props.children);
    };
    return {
        View: el('div'), Text: el('span'), Pressable: el('button'),
        Modal: (props: Record<string, any>) => createElement('div', { 'data-modal': 'true', 'data-back': props.onRequestClose ? 'yes' : 'no' }, props.children),
        StyleSheet: { create: (s: unknown) => s },
        Platform: { OS: 'android' },
    };
});
vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: (props: Record<string, any>) => createElement('div', { 'data-bg': props.style?.[1]?.backgroundColor }, props.children),
}));
vi.mock('react-native-webview', () => ({
    WebView: (props: Record<string, any>) => { web.props = props; return createElement('iframe', { title: 'page' }); },
}));

const { DoorCheckSheet, CHECK_LOAD_WAIT_MS, useDoorCheck } = await import('../../components/DoorCheckSheet');
const { doorCheckUrl } = await import('../door-check');

const PAGE = 'https://check.beanpool.org/';
const CHECK = { siteKey: '0x4AAA', page: PAGE };
const KEY = 'ab'.repeat(32);
const colorsFor = (dark: boolean) => ({
    surface: { page: dark ? '#000001' : '#fffffe' },
    border: { default: '#888888' },
    text: { heading: dark ? '#eeeeee' : '#111111', secondary: '#555555' },
}) as any;

let root: Root;
let box: HTMLElement;
beforeEach(() => {
    vi.useFakeTimers();
    box = document.createElement('div');
    document.body.appendChild(box);
    root = createRoot(box);
    web.props = null;
});
afterEach(() => {
    act(() => root.unmount());
    box.remove();
    vi.useRealTimers();
});

function open(onDone = vi.fn(), dark = false) {
    act(() => root.render(createElement(DoorCheckSheet, { check: CHECK, publicKey: KEY, dark, colors: colorsFor(dark), onDone }) as any));
    return onDone;
}
const say = (data: string, url = PAGE) => act(() => web.props.onMessage({ nativeEvent: { data, url } }));

describe('the check\'s sheet', () => {
    it('opens the check\'s page for this key, in the theme of the app, and stays on it', () => {
        open(vi.fn(), true);
        expect(web.props.source.uri).toBe(doorCheckUrl(CHECK, KEY, 'dark'));
        expect(web.props.onShouldStartLoadWithRequest({ url: 'https://www.cloudflare.com/privacy', isTopFrame: true })).toBe(false);
        expect(web.props.onShouldStartLoadWithRequest({ url: 'https://challenges.cloudflare.com/x', isTopFrame: false })).toBe(true);
        expect(web.props.source.html).toBeUndefined();
        expect(box.querySelector('[data-bg="#000001"]')).not.toBeNull();
    });

    it('says what it is, and has a way out that the hardware Back also takes', () => {
        const done = open();
        expect(box.textContent).toMatch(/A quick check/);
        expect(box.textContent).toMatch(/Cloudflare/);
        expect(box.querySelector('[data-modal]')?.getAttribute('data-back')).toBe('yes');
        act(() => (box.querySelector('button[aria-label="Close"]') as HTMLElement).click());
        expect(done).toHaveBeenCalledWith({ kind: 'closed' });
    });

    it('the token ends it', () => {
        const done = open();
        say('{"token":"0.tok"}');
        expect(done).toHaveBeenCalledWith({ kind: 'token', token: '0.tok' });
    });

    it('a page that says it failed, or fails to load, ends it', () => {
        const page = open();
        say('{"error":"failed"}');
        expect(page).toHaveBeenCalledWith({ kind: 'failed' });
        const load = open(vi.fn());
        act(() => web.props.onError());
        expect(load).toHaveBeenCalledWith({ kind: 'failed' });
        const http = open(vi.fn());
        act(() => web.props.onHttpError());
        expect(http).toHaveBeenCalledWith({ kind: 'failed' });
    });

    it('a widget that never comes ends it; one that came may take as long as the member does', () => {
        const never = open();
        act(() => { vi.advanceTimersByTime(CHECK_LOAD_WAIT_MS + 1); });
        expect(never).toHaveBeenCalledWith({ kind: 'failed' });
        act(() => root.render(null));
        const came = open(vi.fn());
        say('{"ready":true}');
        act(() => { vi.advanceTimersByTime(CHECK_LOAD_WAIT_MS * 10); });
        expect(came).not.toHaveBeenCalled();
    });

    it('hears nobody but the check\'s page', () => {
        const done = open();
        say('{"token":"stolen"}', 'https://evil.example/');
        expect(done).not.toHaveBeenCalled();
    });
});

describe('useDoorCheck', () => {
    it('opens at the ask, answers it, and goes', async () => {
        let ask: any;
        const Host = () => {
            const check = useDoorCheck(colorsFor(false), false);
            ask = check.ask;
            return check.sheet;
        };
        act(() => root.render(createElement(Host) as any));
        expect(web.props).toBeNull();
        let answered: unknown;
        act(() => { ask(CHECK, KEY).then((r: unknown) => { answered = r; }); });
        expect(web.props.source.uri).toContain(CHECK.siteKey);
        say('{"token":"0.tok"}');
        await act(async () => { await Promise.resolve(); });
        expect(answered).toEqual({ kind: 'token', token: '0.tok' });
        expect(box.querySelector('iframe')).toBeNull();
    });
});
