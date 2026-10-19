/**
 * The preview of a post before it goes to the Pulse, in the member's language (words S3, web sweep W1): its own words
 * through t(), the phone's keys. The post's title, its link and the member's name are theirs; a platform's brand reads
 * as written in every language.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PulsePreviewCard, type PulsePreviewData } from './PulsePreviewCard';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-xx.test-support';

const preview: PulsePreviewData = {
    url: 'https://instagram.com/p/abc123/',
    title: 'Saving tomato seed',
    thumbnailUrl: null,
    platform: 'instagram',
    category: 'food',
    isDuplicate: true,
    authorCallsign: 'GreenThumb',
    isVerified: true,
};

/**
 * What the member wrote and linked, and the platform's brand name, shown as written; and the one emoji Unicode counts
 * as a letter (ℹ, the information sign: the phone's pulse-words-render test takes it out the same way).
 */
const OTHERS = ['Saving tomato seed', 'https://instagram.com/p/abc123/', 'GreenThumb', 'Instagram', 'ℹ️'];

afterEach(() => { cleanup(); backToEnglish(); });

describe('the Pulse preview in the pseudo-locale', () => {
    it('every word came through t(), the review toggle and the already-published line included', async () => {
        await showIn('xx');
        const { rerender } = render(<PulsePreviewCard preview={preview} showReviewToggle onToggleOptIn={vi.fn()} />);
        expect(bracketed()).toBeGreaterThan(3);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        expect(screen.getByText(xx('Will be shared with your local community'))).toBeInTheDocument();

        rerender(<PulsePreviewCard preview={{ ...preview, title: null, authorCallsign: undefined, isDuplicate: false }} isOptedIn={false} showReviewToggle onToggleOptIn={vi.fn()} />);
        expect(screen.getByText(xx('Untitled Post'))).toBeInTheDocument();
        expect(screen.getByText(xx('Excluded from this publish'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
    });
});

describe('the Pulse preview in English', () => {
    it('in English nothing is bracketed, and the words are as they were', () => {
        render(<PulsePreviewCard preview={preview} showReviewToggle onToggleOptIn={vi.fn()} />);
        expect(bracketed()).toBe(0);
        expect(screen.getByRole('region').getAttribute('aria-label')).toBe('Preview of Instagram post: Saving tomato seed');
        expect(screen.getByText('Already published to Pulse. Submitting will update the title or category.')).toBeInTheDocument();
        expect(screen.getByText('Food & growing')).toBeInTheDocument();
        expect(screen.getByLabelText('Publish to Pulse')).toBeInTheDocument();
        expect(screen.getByTitle('Verified creator')).toBeInTheDocument();
    });
});
