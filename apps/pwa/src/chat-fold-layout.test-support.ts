/**
 * Tests only: a model of the browser layout a long chat message's fold measures (components/FoldedChatText.tsx), since jsdom
 * has none. A clamped box shows no more than twelve lines and its scrollHeight is all of them; a line is 20 px and holds
 * `box.cpl` characters; the bubble around it is `box.width` wide. `moveBubble` is the ResizeObserver telling the words the
 * bubble changed width.
 */
import { vi } from 'vitest';
import { act } from '@testing-library/react';

export const LINE = 20;
export const box = { cpl: 32, width: 300 };

const linesOf = (text: string) => text.split('\n').reduce((n, p) => n + Math.max(1, Math.ceil(p.length / box.cpl)), 0);
const isFoldBox = (el: HTMLElement) => el.dataset.testid === 'chat-text';
const isClamped = (el: HTMLElement) => el.dataset.fold === 'measuring' || el.dataset.fold === 'folded';

let watchers: (() => void)[] = [];

export function installFoldLayout(): void {
    box.cpl = 32;
    box.width = 300;
    watchers = [];
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get(this: HTMLElement) { return isFoldBox(this) ? linesOf(this.textContent ?? '') * LINE : 0; } });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
        configurable: true,
        get(this: HTMLElement) {
            if (!isFoldBox(this)) return 0;
            const lines = linesOf(this.textContent ?? '');
            return (isClamped(this) ? Math.min(lines, 12) : lines) * LINE;
        },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return box.width; } });
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { watchers.push(cb); } observe() { } disconnect() { } });
}

export function removeFoldLayout(): void {
    vi.unstubAllGlobals();
    delete (HTMLElement.prototype as any).scrollHeight;
    delete (HTMLElement.prototype as any).clientHeight;
    delete (HTMLElement.prototype as any).clientWidth;
}

/** The bubble becomes `width` wide and holds `cpl` characters a line; every observer is told. */
export function moveBubble(width: number, cpl: number): void {
    box.width = width;
    box.cpl = cpl;
    act(() => { watchers.forEach((w) => w()); });
}
