// @vitest-environment jsdom
/**
 * A direct message's photo bubble (components/chat/DmChatImage.tsx), rendered for real, opened again when what it opens with
 * changes (from #3104's deciding review, 13 Nov: the bubble kept "🔒 Image unavailable" after its first try failed, even when
 * the line was then shown old, or the chat's key arrived, until the chat was reopened).
 *
 * The phone's copy of the photo is faked at its edge (utils/db getDecryptedAttachment, one deferred answer per ask); the bubble
 * and the words are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

Object.assign(globalThis, { __DEV__: false, IS_REACT_ACT_ENVIRONMENT: true });

/** One ask of the photo: its arguments, and the way to answer it (a photo address, null for "can't be opened", or a throw). */
type Ask = { args: [string, string, boolean]; resolve: (uri: string | null) => void; reject: (e: Error) => void };
const h = vi.hoisted(() => ({ asks: [] as unknown[] }));

vi.mock('react-native', async () => {
    const { createElement: el } = await import('react');
    const host = (tag: string) => function Host(props: Record<string, unknown> & { children?: React.ReactNode; onPress?: (e: unknown) => void }) {
        const { children, onPress, accessibilityLabel, accessibilityRole } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress) attrs.onClick = () => onPress({ stopPropagation() {} });
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        return el(tag, attrs, children);
    };
    return {
        View: host('div'), Text: host('span'), Pressable: host('button'), ActivityIndicator: host('i'),
        Image: ({ source, accessibilityLabel }: { source: { uri: string }; accessibilityLabel?: string }) => el('img', { src: source.uri, 'aria-label': accessibilityLabel }),
    };
});
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return { useTheme: () => ({ theme: 'light', colors: lightColors }) };
});
vi.mock('../db', () => ({
    getDecryptedAttachment: vi.fn((...args: [string, string, boolean?]) => new Promise<string | null>((resolve, reject) => {
        h.asks.push({ args: [args[0], args[1], !!args[2]], resolve, reject });
    })),
}));

import { ChatImage, dmKeyContextOf } from '../../components/chat/DmChatImage';

