// @vitest-environment jsdom
/**
 * Dragging a card in Arrange (DESIGN-home-arrange-in-place-fable.md §2.2–§2.3, slice A2). jsdom has no layout, so the grid
 * stands at the window's corner and the place is core's `placeLifted` on a column of four 100 px cards; the real browser
 * runs are in e2e/home-check.mjs (`dragAcross`).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { placeLifted } from '@beanpool/core';
import { TOUCH_HOLD_MS, useArrangeDrag, type ArrangeDrag } from './arrange-drag';

const IDS = ['a', 'b', 'c', 'd'];
const onDrop = vi.fn();
let seen: { lift: ArrangeDrag['lift']; ended: number } = { lift: null, ended: 0 };
let hook: ArrangeDrag;
/** One column, each card 100 px tall with no gap: a pointer at y stands over the card whose 100 px holds it. */
const place = (id: string, point: { x: number; y: number }, current: number) =>
    placeLifted(IDS.map(i => ({ id: i, height: 100, movable: true })), id, point, 1, 300, 0, current);

function Grid({ enabled = true }: { enabled?: boolean }) {
    const ref = useRef<HTMLDivElement | null>(null);
    const drag = useArrangeDrag({ gridRef: ref, ids: IDS, enabled, onDrop, place });
    hook = drag;
    seen = { lift: drag.lift, ended: drag.ended };
    return (
        <>
            <div ref={ref} data-testid="home-grid">
                {IDS.map(id => (
                    <section key={id} data-testid={`home-card-${id}`} {...(enabled ? drag.cardProps(id) : {})}>
                        <div data-testid={`card-band-${id}`}><h2>{id}</h2><button type="button">arrow {id}</button></div>
                        <div data-testid={`card-body-${id}`}><p>body {id}</p></div>
                    </section>
                ))}
            </div>
            {drag.lift && <div ref={drag.ghostRef} data-testid="home-arrange-ghost">{drag.lift.id}</div>}
        </>
    );
}

beforeAll(() => {
    if (!('PointerEvent' in window)) {
        class FakePointerEvent extends MouseEvent {
            pointerId: number; isPrimary: boolean; pointerType: string;
            constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; this.isPrimary = init.isPrimary ?? true; this.pointerType = init.pointerType ?? 'mouse'; }
        }
        Object.defineProperty(window, 'PointerEvent', { configurable: true, value: FakePointerEvent });
    }
});
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
afterEach(() => { cleanup(); onDrop.mockReset(); vi.useRealTimers(); });

const press = (testId: string, y: number, pointerType = 'mouse') =>
    fireEvent.pointerDown(screen.getByTestId(testId), { pointerId: 1, isPrimary: true, pointerType, button: 0, clientX: 20, clientY: y });
const move = (y: number, x = 20) => act(() => { fireEvent.pointerMove(window, { pointerId: 1, clientX: x, clientY: y }); });
const up = () => act(() => { fireEvent.pointerUp(window, { pointerId: 1 }); });
const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
/** A touchmove the browser would scroll by, unless it is prevented. */
const touchMove = (testId: string) => {
    const ev = new Event('touchmove', { bubbles: true, cancelable: true });
    screen.getByTestId(testId).dispatchEvent(ev);
    return ev.defaultPrevented;
};

