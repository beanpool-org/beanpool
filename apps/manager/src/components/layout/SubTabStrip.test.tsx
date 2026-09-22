import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
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
});
