/**
 * Learn page "Where:" and photos on the web (lane learn-card-map, slot 1540):
 * A Learn page holds only a place name (`knowledge.place`, no coordinates, no map). A page with only a place name shows the
 * "Where:" line and no map or empty box; a page with photos hides any photo whose image fails to load so no empty 4:3 box sits
 * under "Where:", keeps the remaining photos aligned with ImageLightbox, and ImageLightbox shows its error fallback (never a
 * blank screen) if the enlarged image fails to load. Tested in light and dark mode.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as api from '../lib/api';
import type { LearnPost } from '../lib/learn';
import type { BeanPoolIdentity } from '../lib/identity';
import { LearnPage, type LearnTarget } from './LearnPage';

const info = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock('../lib/features', async (orig) => ({
    ...(await orig<typeof import('../lib/features')>()),
    useCommunityInfo: () => info.current,
    useReaderFeatures: () => null,
}));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));
vi.mock('../components/StartCommunityScreen', () => ({ StartCommunityScreen: () => null }));

const ME = 'me-pk';
const identity: BeanPoolIdentity = { publicKey: ME, privateKey: 'k', callsign: 'Tessa', createdAt: '2026-09-17T00:00:00.000Z' };
const WHERE = 'Riverside district: Northgate, Eastwood, Lowtown, surrounds';
const PHOTO_A = '/api/marketplace/posts/nr/photos/0?v=1&k=AAA';
const PHOTO_B = '/api/marketplace/posts/nr/photos/1?v=1&k=BBB';
const PHOTO_C = '/api/marketplace/posts/nr/photos/2?v=1&k=CCC';

function makePost(photos: string[] = []): LearnPost {
    return {
        id: 'nr',
        type: 'knowledge',
        category: 'emergencies',
        title: 'Flood watch in the Riverside valley',
        description: 'Check the SES warnings and road closures before driving.',
        authorPublicKey: 'ada-pk',
        authorCallsign: 'Ada',
        createdAt: '2026-10-01T00:00:00.000Z',
        status: 'active',
        photos,
        knowledge: {
            sources: [],
            place: WHERE,
            lang: 'en',
            checkedAt: '2026-10-20T00:00:00.000Z',
            outdatedAt: null,
            outdatedNote: null,
            helped: 3,
            gathered: false,
        },
    };
}

let currentPost: LearnPost = makePost();
const wait = async (ms: number) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };

async function openPage(post: LearnPost) {
    currentPost = post;
    const target: LearnTarget = { kind: 'page', id: post.id };
    render(
        <LearnPage
            identity={identity}
            target={target}
            onTargetTaken={vi.fn()}
            onBack={vi.fn()}
            onOpenProfile={vi.fn()}
            onNavigate={vi.fn()}
            onNearYou={vi.fn()}
        />,
    );
    await wait(30);
}

beforeEach(() => {
    vi.restoreAllMocks();
    document.documentElement.classList.remove('dark-theme');
    info.current = { features: { knowledge: true } };
    vi.spyOn(api, 'myNodeRoleOnce').mockResolvedValue(null);
    vi.spyOn(api, 'request').mockImplementation((async (_m: string, path: string) => {
        if (path.startsWith('/api/marketplace/posts?')) return [currentPost];
        return { waiting: [], answered: [] };
    }) as never);
});

afterEach(() => {
    cleanup();
    document.documentElement.classList.remove('dark-theme');
});

describe.each(['light', 'dark'] as const)('Learn page Where: and photos on the web (%s)', (theme) => {
    beforeEach(() => {
        if (theme === 'dark') document.documentElement.classList.add('dark-theme');
    });

    it('with only a place name and no photos: shows the Where: line and no empty box or map', async () => {
        await openPage(makePost([]));
        expect(screen.getByTestId('learn-post-place').textContent).toBe(`Where: ${WHERE}`);
        expect(screen.queryByTestId('learn-post-photos')).toBeNull();
        expect(document.querySelector('.leaflet-container')).toBeNull();
    });

    it('with a working photo: renders it and clicking opens ImageLightbox with the photo', async () => {
        await openPage(makePost([PHOTO_A]));
        expect(screen.getByTestId('learn-post-place').textContent).toBe(`Where: ${WHERE}`);
        const photosBox = screen.getByTestId('learn-post-photos');
        const btn = within(photosBox).getByRole('button');
        expect(btn.querySelector('img')?.getAttribute('src')).toBe(PHOTO_A);

        fireEvent.click(btn);
        const dialog = screen.getByRole('dialog');
        expect(dialog).toBeInTheDocument();
        expect(dialog.querySelector('img')?.getAttribute('src')).toBe(PHOTO_A);
    });

    it('when the only photo fails to load: hides learn-post-photos completely so no empty box remains under Where:', async () => {
        await openPage(makePost([PHOTO_A]));
        const img = screen.getByTestId('learn-post-photos').querySelector('img')!;
        fireEvent.error(img);
        expect(screen.queryByTestId('learn-post-photos')).toBeNull();
        expect(screen.getByTestId('learn-post-place').textContent).toBe(`Where: ${WHERE}`);
    });

    it('when 1 of 2 photos fails: keeps only the working photo and opens ImageLightbox on that photo', async () => {
        await openPage(makePost([PHOTO_A, PHOTO_B]));
        const imgs = Array.from(screen.getByTestId('learn-post-photos').querySelectorAll('img'));
        expect(imgs).toHaveLength(2);
        fireEvent.error(imgs[0]);

        const remaining = within(screen.getByTestId('learn-post-photos')).getAllByRole('button');
        expect(remaining).toHaveLength(1);
        expect(remaining[0].getAttribute('aria-label')).toContain('1 of 1');
        expect(remaining[0].querySelector('img')?.getAttribute('src')).toBe(PHOTO_B);

        fireEvent.click(remaining[0]);
        const dialog = screen.getByRole('dialog');
        expect(dialog.querySelector('img')?.getAttribute('src')).toBe(PHOTO_B);
    });

    it('keeps ImageLightbox on the tapped photo if an earlier photo fails while it is open', async () => {
        await openPage(makePost([PHOTO_A, PHOTO_B, PHOTO_C]));
        const buttons = within(screen.getByTestId('learn-post-photos')).getAllByRole('button');
        expect(buttons).toHaveLength(3);
        fireEvent.click(buttons[1]);
        const dialog = screen.getByRole('dialog');
        expect(dialog.querySelector('img')?.getAttribute('src')).toBe(PHOTO_B);

        const firstImg = buttons[0].querySelector('img')!;
        fireEvent.error(firstImg);
        expect(screen.getByRole('dialog').querySelector('img')?.getAttribute('src')).toBe(PHOTO_B);
    });

    it('when the enlarged photo in ImageLightbox fails to load: shows the error alert and Retry (never a blank screen)', async () => {
        await openPage(makePost([PHOTO_A]));
        fireEvent.click(within(screen.getByTestId('learn-post-photos')).getByRole('button'));
        const dialog = screen.getByRole('dialog');
        const enlarged = dialog.querySelector('img')!;
        fireEvent.error(enlarged);
        const alert = within(dialog).getByRole('alert');
        expect(alert.textContent).toContain('Photo failed to load');
        expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });
});
