/**
 * The report card in the member's language (words S3, web sweep W1): in the pseudo-locale every word on it came through
 * t(), the reasons included, while what it SENDS stays the English the node reads (services/alerts.ts reads "Child
 * safety" from the reason as picked). The reported member's name is theirs, shown as written.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReportModal } from './ReportModal';
import { reportAbuse } from '../lib/api';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-xx.test-support';

vi.mock('../lib/api', () => ({ reportAbuse: vi.fn().mockResolvedValue({ success: true }) }));

const props = { isOpen: true, onClose: () => {}, reporterPubkey: 'pubkey_123', targetPubkey: 'target_456', targetName: 'Alice', targetPostId: 'post_9' };

afterEach(() => { cleanup(); backToEnglish(); });

describe('the report card in the pseudo-locale', () => {
    it('every word came through t(); the reasons are shown translated and sent in English', async () => {
        await showIn('xx');
        render(<ReportModal {...props} />);
        expect(bracketed()).toBeGreaterThan(8);
        expect(bypassing(document.body, { others: ['Alice'] })).toEqual([]);
        expect(screen.getByRole('heading').textContent).toContain(xx('Report {name}').replace('{name}', 'Alice'));

        fireEvent.click(screen.getByRole('button', { name: xx('Child safety') }));
        expect(screen.getByRole('button', { pressed: true }).textContent).toBe(xx('✓ {reason}').replace('{reason}', xx('Child safety')));
        fireEvent.click(screen.getByRole('button', { name: xx('Submit Report') }));
        await waitFor(() => expect(reportAbuse).toHaveBeenCalledWith('pubkey_123', 'target_456', 'Child safety', 'post_9', undefined));
        expect(await screen.findByTestId('report-sent')).toBeInTheDocument();
        expect(bypassing(document.body, { others: ['Alice'] })).toEqual([]);
    });

    it('a failed send: the card\'s own sentence through t(), a node\'s refusal as the node wrote it', async () => {
        await showIn('xx');
        vi.mocked(reportAbuse).mockRejectedValueOnce(new Error(''));
        render(<ReportModal {...props} />);
        fireEvent.click(screen.getByRole('button', { name: xx('Spam or scam') }));
        fireEvent.click(screen.getByRole('button', { name: xx('Submit Report') }));
        expect(await screen.findByText(xx('Failed to submit report. Please try again.'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: ['Alice'] })).toEqual([]);
    });

    it('in English nothing is bracketed, and the words are as they were', () => {
        render(<ReportModal {...props} />);
        expect(bracketed()).toBe(0);
        expect(screen.getByRole('heading').textContent).toBe('🚩 Report Alice');
        expect(screen.getByText('Child safety', { selector: 'span' }).closest('p')!.textContent).toBe('Child safety: A child at risk, or sexual content involving a minor.');
        expect(screen.getByPlaceholderText('Provide any additional context or comments for moderators...')).toBeInTheDocument();
    });
});
