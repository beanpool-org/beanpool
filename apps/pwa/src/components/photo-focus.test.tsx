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

    it('the event list card (the Market\'s List view, the map\'s event pop-up) crops at the focus, centred with none', () => {
        const event: any = {
            id: 'ev-2', type: 'event', category: 'community', title: 'Seed swap', description: '', priceType: 'fixed',
            authorPublicKey: 'host-pk', authorCallsign: 'Hazel', createdAt: new Date().toISOString(), active: true, status: 'active',
            eventStartAt: new Date(Date.now() + 86400000).toISOString(), eventState: 'scheduled', photos: ['/uploads/swap.jpg'],
        };
        const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me' };
        for (const [extra, want] of [[{}, ''], [{ photoFocus: [{ x: 0.3, y: 0.95 }] }, '30% 95%']] as const) {
            for (const popUp of [false, true]) {
                const drawn = at320(<EventCard post={{ ...event, ...extra }} identity={identity} viewMode="list" popUp={popUp} />);
                const slot = screen.getByTestId('event-list-photo');
                fireEvent.load(slot.querySelector('img')!);
                expect({ popUp, at: within(slot).getByRole('img').style.objectPosition }).toEqual({ popUp, at: want });
                drawn.unmount();
            }
        }
    });
});

describe('PhotoFocusDialog', () => {
    /** An upright 3:4 photo, as a phone takes one, laid out 300 x 400 at the page's top left. */
    function open(focus: { x: number; y: number } | null, onDone = vi.fn(), onCancel = vi.fn()) {
        at320(<PhotoFocusDialog src="data:image/jpeg;base64,AAAA" focus={focus} onDone={onDone} onCancel={onCancel} />);
        return { stage: loaded(600, 800), onDone, onCancel };
    }
    /** The stage's photo loads at `w` x `h`, laid out 300 x 400 at the page's top left. */
    function loaded(w: number, h: number) {
        const stage = screen.getByTestId('photo-focus-stage');
        const photo = stage.querySelector('img')!;
        Object.defineProperty(photo, 'naturalWidth', { value: w, configurable: true });
        Object.defineProperty(photo, 'naturalHeight', { value: h, configurable: true });
        fireEvent.load(photo);
        stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 400, right: 300, bottom: 400, x: 0, y: 0, toJSON() {} });
        return stage;
    }
    const buttonWords = () => within(screen.getByRole('dialog')).getAllByRole('button').map((b) => b.textContent);

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

    it('is drawn on the page\'s body, never inside its opener: a blurred, scrolling composer panel cannot hold or clip it', () => {
        // The map's post composer is `fixed … overflow-y-auto … backdrop-blur-xl`: a backdrop-filter ancestor is the containing
        // block of a fixed box inside it, so a dialog drawn in place was laid out against the panel (review of 200e812d).
        render(
            <div data-testid="composer" className="fixed max-h-[60vh] overflow-y-auto backdrop-blur-xl">
                <PhotoFocusDialog src="data:image/jpeg;base64,AAAA" focus={null} onDone={vi.fn()} onCancel={vi.fn()} />
            </div>,
        );
        const backdrop = screen.getByTestId('photo-focus-backdrop');
        expect(backdrop.parentElement).toBe(document.body);
        expect(screen.getByTestId('composer').contains(screen.getByRole('dialog'))).toBe(false);
        expect(backdrop.className).toContain('fixed inset-0');
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

    it('opened by itself on several new photos: Next (n of count) and Skip while more are to come; Skip hands back this photo\'s choice', () => {
        const onDone = vi.fn();
        const onSkip = vi.fn();
        at320(<PhotoFocusDialog src="data:image/jpeg;base64,AAAA" focus={null} step={{ n: 1, count: 3, more: true }} onDone={onDone} onSkip={onSkip} onCancel={vi.fn()} />);
        const stage = loaded(600, 800);
        expect(buttonWords()).toEqual(['Reset', 'Cancel', 'Skip', 'Next (1 of 3)']);
        fireEvent.pointerDown(stage, { clientX: 150, clientY: 2, pointerId: 1 });
        fireEvent.click(screen.getByText('Next (1 of 3)'));
        expect(onDone).toHaveBeenCalledWith({ x: 0.5, y: 0 });
        fireEvent.click(screen.getByTestId('photo-focus-skip'));
        expect(onSkip).toHaveBeenCalledWith({ x: 0.5, y: 0 });
    });

    it('the last photo of a walk, one new photo, and a click: Done, and no Skip', () => {
        for (const step of [{ n: 3, count: 3, more: false }, null, undefined]) {
            const drawn = at320(<PhotoFocusDialog src="data:image/jpeg;base64,AAAA" focus={null} step={step} onDone={vi.fn()} onSkip={vi.fn()} onCancel={vi.fn()} />);
            expect(buttonWords()).toEqual(['Reset', 'Cancel', 'Done']);
            drawn.unmount();
        }
    });

    it('the next photo of a walk opens on its own focus and its own shape, never the last photo\'s', () => {
        const props = { onDone: vi.fn(), onSkip: vi.fn(), onCancel: vi.fn() };
        const drawn = at320(<PhotoFocusDialog src="data:image/jpeg;base64,ONE" focus={{ x: 0.5, y: 1 }} step={{ n: 1, count: 2, more: true }} {...props} />);
        loaded(600, 800);
        expect(screen.getByTestId('photo-focus-card').style.objectPosition).toBe('50% 100%');
        expect(screen.getByTestId('photo-focus-frame')).toBeInTheDocument();
        drawn.rerender(<div style={{ width: 320 }}><PhotoFocusDialog src="data:image/jpeg;base64,TWO" focus={null} step={{ n: 2, count: 2, more: false }} {...props} /></div>);
        expect(screen.getByTestId('photo-focus-card').style.objectPosition).toBe('50% 33%');
        // Until the second photo has loaded, no frame is drawn at the first photo's shape.
        expect(screen.queryByTestId('photo-focus-frame')).toBeNull();
        loaded(1200, 600);
        expect(screen.getByTestId('photo-focus-frame').style.height).toBe('100%');
    });

    it('at 320 px and 130% the four buttons wrap onto rows, each held to the row\'s width with its words wrapping', () => {
        at320(<PhotoFocusDialog src="data:image/jpeg;base64,AAAA" focus={null} step={{ n: 1, count: 3, more: true }} onDone={vi.fn()} onSkip={vi.fn()} onCancel={vi.fn()} />);
        const buttons = within(screen.getByRole('dialog')).getAllByRole('button');
        expect(buttons[0].parentElement!.className).toContain('flex-wrap');
        for (const b of buttons) {
            expect(b.className).toContain('min-h-[44px]');
            expect(b.className).toContain('max-w-full');
            expect(b.className).toContain('break-words');
        }
    });
});