describe('the whole card is the handle in Arrange (A2)', () => {
    it('a mouse pressed on a quiet body lifts the card past a few pixels; a press that never travels is a tap', () => {
        render(<Grid />);
        press('card-body-c', 250);
        move(252);
        up();
        expect(seen.lift).toBeNull();
        press('card-body-c', 250);
        move(252);
        expect(seen.lift).toBeNull();
        move(258);
        expect(seen.lift).toEqual({ id: 'c', to: 2 });
        up();
        expect(onDrop).not.toHaveBeenCalled();
    });

    it('a finger lifts the card by holding still for 250 ms, with no movement; one moment short lifts nothing', () => {
        render(<Grid />);
        press('card-body-c', 250, 'touch');
        wait(TOUCH_HOLD_MS - 1);
        expect(seen.lift).toBeNull();
        wait(1);
        expect(seen.lift).toEqual({ id: 'c', to: 2 });
        move(30);
        up();
        expect(onDrop).toHaveBeenCalledWith('c', 0);
    });

    it('a finger that moves before the hold is up is scrolling: nothing lifts, the scroll is never stopped, nothing drops', () => {
        render(<Grid />);
        press('card-body-c', 250, 'touch');
        wait(100);
        move(290);
        expect(touchMove('card-body-c')).toBe(false);
        wait(TOUCH_HOLD_MS);
        expect(seen.lift).toBeNull();
        move(30);
        up();
        expect(onDrop).not.toHaveBeenCalled();
    });

    it('once a finger has lifted a card, its touchmove is prevented (the page does not scroll from under it), and only until release', () => {
        render(<Grid />);
        press('card-body-b', 150, 'touch');
        expect(touchMove('card-body-b')).toBe(false);
        wait(TOUCH_HOLD_MS);
        expect(seen.lift).not.toBeNull();
        expect(touchMove('card-body-b')).toBe(true);
        up();
        expect(touchMove('card-body-b')).toBe(false);
    });

    it('a press on an arrow never lifts, with a mouse or a finger', () => {
        render(<Grid />);
        fireEvent.pointerDown(screen.getByText('arrow b'), { pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, clientX: 20, clientY: 150 });
        move(40);
        expect(seen.lift).toBeNull();
        up();
        fireEvent.pointerDown(screen.getByText('arrow b'), { pointerId: 1, isPrimary: true, pointerType: 'touch', clientX: 20, clientY: 150 });
        wait(TOUCH_HOLD_MS * 2);
        expect(seen.lift).toBeNull();
        up();
    });

    it('in Arrange a card keeps touch-action: pan-y, so the page still scrolls under a finger, and shows no long-press menu', () => {
        render(<Grid />);
        const card = screen.getByTestId('home-card-c');
        expect(card.style.touchAction).toBe('pan-y');
        expect(card.style.userSelect).toBe('none');
        const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        card.dispatchEvent(menu);
        expect(menu.defaultPrevented).toBe(true);
    });
});

describe('where the card lands, and what is carried (A2)', () => {
    it('the place is the one whose layout puts the card under the pointer; release drops there', () => {
        render(<Grid />);
        press('card-body-d', 350);
        move(345);
        expect(seen.lift).toEqual({ id: 'd', to: 3 });
        move(150); // over b: d goes there, b moves down
        expect(seen.lift).toEqual({ id: 'd', to: 1 });
        move(199); // anywhere on that place, top half or bottom
        expect(seen.lift).toEqual({ id: 'd', to: 1 });
        move(30);
        up();
        expect(onDrop).toHaveBeenCalledWith('d', 0);
        expect(seen.lift).toBeNull();
        expect(seen.ended).toBe(1);
    });

    it('released where it began, nothing is saved', () => {
        render(<Grid />);
        press('card-body-b', 150);
        move(170);
        move(500);
        move(160);
        up();
        expect(onDrop).not.toHaveBeenCalled();
    });

    it('the band is carried only while a card is lifted, under the pointer at the point it was taken', () => {
        render(<Grid />);
        expect(screen.queryByTestId('home-arrange-ghost')).toBeNull();
        press('card-band-c', 230);
        move(236);
        const ghost = screen.getByTestId('home-arrange-ghost');
        // jsdom puts every card at (0, 0): taken 230 px into it, low in a tall card, so the band comes to the pointer by its middle.
        expect(ghost.style.transform).toBe('translate(20px, 212px) scale(1.02)');
        move(300, 60);
        expect(ghost.style.transform).toBe('translate(60px, 276px) scale(1.02)');
        up();
        expect(screen.queryByTestId('home-arrange-ghost')).toBeNull();
    });
});

