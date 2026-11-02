// @vitest-environment jsdom
/**
 * Dragging a band in Arrange (DESIGN-home-layout-fable.md §3.2, slice L3). jsdom has no layout, so the cards' boxes are
 * given as a column of four 100 px cards; the real browser runs are in e2e/home-check.mjs (`dragAcross`).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useArrangeDrag } from './arrange-drag';

const IDS = ['a', 'b', 'c', 'd'];
const onDrop = vi.fn();
let seen: { lift: unknown; ended: number } = { lift: null, ended: 0 };

function Grid({ enabled = true }: { enabled?: boolean }) {
    const ref = useRef<HTMLDivElement | null>(null);
    const drag = useArrangeDrag({ gridRef: ref, ids: IDS, enabled, onDrop });
    seen = { lift: drag.lift, ended: drag.ended };
    return (
        <div ref={ref} data-testid="home-grid">
            {IDS.map((id, i) => (
                <section key={id} data-testid={`home-card-${id}`} data-top={i * 100}>
                    <div data-testid={`card-band-${id}`} {...drag.bandProps(id)}><h2>{id}</h2><button type="button">arrow {id}</button></div>
                </section>
            ))}
        </div>
    );
}

beforeAll(() => {
    // A column of cards, each 100 px tall at the grid's left edge; the grid starts at the window's top.
    for (const name of ['offsetTop', 'offsetLeft', 'offsetWidth', 'offsetHeight'] as const) {
        Object.defineProperty(HTMLElement.prototype, name, {
            configurable: true,
            get(this: HTMLElement) {
                const top = Number(this.getAttribute('data-top'));
                return name === 'offsetTop' ? top : name === 'offsetWidth' ? 300 : name === 'offsetHeight' ? 100 : 0;
            },
        });
    }
    if (!('PointerEvent' in window)) {
        class FakePointerEvent extends MouseEvent {
            pointerId: number; isPrimary: boolean; pointerType: string;
            constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; this.isPrimary = init.isPrimary ?? true; this.pointerType = init.pointerType ?? 'mouse'; }
        }
        Object.defineProperty(window, 'PointerEvent', { configurable: true, value: FakePointerEvent });
    }
});
afterEach(() => { cleanup(); onDrop.mockReset(); });

const down = (id: string, y = 50) => fireEvent.pointerDown(screen.getByTestId(`card-band-${id}`), { pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, clientX: 20, clientY: y });
const move = (y: number, x = 20) => act(() => { fireEvent.pointerMove(window, { pointerId: 1, clientX: x, clientY: y }); });
const up = () => act(() => { fireEvent.pointerUp(window, { pointerId: 1 }); });

describe('dragging a band', () => {
    it('a press that never travels is a tap: nothing lifts, nothing drops', () => {
        render(<Grid />);
        down('c');
        move(52);
        up();
        expect(seen.lift).toBeNull();
        expect(onDrop).not.toHaveBeenCalled();
    });

    it('past the slop it lifts; the half of the card under the pointer decides; release drops there', () => {
        render(<Grid />);
        down('d', 350);
        move(330);
        expect(seen.lift).toEqual({ id: 'd', to: 3 });
        move(110); // the top half of b: before it
        expect(seen.lift).toEqual({ id: 'd', to: 1 });
        move(190); // the bottom half of b: after it
        expect(seen.lift).toEqual({ id: 'd', to: 2 });
        move(30); // the top half of a
        up();
        expect(onDrop).toHaveBeenCalledWith('d', 0);
        expect(seen.lift).toBeNull();
        expect(seen.ended).toBe(1);
    });

    it('a pointer between cards, or over the card itself, keeps the place; released where it began, nothing is saved', () => {
        render(<Grid />);
        down('b', 150);
        move(170);
        move(160); // still over b
        move(500); // past every card
        up();
        expect(onDrop).not.toHaveBeenCalled();
    });

    it('a press on a button in the band never starts a drag', () => {
        render(<Grid />);
        fireEvent.pointerDown(screen.getByText('arrow b'), { pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, clientX: 20, clientY: 150 });
        move(40);
        expect(seen.lift).toBeNull();
    });

    it('Escape puts the card back, saves nothing, and never reaches the Escape that ends Arrange', () => {
        render(<Grid />);
        const ends = vi.fn();
        document.addEventListener('keydown', ends);
        down('d', 350);
        move(330);
        move(30);
        expect(seen.lift).toEqual({ id: 'd', to: 0 });
        act(() => { fireEvent.keyDown(document.body, { key: 'Escape' }); });
        expect(seen.lift).toBeNull();
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
            down('d', 350);
            move(330);
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
        down('d', 350);
        move(330);
        expect(seen.lift).not.toBeNull();
        rerender(<Grid enabled={false} />);
        expect(seen.lift).toBeNull();
        up();
        expect(onDrop).not.toHaveBeenCalled();
    });
});
