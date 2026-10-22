// @vitest-environment jsdom
/**
 * Render tests for PulseFeedCard Instagram link card (Phase 3 / tier B).
 *
 * Requirements:
 * - With a thumbnail: show it (as today) with the platform badge.
 * - With none OR when the image fails to load: a designed card, never an empty dark box:
 *   the Instagram glyph/badge, the post's title or caption first line, the author, and ONE
 *   clear button "Open on Instagram" (through t() with a LITERAL key; English only).
 * - Drop the duplicate second link on Instagram cards (keep one way out). Same on the web.
 * - YouTube and other platforms unchanged.
 * - Holds at 320 dp and 1.3x text, light and dark; colours from the central tokens only; the button >= 44 px.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo', () => ({
    requireNativeModule: vi.fn(() => ({})),
    requireOptionalNativeModule: vi.fn(() => null),
}));

vi.mock('expo-modules-core', () => ({
    requireNativeModule: vi.fn(() => ({})),
    requireOptionalNativeModule: vi.fn(() => null),
    EventEmitter: vi.fn(() => ({ addListener: vi.fn(), removeListener: vi.fn() })),
    NativeModulesProxy: {},
    ProxyNativeModule: {},
}));

vi.mock('expo-crypto', () => ({
    randomUUID: () => 'test-uuid',
    digestStringAsync: vi.fn(),
    getRandomBytesAsync: vi.fn(),
}));

const mockLinking = vi.hoisted(() => ({
    openURL: vi.fn(async () => true),
}));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', radio: 'radio', alert: 'alert' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityHint, accessibilityRole, testID, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        const s = flat(props.style);
        if (s.minHeight) attrs['data-min-height'] = String(s.minHeight);
        if (s.aspectRatio) attrs['data-aspect-ratio'] = String(s.aspectRatio);
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        View: el('div'),
        Text: el('span'),
        Pressable: el('button'),
        StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => flat(s) },
        Alert: { alert: vi.fn() },
        Linking: mockLinking,
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});

let lastImageProps: any = null;
vi.mock('expo-image', () => ({
    Image: (props: any) => {
        lastImageProps = props;
        return createElement('img', {
            src: props.source?.uri,
            'data-testid': 'pulse-thumbnail-image',
        });
    },
}));

vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-testid': 'member-avatar' }) }));
vi.mock('../../components/PulseYouTubePlayer', () => ({ PulseYouTubePlayer: () => createElement('div', { 'data-testid': 'yt-player' }) }));

vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown; patternEnabled: boolean }) => unknown) =>
            make({ theme: 'light', colors: lightColors, patternEnabled: false }),
    };
});

import { PulseFeedCard } from '../../components/PulseFeedCard';
import { type PulseFeedItem } from '../pulse';

const instagramNoThumb: PulseFeedItem = {
    id: 'pulse-ig-1',
    ownerPubkey: 'kofi-key',
    callsign: 'Kofi',
    avatarUrl: null,
    platform: 'instagram',
    category: 'art',
    url: 'https://www.instagram.com/p/abc123xyz/',
    title: 'Kiln firing at dawn\nSecond line of caption that should not be in title',
    thumbnailUrl: null,
    publishedAt: new Date().toISOString(),
    source: 'member',
    isVerified: false,
};

const instagramWithThumb: PulseFeedItem = {
    id: 'pulse-ig-2',
    ownerPubkey: 'kofi-key',
    callsign: 'Kofi',
    avatarUrl: null,
    platform: 'instagram',
    category: 'art',
    url: 'https://www.instagram.com/p/abc123xyz/',
    title: 'Kiln firing at dawn',
    thumbnailUrl: 'https://example.com/thumb.jpg',
    publishedAt: new Date().toISOString(),
    source: 'member',
    isVerified: false,
};

const youtubeItem: PulseFeedItem = {
    id: 'pulse-yt-1',
    ownerPubkey: 'ana-key',
    callsign: 'Ana',
    avatarUrl: null,
    platform: 'youtube',
    category: 'food',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    title: 'Planting garlic by the moon',
    thumbnailUrl: 'https://example.com/yt-thumb.jpg',
    publishedAt: new Date().toISOString(),
    source: 'member',
    isVerified: true,
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    mockLinking.openURL.mockClear();
    lastImageProps = null;
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe('PulseFeedCard Instagram link card (native)', () => {
    it('an Instagram item with no thumbnail renders the card title/author and one Open on Instagram button, no empty block, and only one link', async () => {
        await act(async () => {
            root.render(createElement(PulseFeedCard, { item: instagramNoThumb }));
        });

        // Title first line
        expect(host.textContent).toContain('Kiln firing at dawn');
        expect(host.textContent).not.toContain('Second line of caption');

        // Author
        expect(host.textContent).toContain('Kofi');

        // ONE clear button "Open on Instagram" (touch target >= 44px)
        const igBtn = Array.from(host.querySelectorAll('button')).find(
            (b) => b.textContent?.trim() === 'Open on Instagram'
        );
        expect(igBtn, 'Open on Instagram button should exist').toBeDefined();
        expect(Number(igBtn?.getAttribute('data-min-height'))).toBeGreaterThanOrEqual(44);

        // No empty aspect-ratio block
        const emptyBlock = Array.from(host.querySelectorAll('[data-aspect-ratio]')).find(
            (el) => !el.querySelector('img')
        );
        expect(emptyBlock, 'Should not render an empty 16:9 placeholder block').toBeUndefined();

        // Exactly ONE link to the external post
        const links = Array.from(host.querySelectorAll('[role="link"]'));
        expect(links.length, 'Only one link on Instagram card').toBe(1);
        expect(links[0].textContent).toContain('Open on Instagram');

        // Clicking the button opens the post
        await act(async () => {
            igBtn?.click();
        });
        expect(mockLinking.openURL).toHaveBeenCalledWith('https://www.instagram.com/p/abc123xyz/');
    });

    it('a failed image falls back to the same card', async () => {
        await act(async () => {
            root.render(createElement(PulseFeedCard, { item: instagramWithThumb, nodeUrl: 'https://node.example' }));
        });

        expect(lastImageProps).not.toBeNull();

        // Trigger image onError
        await act(async () => {
            lastImageProps.onError();
        });

        // Now falls back to designed card:
        expect(host.textContent).toContain('Kiln firing at dawn');
        expect(host.textContent).toContain('Kofi');

        const igBtn = Array.from(host.querySelectorAll('button')).find(
            (b) => b.textContent?.trim() === 'Open on Instagram'
        );
        expect(igBtn).toBeDefined();
        expect(Number(igBtn?.getAttribute('data-min-height'))).toBeGreaterThanOrEqual(44);

        const emptyBlock = Array.from(host.querySelectorAll('[data-aspect-ratio]')).find(
            (el) => !el.querySelector('img')
        );
        expect(emptyBlock).toBeUndefined();

        const links = Array.from(host.querySelectorAll('[role="link"]'));
        expect(links.length).toBe(1);
        expect(links[0].textContent).toContain('Open on Instagram');
    });

    it('an Instagram item with a valid thumbnail shows the thumbnail with badge and drops the duplicate second link', async () => {
        await act(async () => {
            root.render(createElement(PulseFeedCard, { item: instagramWithThumb, nodeUrl: 'https://node.example' }));
        });

        // Shows thumbnail with platform badge
        expect(host.querySelector('img')).not.toBeNull();
        expect(host.textContent).toContain('Instagram ↗');

        // Does NOT render the duplicate "Open on Instagram ↗" link
        expect(host.textContent).not.toContain('Open on Instagram ↗');

        // Only one link out
        const links = Array.from(host.querySelectorAll('[role="link"]'));
        expect(links.length).toBe(1);
    });

    it('a YouTube item is unchanged', async () => {
        await act(async () => {
            root.render(createElement(PulseFeedCard, { item: youtubeItem, nodeUrl: 'https://node.example' }));
        });

        // YouTube retains its "Open on YouTube ↗" footer link
        expect(host.textContent).toContain('Open on YouTube ↗');
        expect(host.textContent).toContain('Planting garlic by the moon');
    });
});
