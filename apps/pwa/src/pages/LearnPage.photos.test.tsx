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

    it('does not reset a loaded ImageLightbox back to loading when a later background thumbnail fails', async () => {
        await openPage(makePost([PHOTO_A, PHOTO_B]));
        const buttons = within(screen.getByTestId('learn-post-photos')).getAllByRole('button');
        fireEvent.click(buttons[0]);
        const dialog = screen.getByRole('dialog');
        const enlarged = dialog.querySelector('img')!;
        fireEvent.load(enlarged);
        expect(within(dialog).queryByRole('status')).toBeNull();
        expect(enlarged.className).toContain('opacity-100');

        // Background lazy thumbnail B fails: page hides B, but the open lightbox stays loaded on A.
        fireEvent.error(buttons[1].querySelector('img')!);
        expect(within(screen.getByTestId('learn-post-photos')).getAllByRole('button')).toHaveLength(1);
        expect(within(dialog).queryByRole('status')).toBeNull();
        expect(dialog.querySelector('img')?.className).toContain('opacity-100');
        expect(dialog.querySelector('img')?.getAttribute('src')).toBe(PHOTO_A);
    });

    it('keeps navigation intact and preserves surviving thumbnail DOM nodes and focus when background thumbnails fail', async () => {
        await openPage(makePost([PHOTO_A, PHOTO_B, PHOTO_C]));
        const buttonsBefore = within(screen.getByTestId('learn-post-photos')).getAllByRole('button');
        const btnB = buttonsBefore[1];
        const btnC = buttonsBefore[2];
        fireEvent.click(btnB);
        const dialog = screen.getByRole('dialog');
        // Advance from B to C.
        fireEvent.click(within(dialog).getByRole('button', { name: 'Next photo' }));
        expect(dialog.querySelector('img')?.getAttribute('src')).toBe(PHOTO_C);

        // Thumbnail A fails behind the open lightbox: lightbox stays on C, and B/C buttons are NOT remounted.
        fireEvent.error(buttonsBefore[0].querySelector('img')!);
        expect(screen.getByRole('dialog').querySelector('img')?.getAttribute('src')).toBe(PHOTO_C);
        const buttonsAfter = within(screen.getByTestId('learn-post-photos')).getAllByRole('button');
        expect(buttonsAfter).toHaveLength(2);
        expect(buttonsAfter[0]).toBe(btnB);
        expect(buttonsAfter[1]).toBe(btnC);

        // Closing the lightbox restores focus to the still-connected trigger button B.
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close photo viewer' }));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.activeElement).toBe(btnB);
    });

    it('keeps lightbox open if the tapped thumbnail fails while viewing another slide, and falls back focus on close', async () => {
        await openPage(makePost([PHOTO_A, PHOTO_B]));
        const buttons = within(screen.getByTestId('learn-post-photos')).getAllByRole('button');
        fireEvent.click(buttons[0]);
        const dialog = screen.getByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Next photo' }));
        expect(dialog.querySelector('img')?.getAttribute('src')).toBe(PHOTO_B);

        // Originally tapped thumbnail A fails behind the lightbox: lightbox must not abruptly unmount.
        fireEvent.error(buttons[0].querySelector('img')!);
        expect(screen.getByRole('dialog').querySelector('img')?.getAttribute('src')).toBe(PHOTO_B);

        // Closing falls back focus to the remaining live thumbnail button (buttons[1]).
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close photo viewer' }));
        await wait(30);
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.activeElement).toBe(buttons[1]);
    });

    it('opens the clicked occurrence when a page contains duplicate photo URLs', async () => {
        await openPage(makePost([PHOTO_A, PHOTO_A]));
        const buttons = within(screen.getByTestId('learn-post-photos')).getAllByRole('button');
        expect(buttons).toHaveLength(2);
        fireEvent.click(buttons[1]);
        const dialog = screen.getByRole('dialog');
        expect(dialog.textContent).toContain('2 / 2');
    });
});
