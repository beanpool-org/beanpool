/**
 * ListPhoto (card-photo-retry): a list card's picture draws the photo's small copy, then the photo's own URL, then the card's
 * fallback, each step once, never a broken image or an empty slot. The small cards that are not the Market card (Home, the
 * map's stacked list, the visitor card, the deals list, profile, chats) draw their picture through it.
 */
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ListPhoto } from './ListPhoto';

const PHOTO = '/api/marketplace/posts/p1/photos/0?v=17&k=KEY0';
const BANNER = '/api/shops/s1/photo?v=17&k=KEY0';
const fallback = <span data-testid="the-tile">tile</span>;

describe('ListPhoto', () => {
    it('draws the small copy, then the photo\'s own URL, then the fallback', () => {
        const { container, queryByTestId } = render(<ListPhoto photo={PHOTO} fallback={fallback} alt="Loaf" />);
        const img = () => container.querySelector('img[alt="Loaf"]');
        expect(img()?.getAttribute('src')).toBe(`${PHOTO}&size=thumb2`);
        fireEvent.error(img()!);
        expect(img()?.getAttribute('src')).toBe(PHOTO);
        expect(queryByTestId('the-tile')).toBeNull();
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
        rerender(<ListPhoto photo={PHOTO} fallback={fallback} alt="" />);
        expect(container.querySelector('img')).toBeNull();
        expect(queryByTestId('the-tile')).toBeInTheDocument();
        const NEW = '/api/marketplace/posts/p1/photos/0?v=18&k=KEY9';
        rerender(<ListPhoto photo={NEW} fallback={fallback} alt="" />);
        expect(container.querySelector('img')?.getAttribute('src')).toBe(`${NEW}&size=thumb2`);
        expect(queryByTestId('the-tile')).toBeNull();
    });

    it('resolve turns what it draws into the address the page loads, while the steps follow the photo it was given', () => {
        const resolve = (url: string) => `https://node.example${url}`;
        const { container } = render(<ListPhoto photo={PHOTO} resolve={resolve} fallback={fallback} alt="" />);
        expect(container.querySelector('img')?.getAttribute('src')).toBe(`https://node.example${PHOTO}&size=thumb2`);
        fireEvent.error(container.querySelector('img')!);
        expect(container.querySelector('img')?.getAttribute('src')).toBe(`https://node.example${PHOTO}`);
    });
});
