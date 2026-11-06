// @vitest-environment jsdom
/**
 * The photo opens whole (DESIGN-detail-pages-fable.md §2.6, slice DP4; Marty, 7 Nov): PhotoCarousel draws each photo as a button
 * ("Photo {n} of {count}") only when its page hands it `onOpen`, and says WHICH photo (its index and its own URL, so a filtered-out
 * blank can't shift the count). Without `onOpen` it is the picture it always was: a copy's page on the global community
 * (ListingCopy) draws no button. And the small cards (the Market's, the lists') never gain a press from this: a tap anywhere on a
 * small card opens the item (memory small-cards-open-the-item, #2839).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, onLayout, disabled } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 216 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole) attrs.role = accessibilityRole;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => s },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        Alert: { alert() {} },
    };
});
vi.mock('expo-image', () => ({
    Image: (p: { accessibilityLabel?: string; source?: { uri?: string } }) =>
        createElement('img', { ...(p.accessibilityLabel ? { 'aria-label': p.accessibilityLabel } : {}), ...(p.source?.uri ? { 'data-src': p.source.uri } : {}) }),
}));
vi.mock('expo-router', () => ({ router: { push() {}, back() {}, replace() {}, canGoBack: () => true } }));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAwareScrollView: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('../keyboard-alert', () => ({ Alert: { alert() {} } }));
vi.mock('../db', () => ({ deletePost: vi.fn(), reportAbuse: vi.fn(), createConversationApi: vi.fn(), signedRequest: vi.fn() }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: 'me-key' } }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return { useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }) };
});
vi.mock('../../components/EventCopyDoor', () => ({ EventCopyDoor: () => null }));
vi.mock('../../components/PostTagChips', () => ({ PostTagChips: () => null }));
vi.mock('../../components/ReportReasonBox', () => ({ ReportReasonBox: () => null }));

import { PhotoCarousel } from '../../components/PhotoCarousel';
import { ListingCopyDetail } from '../../components/ListingCopy';

const A = 'https://mullum.example/api/marketplace/posts/p1/photos/0?v=1791608803169&k=Yqpu8qmgAGQ';
const B = 'https://mullum.example/api/marketplace/posts/p1/photos/1?v=1791608803169&k=Yqpu8qmgAGQ';

let host: HTMLElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const draw = async (node: ReactNode) => { await act(async () => { root.render(node as any); }); };
const buttons = () => Array.from(host.querySelectorAll<HTMLElement>('button[aria-label^="Photo "]'));

describe('PhotoCarousel with onOpen', () => {
    it('draws each photo as a button, "Photo {n} of {count}", and a press says which photo (its index and its own URL)', async () => {
        const onOpen = vi.fn();
        await draw(createElement(PhotoCarousel, { photos: [A, B], height: 216, borderRadius: 14, onOpen }));
        expect(buttons().map((b) => b.getAttribute('aria-label'))).toEqual(['Photo 1 of 2', 'Photo 2 of 2']);
        expect(buttons().every((b) => b.getAttribute('role') === 'button')).toBe(true);
        expect(onOpen).not.toHaveBeenCalled();
        await act(async () => { buttons()[1].click(); });
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(onOpen).toHaveBeenCalledWith(1, B);
        await act(async () => { buttons()[0].click(); });
        expect(onOpen).toHaveBeenLastCalledWith(0, A);
    });

    it('one photo is one button; the counter and the dots are not buttons', async () => {
        const onOpen = vi.fn();
        await draw(createElement(PhotoCarousel, { photos: [A], height: 216, onOpen }));
        expect(buttons().map((b) => b.getAttribute('aria-label'))).toEqual(['Photo 1 of 1']);
        await draw(createElement(PhotoCarousel, { photos: [A, B], height: 216, onOpen }));
        expect(host.querySelectorAll('button').length).toBe(2);
        expect(host.textContent).toContain('1 / 2');
    });

    it('a blank or "null" entry is no photo: the count and the index are of the photos drawn', async () => {
        const onOpen = vi.fn();
        await draw(createElement(PhotoCarousel, { photos: ['', 'null', A, '   ', B], height: 216, onOpen }));
        expect(buttons().map((b) => b.getAttribute('aria-label'))).toEqual(['Photo 1 of 2', 'Photo 2 of 2']);
        await act(async () => { buttons()[1].click(); });
        expect(onOpen).toHaveBeenCalledWith(1, B);
    });
});

describe('PhotoCarousel without onOpen', () => {
    it('is the picture it always was: the photos, their labels, and no button', async () => {
        await draw(createElement(PhotoCarousel, { photos: [A, B], height: 220, borderRadius: 14 }));
        expect(host.querySelectorAll('button').length).toBe(0);
        expect(host.querySelector('img[aria-label="Photo 1 of 2"]')?.getAttribute('data-src')).toBe(A);
        expect(host.querySelector('img[aria-label="Photo 2 of 2"]')?.getAttribute('data-src')).toBe(B);
    });
});

describe("a copy's page on the global community (ListingCopy)", () => {
    it('draws its photos and no photo button, and opens no viewer', async () => {
        const FROM = { host: 'mullum.example.org', postId: 'p1', name: 'Mullum', url: 'https://mullum.example.org', door: 'ask' as const };
        const post = { id: 'c1', type: 'offer', title: 'Sourdough loaves', description: 'Fresh', author_pubkey: 'hidden', photos: JSON.stringify([A, B]), tags: '', shownCopy: true, shownFrom: FROM, shownPrice: '20 fixed' };
        await draw(createElement(ListingCopyDetail, { post }));
        expect(host.querySelector('[data-testid="listing-copy"]')).not.toBeNull();
        expect(host.querySelector('img[aria-label="Photo 1 of 2"]')).not.toBeNull();
        expect(buttons()).toEqual([]);
        expect(host.querySelector('[aria-label="Full-size photo"]')).toBeNull();
    });
});

describe('the small cards gain no press from this (memory small-cards-open-the-item, #2839)', () => {
    const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const source = (rel: string): string => readFileSync(path.join(APP, rel), 'utf8');

    it.each([
        'app/(tabs)/market.tsx',
        'components/MarketCardPicture.tsx',
        'components/ListPhoto.tsx',
        'components/EventCard.tsx',
        'components/home/HomeCardBodies.tsx',
        'components/ListingCopyLine.tsx',
    ])('%s neither imports the carousel nor the photo viewer', (file) => {
        const src = source(file);
        expect(src).not.toMatch(/PhotoCarousel|ChatPhotoViewer/);
    });

    it('only the two detail pages hand the carousel an onOpen', () => {
        expect(source('app/post/[id].tsx')).toMatch(/<PhotoCarousel [^>]*onOpen=/);
        expect(source('components/EventDetail.tsx')).toMatch(/<PhotoCarousel [^>]*onOpen=/);
        expect(source('components/ListingCopy.tsx')).not.toMatch(/onOpen/);
    });
});
