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

const mockFetchDailyPulse = vi.hoisted(() => vi.fn());
vi.mock('../pulse', async (importOriginal) => {
    const mod = await importOriginal<typeof import('../pulse')>();
    return {
        ...mod,
        fetchDailyPulse: mockFetchDailyPulse,
    };
});

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', radio: 'radio', alert: 'alert' };
    const flat = (style: unknown): Record<string, any> => {
        const resolved = typeof style === 'function' ? (style as any)({ pressed: false }) : style;
        return Object.assign({}, ...[resolved].flat(4).filter((x) => x && typeof x === 'object'));
    };
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
        ScrollView: el('div'),
        ActivityIndicator: el('span'),
        Modal: function MockModal(props: any) {
            return props.visible ? createElement('div', { role: 'dialog', 'data-testid': 'pulse-reflection-modal' }, props.children) : null;
        },
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
    mockFetchDailyPulse.mockClear();
    lastImageProps = null;
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe('PulseFeedCard Instagram link card (native)', () => {
    it('an Instagram item with no thumbnail renders the card title/author and one Open on Instagram button, no empty block, and only one link', async () => {
        await act(async () => {
            root.render(createElement(PulseFeedCard, { item: instagramNoThumb }) as any);
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
            root.render(createElement(PulseFeedCard, { item: instagramWithThumb, nodeUrl: 'https://node.example' }) as any);
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

    it('resets imageFailed when item or thumbnail changes so recycled cards are not permanently locked in fallback', async () => {
        await act(async () => {
            root.render(createElement(PulseFeedCard, { item: instagramWithThumb, nodeUrl: 'https://node.example' }) as any);
        });

        expect(lastImageProps).not.toBeNull();

        // Trigger image onError to switch to fallback mode
        await act(async () => {
            lastImageProps.onError();
        });
        expect(host.querySelector('img')).toBeNull();

        // Feed updates or card recycled with a new item with thumbnail
        const newItem = {
            ...instagramWithThumb,
            id: 'pulse-ig-new',
            title: 'New ceramic bowl',
        };
        await act(async () => {
            root.render(createElement(PulseFeedCard, { item: newItem, nodeUrl: 'https://node.example' }) as any);
        });

        // imageFailed reset, attempts image render again
        expect(host.querySelector('img')).not.toBeNull();
    });

    it('an Instagram item with a valid thumbnail shows the thumbnail with badge and drops the duplicate second link', async () => {
        await act(async () => {
            root.render(createElement(PulseFeedCard, { item: instagramWithThumb, nodeUrl: 'https://node.example' }) as any);
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

    it('handles caption with leading newlines and whitespace safely', async () => {
        const itemWithLeadingNewlines = {
            ...instagramNoThumb,
            id: 'pulse-ig-leading-newlines',
            title: '\n\n   \nActual caption first line\nSecond line',
        };
        await act(async () => {
            root.render(createElement(PulseFeedCard, { item: itemWithLeadingNewlines }) as any);
        });

        expect(host.textContent).toContain('Actual caption first line');
        expect(host.textContent).not.toContain('Second line');

        const itemWhitespaceOnly = {
            ...instagramNoThumb,
            id: 'pulse-ig-whitespace',
            title: '   \n\n   ',
        };
        await act(async () => {
            root.render(createElement(PulseFeedCard, { item: itemWhitespaceOnly }) as any);
        });

        // Falls back to localized platform title rather than empty string
        expect(host.textContent).toContain('View post on Instagram');
    });

    it('a YouTube item is unchanged', async () => {
        await act(async () => {
            root.render(createElement(PulseFeedCard, { item: youtubeItem, nodeUrl: 'https://node.example' }) as any);
        });

        // YouTube retains its "Open on YouTube ↗" footer link
        expect(host.textContent).toContain('Open on YouTube ↗');
        expect(host.textContent).toContain('Planting garlic by the moon');
    });

    describe('Daily Pulse card (native)', () => {
        const dailyPulseItem: PulseFeedItem = {
            id: 'item_pulse_2026-10-26',
            ownerPubkey: 'pulse-treasury-key',
            callsign: 'Daily Pulse',
            avatarUrl: null,
            platform: 'website',
            category: 'learn',
            url: null,
            title: 'Plant seeds of kindness',
            thumbnailUrl: null,
            publishedAt: '2026-10-26T05:00:00.000Z',
            source: 'curated',
            isVerified: true,
        };

        it('renders as a tappable card with accessible name, and tap opens reflection with headline and body', async () => {
            mockFetchDailyPulse.mockResolvedValueOnce({
                date: '2026-10-26',
                headline: 'Plant seeds of kindness',
                body: 'Kindness is the soil in which trust grows.',
            });

            await act(async () => {
                root.render(createElement(PulseFeedCard, { item: dailyPulseItem }) as any);
            });

            // Card has accessible name and is not disabled
            const trigger = Array.from(host.querySelectorAll('button')).find(
                (b) => b.getAttribute('aria-label')?.includes('Daily Reflection') || b.textContent?.includes('Daily Reflection')
            );
            expect(trigger, 'Daily Pulse card trigger should exist and not be disabled').toBeDefined();

            // Tapping the card opens the reflection modal
            await act(async () => {
                trigger?.click();
            });

            const modal = host.querySelector('[data-testid="pulse-reflection-modal"]');
            expect(modal, 'Reflection modal should be opened').not.toBeNull();
            expect(modal?.textContent).toContain('Plant seeds of kindness');
            expect(modal?.textContent).toContain('Kindness is the soil in which trust grows.');
            expect(modal?.textContent).toContain('2026-10-26');

            // Close button works
            const closeBtn = Array.from(modal?.querySelectorAll('button') || []).find(
                (b) => b.textContent?.trim() === 'Close' || b.getAttribute('aria-label') === 'Close'
            );
            expect(closeBtn, 'Close button should exist in modal').toBeDefined();
            await act(async () => {
                closeBtn?.click();
            });

            expect(host.querySelector('[data-testid="pulse-reflection-modal"]')).toBeNull();
        });

        it('shows a line in the app words with Retry on failed read, and Retry re-fetches', async () => {
            mockFetchDailyPulse.mockRejectedValueOnce(new Error('Network error'));

            await act(async () => {
                root.render(createElement(PulseFeedCard, { item: dailyPulseItem }) as any);
            });

            const trigger = Array.from(host.querySelectorAll('button')).find(
                (b) => b.getAttribute('aria-label')?.includes('Daily Reflection') || b.textContent?.includes('Daily Reflection')
            );
            await act(async () => {
                trigger?.click();
            });

            const modal = host.querySelector('[data-testid="pulse-reflection-modal"]');
            expect(modal, 'Modal opens on tap').not.toBeNull();

            // Shows error message and Retry button
            expect(modal?.textContent).toContain('Failed to load');
            const retryBtn = Array.from(modal?.querySelectorAll('button') || []).find(
                (b) => b.textContent?.trim() === 'Retry'
            );
            expect(retryBtn, 'Retry button should exist on error').toBeDefined();

            // Clicking Retry re-fetches
            mockFetchDailyPulse.mockResolvedValueOnce({
                date: '2026-10-26',
                headline: 'Plant seeds of kindness',
                body: 'Kindness is the soil in which trust grows.',
            });

            await act(async () => {
                retryBtn?.click();
            });

            expect(mockFetchDailyPulse).toHaveBeenCalledTimes(2);
            expect(modal?.textContent).toContain('Kindness is the soil in which trust grows.');
        });
    });
});
