/**
 * A card crops a listing's photo at the focus its author picked (Marty, 26 Nov 2026: part of a first post's photo was cut off
 * on its card), and with no focus exactly as it always did: the grid at 50% across, 33% down, the list photo centred. The
 * Adjust dialog (PhotoFocusDialog.tsx) draws the card's frame over the whole photo; a press moves it; Done hands back the
 * focus, Reset the card's own crop, Escape and Cancel nothing. At 320 px and 130% text, in Light and Dark.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarketplaceCard } from './MarketplaceCard';
import { EventCard } from './EventCard';
import { PhotoFocusDialog } from './PhotoFocusDialog';
import type { MarketplacePost } from '../lib/marketplace';
import { cardObjectPosition, focusObjectPosition } from '../lib/photo-focus';

const PHOTO = '/api/marketplace/posts/p-1/photos/0?v=1';
const post: MarketplacePost = {
    id: 'p-1', type: 'offer', category: 'food', title: 'Sourdough', description: 'Fresh', price_c: 500, priceType: 'fixed',
    authorPublicKey: 'a'.repeat(64), authorCallsign: 'Riverside Baker', active: true, status: 'active',
    createdAt: new Date().toISOString(), photos: [PHOTO],
} as unknown as MarketplacePost;

function at320(ui: React.ReactElement) {
    Object.defineProperty(window, 'innerWidth', { value: 320, configurable: true, writable: true });
    document.documentElement.style.fontSize = '130%';
    return render(<div style={{ width: 320 }}>{ui}</div>);
}
const cardImg = (container: HTMLElement) => container.querySelector<HTMLImageElement>('img[alt="Sourdough"]')!;

describe('cards crop at the photo\'s focus', () => {
    it('no focus: the grid keeps 50% 33% and the list photo stays centred, as before', () => {
        const grid = at320(<MarketplaceCard post={post} viewMode="grid" />);
        expect(cardImg(grid.container).style.objectPosition).toBe('50% 33%');
        grid.unmount();
        const list = at320(<MarketplaceCard post={post} viewMode="list" />);
        expect(cardImg(list.container).style.objectPosition).toBe('');
        list.unmount();
    });

    it('a focus crops the grid and the list photo there', () => {
        const focused = { ...post, photoFocus: [{ x: 0.2, y: 0.9 }] };
        const grid = at320(<MarketplaceCard post={focused} viewMode="grid" />);
        expect(cardImg(grid.container).style.objectPosition).toBe('20% 90%');
        grid.unmount();
        const list = at320(<MarketplaceCard post={focused} viewMode="list" />);
        expect(cardImg(list.container).style.objectPosition).toBe('20% 90%');
        list.unmount();
    });

    it('an enterprise\'s banner standing in for a photo ignores the focus', () => {
        expect(cardObjectPosition({ photos: [], photoFocus: [{ x: 0, y: 0 }] }, '/banner.jpg', { objectPosition: '50% 33%' })).toEqual({ objectPosition: '50% 33%' });
        expect(cardObjectPosition({ photos: [PHOTO], photoFocus: [{ x: 0, y: 0 }] }, '/banner.jpg')).toBeUndefined();
        expect(focusObjectPosition(null, { objectPosition: '50% 33%' })).toEqual({ objectPosition: '50% 33%' });
        expect(focusObjectPosition({ x: 1, y: 0 }, { objectPosition: '50% 33%' })).toEqual({ objectPosition: '100% 0%' });
    });

    it('the event tile crops its photo at the focus, and at 50% 33% with none', () => {
        const event: any = {
            id: 'ev-1', type: 'event', category: 'community', title: 'Working bee', description: '', priceType: 'fixed',
            authorPublicKey: 'host-pk', authorCallsign: 'Hazel', createdAt: new Date().toISOString(), active: true, status: 'active',
            eventStartAt: new Date(Date.now() + 86400000).toISOString(), eventState: 'scheduled', photos: ['/uploads/event.jpg'],
        };
        const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me' };
        const plain = at320(<EventCard post={event} identity={identity} />);
        let slot = screen.getByTestId('event-grid-photo');
        fireEvent.load(slot.querySelector('img')!);
        expect(within(slot).getByRole('img').style.objectPosition).toBe('50% 33%');
        plain.unmount();
        at320(<EventCard post={{ ...event, photoFocus: [{ x: 0.5, y: 0.1 }] }} identity={identity} />);
        slot = screen.getByTestId('event-grid-photo');
        fireEvent.load(slot.querySelector('img')!);
        expect(within(slot).getByRole('img').style.objectPosition).toBe('50% 10%');
    });
});

describe('PhotoFocusDialog', () => {
    /** An upright 3:4 photo, as a phone takes one, laid out 300 x 400 at the page's top left. */
    function open(focus: { x: number; y: number } | null, onDone = vi.fn(), onCancel = vi.fn()) {
        at320(<PhotoFocusDialog src="data:image/jpeg;base64,AAAA" focus={focus} onDone={onDone} onCancel={onCancel} />);
        const stage = screen.getByTestId('photo-focus-stage');
        const photo = stage.querySelector('img')!;
        Object.defineProperty(photo, 'naturalWidth', { value: 600 });
        Object.defineProperty(photo, 'naturalHeight', { value: 800 });
        fireEvent.load(photo);
        stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 400, right: 300, bottom: 400, x: 0, y: 0, toJSON() {} });
        return { stage, onDone, onCancel };
    }

    it('is a labelled dialog; the frame sits where today\'s crop is with no focus; the card preview crops the same', () => {
        open(null);
        expect(screen.getByRole('dialog', { name: 'Choose what the card shows' })).toBeInTheDocument();
        const frame = screen.getByTestId('photo-focus-frame');
        expect(frame.style.width).toBe('100%');
        expect(frame.style.height).toBe(`${(9 / 16) * 100}%`);
        expect(parseFloat(frame.style.top)).toBeCloseTo(0.33 * (7 / 16) * 100, 6);
        expect(screen.getByTestId('photo-focus-card').style.objectPosition).toBe('50% 33%');
    });

    it('a press moves the frame to the part pressed, and Done hands back that focus', () => {
        const { stage, onDone } = open(null);
        fireEvent.pointerDown(stage, { clientX: 150, clientY: 2, pointerId: 1 });
        expect(screen.getByTestId('photo-focus-card').style.objectPosition).toBe('50% 0%');
        fireEvent.click(screen.getByTestId('photo-focus-done'));
        expect(onDone).toHaveBeenCalledWith({ x: 0.5, y: 0 });
    });

    it('arrow keys move it too; Reset is the card\'s own crop (no focus)', () => {
        const { stage, onDone } = open({ x: 0.5, y: 0.5 });
        fireEvent.keyDown(stage, { key: 'ArrowDown' });
        expect(screen.getByTestId('photo-focus-card').style.objectPosition).toBe('50% 55%');
        fireEvent.click(screen.getByText('Reset'));
        fireEvent.click(screen.getByTestId('photo-focus-done'));
        expect(onDone).toHaveBeenCalledWith(null);
    });

    it('Escape and Cancel keep nothing', () => {
        const { onDone, onCancel } = open({ x: 0.5, y: 0.2 });
        fireEvent.keyDown(window, { key: 'Escape' });
        fireEvent.click(screen.getByText('Cancel'));
        expect(onCancel).toHaveBeenCalledTimes(2);
        expect(onDone).not.toHaveBeenCalled();
    });

    it('reads in Dark and at 320 px: dark classes on the sheet and its words, buttons 44 px, words wrap', () => {
        open(null);
        const dialog = screen.getByRole('dialog');
        expect(dialog.className).toContain('dark:bg-nature-950');
        expect(screen.getByRole('heading').className).toContain('dark:text-white');
        expect(screen.getByRole('heading').className).toContain('break-words');
        for (const b of within(dialog).getAllByRole('button')) expect(b.className).toContain('min-h-[44px]');
    });
});