const asks = (): Ask[] => h.asks as Ask[];
let root: Root;
let host: HTMLElement;
beforeEach(() => {
    h.asks.length = 0;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const settle = async () => { await act(async () => { await new Promise((r) => setImmediate(r)); }); };
/** Renders (or re-renders, in the same place: the same bubble, never a new one) the bubble with these props. */
const show = async (props: Partial<Parameters<typeof ChatImage>[0]> = {}) => {
    act(() => root.render(createElement(ChatImage, { conversationId: 'conv-1', messageId: 'm-1', ...props }) as unknown as Parameters<Root['render']>[0]));
    await settle();
};
const answer = async (ask: Ask, uri: string | null) => { ask.resolve(uri); await settle(); };
const photo = () => host.querySelector('img')?.getAttribute('src') ?? null;
const locked = () => host.textContent?.includes('🔒 Image unavailable') ?? false;
const loading = () => !!host.querySelector('i');

describe('a DM photo bubble that first fails opens when what it opens with arrives', () => {
    // Conversion code, log row OLDCHAT, remove after 12 Dec 2026: this test (it goes with the `oldLine` prop).
    it('shows the photo, without a new bubble, once the line is shown old (oldLine false → true)', async () => {
        await show({ oldLine: false });
        expect(asks().map((a) => a.args)).toEqual([['conv-1', 'm-1', false]]);
        expect(loading()).toBe(true);
        await answer(asks()[0], null);
        expect(locked()).toBe(true);
        expect(photo()).toBeNull();

        await show({ oldLine: true });
        // The lock is lifted while it asks again, and the ask carries the line's new standing.
        expect(locked()).toBe(false);
        expect(loading()).toBe(true);
        expect(asks().map((a) => a.args)).toEqual([['conv-1', 'm-1', false], ['conv-1', 'm-1', true]]);
        await answer(asks()[1], 'file:///cache/m-1.jpg');
        expect(photo()).toBe('file:///cache/m-1.jpg');
        expect(locked()).toBe(false);
    });

    it('shows the photo once the chat\'s key context arrives (keyContext changes)', async () => {
        await show({ keyContext: '' });
        await answer(asks()[0], null);
        expect(locked()).toBe(true);

        await show({ keyContext: 'peer-b||' });
        expect(asks()).toHaveLength(2);
        await answer(asks()[1], 'file:///cache/m-1.jpg');
        expect(photo()).toBe('file:///cache/m-1.jpg');
        expect(locked()).toBe(false);
    });

    it('also opens again after a throw, not only after a null', async () => {
        await show({ keyContext: '' });
        asks()[0].reject(new Error('pins unreadable'));
        await settle();
        expect(locked()).toBe(true);
        await show({ keyContext: 'peer-b||' });
        await answer(asks()[1], 'file:///cache/m-1.jpg');
        expect(photo()).toBe('file:///cache/m-1.jpg');
    });

    it('asks again for another message in the same bubble, and clears the last photo while it does', async () => {
        await show({ messageId: 'm-1' });
        await answer(asks()[0], 'file:///cache/m-1.jpg');
        expect(photo()).toBe('file:///cache/m-1.jpg');

        await show({ messageId: 'm-2' });
        expect(asks().map((a) => a.args[1])).toEqual(['m-1', 'm-2']);
        // m-1's picture is not left standing under m-2 while m-2 loads.
        expect(photo()).toBeNull();
        expect(loading()).toBe(true);
        await answer(asks()[1], 'file:///cache/m-2.jpg');
        expect(photo()).toBe('file:///cache/m-2.jpg');
    });

    it('tapping the photo hands its address up to be shown full screen', async () => {
        const opened: string[] = [];
        await show({ onOpen: (u) => { opened.push(u); } });
        await answer(asks()[0], 'file:///cache/m-1.jpg');
        act(() => { (host.querySelector('button') as HTMLElement).click(); });
        expect(opened).toEqual(['file:///cache/m-1.jpg']);
    });
});

describe('the latest attempt wins', () => {
    // Uses `oldLine` as the changing input: conversion code, log row OLDCHAT, remove after 12 Dec 2026 (rewrite it on `keyContext` then).
    it('an earlier attempt that answers late cannot overwrite a newer photo', async () => {
        await show({ oldLine: false });
        await show({ oldLine: true });
        const [early, late] = asks();
        await answer(late, 'file:///cache/new.jpg');
        expect(photo()).toBe('file:///cache/new.jpg');
        // The first attempt comes back after it, with a photo of its own, then another with nothing.
        await answer(early, 'file:///cache/stale.jpg');
        expect(photo()).toBe('file:///cache/new.jpg');
        expect(locked()).toBe(false);
    });

    it('an earlier attempt that fails late cannot lock a photo a newer attempt opened', async () => {
        await show({ keyContext: '' });
        await show({ keyContext: 'peer-b||' });
        const [early, late] = asks();
        await answer(late, 'file:///cache/new.jpg');
        await answer(early, null);
        expect(photo()).toBe('file:///cache/new.jpg');
        expect(locked()).toBe(false);
    });

    // Uses `oldLine` as the changing input: conversion code, log row OLDCHAT, remove after 12 Dec 2026 (rewrite it on `keyContext` then).
    it('an earlier attempt that opens late cannot lift a newer failure', async () => {
        await show({ oldLine: false });
        await show({ oldLine: true });
        const [early, late] = asks();
        await answer(late, null);
        expect(locked()).toBe(true);
        await answer(early, 'file:///cache/stale.jpg');
        expect(locked()).toBe(true);
        expect(photo()).toBeNull();
    });

    it('an attempt that answers after the bubble has left is ignored (no update on an unmounted bubble)', async () => {
        await show();
        const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
        act(() => root.render(null));
        await answer(asks()[0], 'file:///cache/m-1.jpg');
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
        expect(host.innerHTML).toBe('');
    });
});

describe('a real failure stays a failure until what it opens with changes', () => {
    it('asks once, however often the screen draws it again with the same things', async () => {
        const onOpen = () => {};
        await show({ oldLine: false, keyContext: 'peer-a||', onOpen });
        await answer(asks()[0], null);
        expect(locked()).toBe(true);
        // The screen redraws on every poll: same line, same key, even a new callback each time.
        for (let i = 0; i < 5; i++) await show({ oldLine: false, keyContext: 'peer-a||', onOpen: () => {} });
        await settle();
        expect(asks()).toHaveLength(1);
        expect(locked()).toBe(true);
    });

    // Uses `oldLine` as the changing input: conversion code, log row OLDCHAT, remove after 12 Dec 2026 (rewrite it on `keyContext` then).
    it('a failure that throws is final too, and a fail again on the new inputs is final again', async () => {
        await show({ oldLine: false });
        asks()[0].reject(new Error('boom'));
        await settle();
        await show({ oldLine: false });
        expect(asks()).toHaveLength(1);
        expect(locked()).toBe(true);

        await show({ oldLine: true });
        expect(asks()).toHaveLength(2);
        await answer(asks()[1], null);
        expect(locked()).toBe(true);
        await show({ oldLine: true });
        await settle();
        expect(asks()).toHaveLength(2);
    });
});

describe('dmKeyContextOf: the screen\'s word for the key its chat is under', () => {
    it('is empty with nothing on offer, and changes with the offered key, first sight and an unplaced thread', () => {
        expect(dmKeyContextOf(null)).toBe('');
        expect(dmKeyContextOf(undefined)).toBe('');
        const offered = dmKeyContextOf({ offeredPeer: 'peer-b', firstSight: false });
        const several = dmKeyContextOf({ offeredPeer: null, firstSight: false });
        const first = dmKeyContextOf({ offeredPeer: 'peer-b', firstSight: true });
        const unplaced = dmKeyContextOf({ offeredPeer: 'peer-b', firstSight: true, unplaced: true });
        expect(new Set(['', offered, several, first, unplaced]).size).toBe(5);
        // The same change drawn twice is the same word, so a poll that reads it again doesn't ask again.
        expect(dmKeyContextOf({ offeredPeer: 'peer-b', firstSight: false })).toBe(offered);
    });
});

describe('the DM screen draws its photos with this bubble, and tells it the key its chat is under', () => {
    it('app/chat/[id].tsx imports ChatImage from the component and passes keyContext from its key-change check', async () => {
        const { readFileSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        const screen = readFileSync(resolve(__dirname, '../../app/chat/[id].tsx'), 'utf8');
        expect(screen).toMatch(/import \{ ChatImage, dmKeyContextOf \} from '\.\.\/\.\.\/components\/chat\/DmChatImage'/);
        expect(screen).not.toMatch(/function ChatImage\(/);
        // The line's standing and the key context, from the same state the banner is drawn from (keyChange), on every photo it draws.
        expect(screen).toMatch(/<ChatImage [^>]*oldLine=\{!!item\.oldLine\}[^>]*keyContext=\{dmKeyContextOf\(keyChange\)\}/);
    });
});
