/**
 * ListPhoto (card-photo-retry): a list card's picture draws the photo's small copy, then the photo's own URL, then the card's
 * fallback, each step once, never a broken image or an empty slot. The small cards that are not the Market card (Home, the
 * map's stacked list, the visitor card, the deals list, profile, chats) draw their picture through it.
 */
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIST_PHOTO_WAIT_MS } from '@beanpool/core';
import { ListPhoto } from './ListPhoto';

const PHOTO = '/api/marketplace/posts/p1/photos/0?v=17&k=KEY0';
const BANNER = '/api/shops/s1/photo?v=17&k=KEY0';
const fallback = <span data-testid="the-tile">tile</span>;

describe('ListPhoto', () => {
    it("draws the small copy, asks it once more past every cache, then the photo's own URL, then the fallback", () => {
        const { container, queryByTestId } = render(<ListPhoto photo={PHOTO} fallback={fallback} alt="Loaf" />);
        const img = () => container.querySelector('img[alt="Loaf"]');
        expect(img()?.getAttribute('src')).toBe(`${PHOTO}&size=thumb2`);
        fireEvent.error(img()!);
        expect(img()?.getAttribute('src')).toBe(`${PHOTO}&size=thumb2&retry=1`);
        fireEvent.error(img()!);
        expect(img()?.getAttribute('src')).toBe(PHOTO);
        fireEvent.error(img()!);
        expect(img()).toBeNull();
        expect(queryByTestId('the-tile')).toBeInTheDocument();
    });

    it('draws the fallback for no photo at all', () => {
        for (const photo of [null, undefined, '']) {
            const { container, queryByTestId, unmount } = render(<ListPhoto photo={photo} fallback={fallback} alt="" />);
            expect(container.querySelector('img')).toBeNull();
            expect(queryByTestId('the-tile')).toBeInTheDocument();
            unmount();
        }
    });

    it('a picture with no small copy (a banner) goes straight to the fallback on its first failure', () => {
        const { container, queryByTestId } = render(<ListPhoto photo={BANNER} fallback={fallback} alt="Shop" />);
        expect(container.querySelector('img')?.getAttribute('src')).toBe(BANNER);
        fireEvent.error(container.querySelector('img')!);
        expect(container.querySelector('img')).toBeNull();
        expect(queryByTestId('the-tile')).toBeInTheDocument();
    });

    it('does not loop, and a new URL the next read brings starts again from its small copy', () => {
        const { container, rerender, queryByTestId } = render(<ListPhoto photo={PHOTO} fallback={fallback} alt="" />);
        fireEvent.error(container.querySelector('img')!);
        fireEvent.error(container.querySelector('img')!);
        fireEvent.error(container.querySelector('img')!);
        rerender(<ListPhoto photo={PHOTO} fallback={fallback} alt="" />);
        expect(container.querySelector('img')).toBeNull();
        expect(queryByTestId('the-tile')).toBeInTheDocument();
        const NEW = '/api/marketplace/posts/p1/photos/0?v=18&k=KEY9';
        rerender(<ListPhoto photo={NEW} fallback={fallback} alt="" />);
        expect(container.querySelector('img')?.getAttribute('src')).toBe(`${NEW}&size=thumb2`);
        fireEvent.load(container.querySelector('img')!);
        expect(queryByTestId('the-tile')).toBeNull();
    });

    it('a resolve that refuses what it would draw (null) draws the fallback, never the refused URL, at every step', () => {
        const refuse = () => null;
        const { container, queryByTestId, unmount } = render(<ListPhoto photo={PHOTO} resolve={refuse} fallback={fallback} alt="" />);
        expect(container.querySelector('img')).toBeNull();
        expect(queryByTestId('the-tile')).toBeInTheDocument();
        unmount();
        // It refuses only the small copy: that is the first thing drawn, so the tile shows and the photo's own URL is not tried.
        const refuseSmall = (url: string) => (url.includes('size=thumb2') ? null : url);
        const second = render(<ListPhoto photo={PHOTO} resolve={refuseSmall} fallback={fallback} alt="" />);
        expect(second.container.querySelector('img')).toBeNull();
        expect(second.queryByTestId('the-tile')).toBeInTheDocument();
    });

    it('resolve turns what it draws into the address the page loads, while the steps follow the photo it was given', () => {
        const resolve = (url: string) => `https://node.example${url}`;
        const { container } = render(<ListPhoto photo={PHOTO} resolve={resolve} fallback={fallback} alt="" />);
        expect(container.querySelector('img')?.getAttribute('src')).toBe(`https://node.example${PHOTO}&size=thumb2`);
        fireEvent.error(container.querySelector('img')!);
        expect(container.querySelector('img')?.getAttribute('src')).toBe(`https://node.example${PHOTO}&size=thumb2&retry=1`);
        fireEvent.error(container.querySelector('img')!);
        expect(container.querySelector('img')?.getAttribute('src')).toBe(`https://node.example${PHOTO}`);
    });
});

