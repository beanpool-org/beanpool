import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { SubTabStrip } from './SubTabStrip';

describe('SubTabStrip Component', () => {
    it('renders children elements correctly', () => {
        render(
            <SubTabStrip wrap={false}>
                <button>Tab 1</button>
                <button>Tab 2</button>
            </SubTabStrip>
        );

        expect(screen.getByRole('button', { name: 'Tab 1' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Tab 2' })).toBeInTheDocument();
    });

    it('applies lg:flex-wrap class when wrap is true and omits it when wrap is false', () => {
        const { container, rerender } = render(
            <SubTabStrip wrap={true}>
                <button>Tab 1</button>
            </SubTabStrip>
        );

        const stripDiv = container.firstElementChild as HTMLElement;
        expect(stripDiv.className).toContain('lg:flex-wrap');

        rerender(
            <SubTabStrip wrap={false}>
                <button>Tab 1</button>
            </SubTabStrip>
        );

        expect(stripDiv.className).not.toContain('lg:flex-wrap');
    });

    it('scrolls active tab into view when active sub-tab is out of bounds and scrollWidth > clientWidth', () => {
        const { container, rerender } = render(
            <SubTabStrip wrap={false}>
                <button>Tab 1</button>
                <button aria-current="page">Active Tab</button>
            </SubTabStrip>
        );

        const stripDiv = container.firstElementChild as HTMLDivElement;
        const activeTab = screen.getByRole('button', { name: 'Active Tab' });

        Object.defineProperty(stripDiv, 'scrollWidth', { value: 500, configurable: true });
        Object.defineProperty(stripDiv, 'clientWidth', { value: 300, configurable: true });
        let scrollLeftVal = 0;
        Object.defineProperty(stripDiv, 'scrollLeft', {
            get: () => scrollLeftVal,
            set: (v) => {
                scrollLeftVal = v;
            },
            configurable: true,
        });

        vi.spyOn(stripDiv, 'getBoundingClientRect').mockReturnValue({
            left: 0,
            right: 300,
            top: 0,
            bottom: 50,
            width: 300,
            height: 50,
            x: 0,
            y: 0,
            toJSON: () => {},
        });

        vi.spyOn(activeTab, 'getBoundingClientRect').mockReturnValue({
            left: 350,
            right: 450,
            top: 0,
            bottom: 50,
            width: 100,
            height: 50,
            x: 350,
            y: 0,
            toJSON: () => {},
        });

        // Trigger rerender with new tab content to force layout effect
        rerender(
            <SubTabStrip wrap={false}>
                <button>Tab 1</button>
                <button aria-current="page">Active Tab Updated</button>
            </SubTabStrip>
        );

        expect(scrollLeftVal).toBe(334);
    });

    it('does not scroll when scrollWidth <= clientWidth', () => {
        const { container, rerender } = render(
            <SubTabStrip wrap={false}>
                <button aria-current="page">Active Tab</button>
            </SubTabStrip>
        );

        const stripDiv = container.firstElementChild as HTMLDivElement;
        let scrollLeftVal = 0;
        Object.defineProperty(stripDiv, 'scrollLeft', {
            get: () => scrollLeftVal,
            set: (v) => {
                scrollLeftVal = v;
            },
            configurable: true,
        });

        Object.defineProperty(stripDiv, 'scrollWidth', { value: 200, configurable: true });
        Object.defineProperty(stripDiv, 'clientWidth', { value: 300, configurable: true });

        rerender(
            <SubTabStrip wrap={false}>
                <button aria-current="page">Active Tab Updated</button>
            </SubTabStrip>
        );

        expect(scrollLeftVal).toBe(0);
    });

    /**
     * The layout effect only ever sees React renders, and a render is not the only thing that moves these
     * buttons: the web font landing, a label gaining a count, or the phone's text size changing all re-lay the
     * strip out on their own. Measured on #1063 at 320px — a hand-off link to Proposals left the strip
     * unscrolled because the tab really did fit in the fallback font, the real font then widened every label and
     * pushed the active tab past the right edge, and it stayed there because nothing rendered again.
     */
    describe('a re-layout that is not a render', () => {
        let fire: (() => void) | null = null;
        const realRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;

        beforeEach(() => {
            fire = null;
            (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
                constructor(cb: () => void) { fire = cb; }
                observe() {}
                disconnect() {}
            };
        });
        afterEach(() => {
            (globalThis as { ResizeObserver?: unknown }).ResizeObserver = realRO;
        });

        /** A strip whose active tab starts comfortably inside it, with `scrollLeft` readable and writable. */
        function mount() {
            const { container } = render(
                <SubTabStrip wrap={false}>
                    <button>Tab 1</button>
                    <button aria-current="page">Active Tab</button>
                </SubTabStrip>
            );
            const strip = container.firstElementChild as HTMLDivElement;
            const active = screen.getByRole('button', { name: 'Active Tab' });
            let scrollLeftVal = 0;
            Object.defineProperty(strip, 'scrollLeft', {
                get: () => scrollLeftVal, set: (v) => { scrollLeftVal = v; }, configurable: true,
            });
            Object.defineProperty(strip, 'clientWidth', { value: 300, configurable: true });
            const rect = (left: number, right: number) => ({
                left, right, top: 0, bottom: 50, width: right - left, height: 50, x: left, y: 0, toJSON: () => {},
            });
            vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue(rect(0, 300));
            return { strip, active, rect, at: () => scrollLeftVal };
        }

        it('scrolls the active tab back into view when the labels grow without a render', () => {
            const { strip, active, rect, at } = mount();
            // As first laid out: the strip overflows, but the active tab is inside it, so nothing scrolls.
            Object.defineProperty(strip, 'scrollWidth', { value: 500, configurable: true });
            vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(150, 250));
            fire!();
            expect(at()).toBe(0);

            // The font lands: every label widens and the active tab is pushed past the right edge. No render.
            Object.defineProperty(strip, 'scrollWidth', { value: 740, configurable: true });
            (active.getBoundingClientRect as unknown as { mockReturnValue: (r: unknown) => void }).mockReturnValue(rect(350, 450));
            fire!();

            expect(at()).toBe(334);
        });

        it('leaves a strip the owner scrolled by hand alone when nothing about it changed', () => {
            const { strip, active, rect, at } = mount();
            Object.defineProperty(strip, 'scrollWidth', { value: 500, configurable: true });
            vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(350, 450));
            fire!();
            expect(at()).toBe(334);

            // The owner scrolls the strip somewhere else. A resize that changes no metric must not snap it back.
            strip.scrollLeft = 12;
            fire!();
            fire!();

            expect(at()).toBe(12);
        });
    });
});