describe('the hold that opens Arrange goes on as a drag (A2)', () => {
    it('handed over before Arrange has drawn, the card lifts as soon as it has, with no second press, and the first movement moves it', () => {
        const { rerender } = render(<Grid enabled={false} />);
        act(() => hook.adopt('c', { pointerId: 1, pointerType: 'mouse', clientX: 20, clientY: 250, target: screen.getByTestId('card-band-c') }));
        expect(seen.lift).toBeNull();
        rerender(<Grid enabled />);
        expect(seen.lift).toEqual({ id: 'c', to: 2 });
        expect(screen.getByTestId('home-arrange-ghost')).toBeTruthy();
        move(251); // no slop to pass: it is already in the air
        move(40);
        expect(seen.lift).toEqual({ id: 'c', to: 0 });
        up();
        expect(onDrop).toHaveBeenCalledWith('c', 0);
    });

    it('a finger handed over is stopped from scrolling once its card lifts; a hold let go without moving lifts and saves nothing', () => {
        const { rerender } = render(<Grid enabled={false} />);
        act(() => hook.adopt('b', { pointerId: 1, pointerType: 'touch', clientX: 20, clientY: 150, target: screen.getByTestId('card-band-b') }));
        rerender(<Grid enabled />);
        expect(seen.lift).toEqual({ id: 'b', to: 1 });
        expect(touchMove('card-band-b')).toBe(true);
        up();
        expect(seen.lift).toBeNull();
        expect(onDrop).not.toHaveBeenCalled();
    });

    it('a card that stays here is handed over and never lifts', () => {
        const { rerender } = render(<Grid enabled={false} />);
        act(() => hook.adopt('needs', { pointerId: 1, pointerType: 'mouse', clientX: 20, clientY: 10, target: screen.getByTestId('card-band-a') }));
        rerender(<Grid enabled />);
        move(300);
        expect(seen.lift).toBeNull();
        up();
        expect(onDrop).not.toHaveBeenCalled();
    });
});

describe('what puts the card back and saves nothing (L3, kept)', () => {
    it('Escape puts the card back, saves nothing, and never reaches the Escape that ends Arrange', () => {
        render(<Grid />);
        const ends = vi.fn();
        document.addEventListener('keydown', ends);
        press('card-body-d', 350);
        move(345);
        move(30);
        expect(seen.lift).toEqual({ id: 'd', to: 0 });
        act(() => { fireEvent.keyDown(document.body, { key: 'Escape' }); });
        expect(seen.lift).toBeNull();
        expect(screen.queryByTestId('home-arrange-ghost')).toBeNull();
        up();
        expect(onDrop).not.toHaveBeenCalled();
        expect(ends).not.toHaveBeenCalled();
        // With nothing in the air Escape goes on to end Arrange as before.
        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(ends).toHaveBeenCalledTimes(1);
        document.removeEventListener('keydown', ends);
    });

    it('a pointer cancel, a lost pointer and a window blur each put the card down and save nothing', () => {
        render(<Grid />);
        for (const lose of [
            () => fireEvent.pointerCancel(window, { pointerId: 1 }),
            () => fireEvent(window, new Event('lostpointercapture')),
            () => fireEvent.blur(window),
        ]) {
            press('card-body-d', 350);
            move(345);
            move(60);
            expect(seen.lift).not.toBeNull();
            act(() => { lose(); });
            expect(seen.lift).toBeNull();
            up();
        }
        expect(onDrop).not.toHaveBeenCalled();
    });

    it('leaving Arrange with a card in the air puts it back', () => {
        const { rerender } = render(<Grid />);
        press('card-body-d', 350);
        move(345);
        expect(seen.lift).not.toBeNull();
        rerender(<Grid enabled={false} />);
        expect(seen.lift).toBeNull();
        up();
        expect(onDrop).not.toHaveBeenCalled();
    });
});
