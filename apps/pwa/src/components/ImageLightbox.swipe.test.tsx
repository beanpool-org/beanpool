/**
 * A post's photos full size on the web (Marty, 26 Nov 2026: "once she clicked on the larger photo view she was unable to scroll
 * through the photos at this level"). ImageLightbox opens at the photo tapped, a one-finger swipe turns to the next or the
 * previous, and a two-finger pinch (the browser's zoom) never turns the photo, however it drifts. One photo: no count, and a
 * swipe does nothing. The listing's page hands it all of the post's photos and the tapped one's place (MarketplacePage
 * openPhoto), as Local knowledge (LearnPage) and the event page do.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImageLightbox } from './ImageLightbox';

const PHOTOS = ['/api/marketplace/posts/p1/photos/0?v=1', '/api/marketplace/posts/p1/photos/1?v=1', '/api/marketplace/posts/p1/photos/2?v=1'];

const surface = () => screen.getByRole('img').parentElement as HTMLElement;
const touch = (x: number, y = 100) => ({ clientX: x, clientY: y });
function swipe(from: number, to: number) {
    const el = surface();
    fireEvent.touchStart(el, { touches: [touch(from)] });
    fireEvent.touchMove(el, { touches: [touch(to)] });
    fireEvent.touchEnd(el, { touches: [] });
}

describe('ImageLightbox: swipe through a post\'s photos', () => {
    it('opens at the photo tapped', () => {
        render(<ImageLightbox isOpen photos={PHOTOS} initialIndex={2} title="Sourdough" onClose={vi.fn()} />);
        expect(screen.getByText('3 / 3')).toBeInTheDocument();
        expect(screen.getByRole('img').getAttribute('src')).toContain('/photos/2');
    });

    it('a swipe left shows the next, a swipe right the previous: 1 -> 2 -> 3 -> 2 -> 1', () => {
        render(<ImageLightbox isOpen photos={PHOTOS} initialIndex={0} onClose={vi.fn()} />);
        const seen: string[] = [];
        for (const [from, to] of [[300, 100], [300, 100], [100, 300], [100, 300]]) {
            swipe(from, to);
            seen.push(screen.getByText(/^\d \/ 3$/).textContent ?? '');
        }
        expect(seen).toEqual(['2 / 3', '3 / 3', '2 / 3', '1 / 3']);
    });

    it('a short or mostly vertical drag is no swipe', () => {
        render(<ImageLightbox isOpen photos={PHOTOS} initialIndex={1} onClose={vi.fn()} />);
        swipe(200, 180);
        expect(screen.getByText('2 / 3')).toBeInTheDocument();
        const el = surface();
        fireEvent.touchStart(el, { touches: [touch(200, 100)] });
        fireEvent.touchMove(el, { touches: [touch(150, 300)] });
        fireEvent.touchEnd(el, { touches: [] });
        expect(screen.getByText('2 / 3')).toBeInTheDocument();
    });

    it('a two-finger pinch that drifts sideways never turns the photo', () => {
        render(<ImageLightbox isOpen photos={PHOTOS} initialIndex={1} onClose={vi.fn()} />);
        const el = surface();
        // Both fingers down at once.
        fireEvent.touchStart(el, { touches: [touch(200), touch(260)] });
        fireEvent.touchMove(el, { touches: [touch(40), touch(300)] });
        fireEvent.touchEnd(el, { touches: [] });
        expect(screen.getByText('2 / 3')).toBeInTheDocument();
        // One finger first, then a second joins: a pinch from then on.
        fireEvent.touchStart(el, { touches: [touch(250)] });
        fireEvent.touchMove(el, { touches: [touch(240), touch(300)] });
        fireEvent.touchMove(el, { touches: [touch(40), touch(300)] });
        fireEvent.touchEnd(el, { touches: [] });
        expect(screen.getByText('2 / 3')).toBeInTheDocument();
        // And a plain swipe still works after.
        swipe(300, 100);
        expect(screen.getByText('3 / 3')).toBeInTheDocument();
    });

    it('one photo: no count, no arrows, and a swipe does nothing', () => {
        render(<ImageLightbox isOpen photos={[PHOTOS[0]]} initialIndex={0} onClose={vi.fn()} />);
        expect(screen.queryByText(/\d \/ \d/)).toBeNull();
        expect(screen.queryByRole('button', { name: 'Next photo' })).toBeNull();
        swipe(300, 100);
        expect(screen.getByRole('img').getAttribute('src')).toContain('/photos/0');
    });
});

describe('the pages that show a post\'s photos open the lightbox with all of them', () => {
    const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const source = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8');

    it('the listing\'s page: every photo, at the one tapped', () => {
        const src = source('pages/MarketplacePage.tsx');
        expect(src).toMatch(/setLightboxState\(\{ isOpen: true, photos, initialIndex: i,/);
        expect(src).toMatch(/photos=\{lightboxState\.photos\}\s+initialIndex=\{lightboxState\.initialIndex\}/);
    });

    it('Local knowledge: every photo, at the one tapped', () => {
        expect(source('pages/LearnPage.tsx')).toMatch(/photos=\{photo\.photos\}\s+initialIndex=\{photo\.index\}/);
    });

    it('an event: every photo it holds', () => {
        expect(source('components/EventCard.tsx')).toMatch(/<ImageLightbox\s+isOpen\s+photos=\{photos\}/);
    });
});
