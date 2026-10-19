/**
 * The photo viewer in the member's language (words S3, web sweep W1): in the pseudo-locale every word it draws or reads
 * out came through t(): the controls, the counter dots, the loading and failed states, the photo's alt text. The title
 * (a listing's or a member's name) is theirs, shown as written inside the sentences.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ImageLightbox } from './ImageLightbox';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-xx.test-support';

const PHOTOS = ['/api/marketplace/posts/p1/photos/0?v=1', '/api/marketplace/posts/p1/photos/1?v=1', '/api/marketplace/posts/p1/photos/2?v=1'];
const TITLE = 'Fresh Organic Carrots';
const SUBTITLE = 'Kofi';
const others = [TITLE, SUBTITLE];

afterEach(() => { cleanup(); backToEnglish(); });

describe('the photo viewer in the pseudo-locale', () => {
    it('several photos: loading, failed and loaded, every word through t()', async () => {
        await showIn('xx');
        render(<ImageLightbox isOpen photos={PHOTOS} title={TITLE} subtitle={SUBTITLE} onClose={() => {}} />);

        // Loading: the spinner's words, the controls, the dots, the alt text.
        expect(screen.getByRole('status', { name: xx('Loading photo') })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('Next photo') })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('Go to photo {n} of {count}').replace('{n}', '2').replace('{count}', '3') })).toBeInTheDocument();
        expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe(xx('Photo viewer: {title}').replace('{title}', TITLE));
        const img = screen.getByRole('img');
        expect(img.getAttribute('alt')).toBe(xx('{title} - Photo {n} of {count}').replace('{title}', TITLE).replace('{n}', '1').replace('{count}', '3'));
        expect(bracketed()).toBeGreaterThan(0);
        expect(bypassing(document.body, { others })).toEqual([]);

        // Failed: the fallback card.
        fireEvent.error(img);
        expect(await screen.findByText(xx('Photo failed to load'))).toBeInTheDocument();
        expect(bracketed()).toBeGreaterThan(2);
        expect(bypassing(document.body, { others })).toEqual([]);

        // Retry, then loaded: the title and subtitle bar (theirs).
        fireEvent.click(screen.getByRole('button', { name: xx('Retry') }));
        fireEvent.load(screen.getByRole('img'));
        expect(screen.getByText(SUBTITLE)).toBeInTheDocument();
        expect(bypassing(document.body, { others })).toEqual([]);
    });

    it('one photo with no title: the plain alt text and viewer name', async () => {
        await showIn('xx');
        render(<ImageLightbox isOpen photos={[PHOTOS[0]]} onClose={() => {}} />);
        expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe(xx('Photo viewer'));
        expect(screen.getByRole('img').getAttribute('alt')).toBe(xx('Photo {n} of {count}').replace('{n}', '1').replace('{count}', '1'));
        expect(bypassing(document.body)).toEqual([]);
    });

    it('in English nothing is bracketed, and the words are as they were', () => {
        render(<ImageLightbox isOpen photos={PHOTOS} title={TITLE} onClose={() => {}} />);
        expect(bracketed()).toBe(0);
        expect(screen.getByRole('dialog', { name: 'Photo viewer: Fresh Organic Carrots' })).toBeInTheDocument();
        expect(screen.getByAltText('Fresh Organic Carrots - Photo 1 of 3')).toBeInTheDocument();
        expect(screen.getByText('Loading photo…')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Go to photo 3 of 3' })).toBeInTheDocument();
        fireEvent.error(screen.getByRole('img'));
        expect(screen.getByText('The image could not be displayed or network connection is slow.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });
});