// card-photo-blank (Marty, 4 Nov 2026): on global a card showed an empty slot, no photo and no tile, while its small copy
// was served fine; the picture sent neither load nor error. An <img> on the web has no limit on a load either.
describe('ListPhoto: never an empty slot while the photo loads', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('draws the fallback in the slot until the photo has loaded; the photo waits unseen, untappable and unread', () => {
        const { container, queryByTestId } = render(<ListPhoto photo={PHOTO} fallback={fallback} alt="Loaf" style={{ objectPosition: '50% 33%' }} />);
        const img = () => container.querySelector<HTMLImageElement>('img[alt="Loaf"]');
        expect(queryByTestId('the-tile')).toBeInTheDocument();
        expect(img()!.style.opacity).toBe('0');
        expect(img()!.style.position).toBe('absolute');
        expect(img()!.style.pointerEvents).toBe('none');
        expect(img()!.getAttribute('aria-hidden')).toBe('true');
        // It covers its containing block exactly, never more (review of #2853, finding 2): with the slot `relative`, that
        // block is the slot (ListPhoto.slots.test.ts).
        expect(img()!.style.top).toBe('0px');
        expect(img()!.style.left).toBe('0px');
        expect(img()!.style.width).toBe('100%');
        expect(img()!.style.height).toBe('100%');
        expect(img()!.style.margin).toBe('0px');
        fireEvent.load(img()!);
        expect(queryByTestId('the-tile')).toBeNull();
        expect(img()!.style.opacity).toBe('');
        expect(img()!.style.objectPosition).toBe('50% 33%');
        expect(img()!.getAttribute('aria-hidden')).toBeNull();
    });

    it('a photo that neither loads nor fails within LIST_PHOTO_WAIT_MS counts as failed and steps down, to the fallback at last', () => {
        vi.useFakeTimers();
        const { container, queryByTestId } = render(<ListPhoto photo={PHOTO} fallback={fallback} alt="" />);
        const src = () => container.querySelector('img')?.getAttribute('src');
        act(() => { vi.advanceTimersByTime(LIST_PHOTO_WAIT_MS - 1); });
        expect(src()).toBe(`${PHOTO}&size=thumb2`);
        act(() => { vi.advanceTimersByTime(1); });
        expect(src()).toBe(`${PHOTO}&size=thumb2&retry=1`);
        expect(queryByTestId('the-tile')).toBeInTheDocument();
        act(() => { vi.advanceTimersByTime(LIST_PHOTO_WAIT_MS); });
        expect(src()).toBe(PHOTO);
        act(() => { vi.advanceTimersByTime(LIST_PHOTO_WAIT_MS); });
        expect(container.querySelector('img')).toBeNull();
        expect(queryByTestId('the-tile')).toBeInTheDocument();
    });

    it('a photo that has loaded is never stepped down by the wait', () => {
        vi.useFakeTimers();
        const { container } = render(<ListPhoto photo={PHOTO} fallback={fallback} alt="" />);
        fireEvent.load(container.querySelector('img')!);
        act(() => { vi.advanceTimersByTime(LIST_PHOTO_WAIT_MS * 5); });
        expect(container.querySelector('img')?.getAttribute('src')).toBe(`${PHOTO}&size=thumb2`);
    });

    it('a URL resolve refuses is never waited past: the fallback stays and the photo is not asked for', () => {
        vi.useFakeTimers();
        const refuseSmall = (url: string) => (url.includes('size=thumb2') ? null : url);
        const { container, queryByTestId } = render(<ListPhoto photo={PHOTO} resolve={refuseSmall} fallback={fallback} alt="" />);
        act(() => { vi.advanceTimersByTime(LIST_PHOTO_WAIT_MS * 3); });
        expect(container.querySelector('img')).toBeNull();
        expect(queryByTestId('the-tile')).toBeInTheDocument();
    });
});

// Review of #2853, finding 1: the browser does not ask for a `loading="lazy"` <img> that is off screen, so neither load nor
// error comes; a wait that started at mount stepped MapStackList's and Home's later photos down to their fallback before
// they were ever fetched, and they never loaded. jsdom has no IntersectionObserver; this one is driven by the test.
describe('ListPhoto: a lazy photo off screen is never stepped down until it is in view', () => {
    let observers: Array<{ cb: IntersectionObserverCallback; el: Element | null }> = [];
    beforeEach(() => {
        observers = [];
        vi.stubGlobal('IntersectionObserver', class {
            cb: IntersectionObserverCallback;
            el: Element | null = null;
            constructor(cb: IntersectionObserverCallback) { this.cb = cb; observers.push(this); }
            observe(el: Element) { this.el = el; }
            unobserve() { this.el = null; }
            disconnect() { this.el = null; }
            takeRecords() { return []; }
        });
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
    const inView = (on: boolean) => act(() => {
        for (const o of observers) if (o.el) o.cb([{ isIntersecting: on, target: o.el } as IntersectionObserverEntry], o as unknown as IntersectionObserver);
    });
    const after = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

    it('waits nothing while it is out of view, then LIST_PHOTO_WAIT_MS once it is in view', () => {
        vi.useFakeTimers();
        const { container, queryByTestId } = render(<ListPhoto photo={PHOTO} fallback={fallback} alt="" loading="lazy" />);
        const src = () => container.querySelector('img')?.getAttribute('src');
        inView(false);
        after(LIST_PHOTO_WAIT_MS * 10);
        expect(src()).toBe(`${PHOTO}&size=thumb2`);
        expect(queryByTestId('the-tile')).toBeInTheDocument();
        inView(true);
        after(LIST_PHOTO_WAIT_MS - 1);
        expect(src()).toBe(`${PHOTO}&size=thumb2`);
        after(1);
        expect(src()).toBe(`${PHOTO}&size=thumb2&retry=1`);
        expect(queryByTestId('the-tile')).toBeInTheDocument();
    });

    it('a photo asked for keeps its wait when it leaves the view; a step down out of view waits for it to come back', () => {
        vi.useFakeTimers();
        const { container } = render(<ListPhoto photo={PHOTO} fallback={fallback} alt="" loading="lazy" />);
        const src = () => container.querySelector('img')?.getAttribute('src');
        inView(true);
        after(1000);
        inView(false);
        after(LIST_PHOTO_WAIT_MS - 1000);
        expect(src()).toBe(`${PHOTO}&size=thumb2&retry=1`);
        after(LIST_PHOTO_WAIT_MS * 5);
        expect(src()).toBe(`${PHOTO}&size=thumb2&retry=1`);
        inView(true);
        after(LIST_PHOTO_WAIT_MS);
        expect(src()).toBe(PHOTO);
    });

    it('a step down while it is in view is waited on at once', () => {
        vi.useFakeTimers();
        const { container } = render(<ListPhoto photo={PHOTO} fallback={fallback} alt="" loading="lazy" />);
        const src = () => container.querySelector('img')?.getAttribute('src');
        inView(true);
        fireEvent.error(container.querySelector('img')!);
        expect(src()).toBe(`${PHOTO}&size=thumb2&retry=1`);
        after(LIST_PHOTO_WAIT_MS);
        expect(src()).toBe(PHOTO);
    });

    it('a new <img> is out of view until its own observer says so (a card that gave up in view, then a new URL off screen)', () => {
        vi.useFakeTimers();
        const PHOTO_2 = '/api/marketplace/posts/p1/photos/0?v=18&k=KEY9';
        const { container, rerender } = render(<ListPhoto photo={PHOTO} fallback={fallback} alt="" loading="lazy" />);
        inView(true);
        for (let i = 0; i < 3; i++) fireEvent.error(container.querySelector('img')!);
        expect(container.querySelector('img')).toBeNull();
        rerender(<ListPhoto photo={PHOTO_2} fallback={fallback} alt="" loading="lazy" />);
        after(LIST_PHOTO_WAIT_MS * 3);
        expect(container.querySelector('img')?.getAttribute('src')).toBe(`${PHOTO_2}&size=thumb2`);
        inView(true);
        after(LIST_PHOTO_WAIT_MS);
        expect(container.querySelector('img')?.getAttribute('src')).toBe(`${PHOTO_2}&size=thumb2&retry=1`);
    });

    it('an eager photo is not watched: the browser asks for it at once, so its wait starts at once', () => {
        vi.useFakeTimers();
        const { container } = render(<ListPhoto photo={PHOTO} fallback={fallback} alt="" />);
        expect(observers).toHaveLength(0);
        after(LIST_PHOTO_WAIT_MS);
        expect(container.querySelector('img')?.getAttribute('src')).toBe(`${PHOTO}&size=thumb2&retry=1`);
    });
});
