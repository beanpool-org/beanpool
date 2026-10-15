import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { ReportModal } from './ReportModal';
import { reportAbuse } from '../lib/api';

vi.mock('../lib/api', () => ({
    reportAbuse: vi.fn().mockResolvedValue({ success: true }),
}));

const props = { isOpen: true, onClose: () => {}, reporterPubkey: 'pubkey_123', targetPubkey: 'target_456', targetName: 'Alice', targetPostId: 'post_9' };

describe('ReportModal Component', () => {
    it('renders with modal ARIA attributes, decorative emoji hidden, and accessible buttons', () => {
        const handleClose = vi.fn();
        render(
            <ReportModal
                isOpen={true}
                onClose={handleClose}
                reporterPubkey="pubkey_123"
                targetPubkey="target_456"
                targetName="Alice"
            />
        );

        const dialog = screen.getByRole('dialog');
        expect(dialog).toBeInTheDocument();
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog).toHaveAttribute('aria-labelledby', 'report-modal-title');

        const title = screen.getByText(/Report Alice/i);
        expect(title).toBeInTheDocument();

        const closeBtn = screen.getByRole('button', { name: /Close report dialog/i });
        expect(closeBtn).toBeInTheDocument();

        // Every reason is a toggle, and none is picked until the member chooses (review of #1912: "Spam or scam" was).
        expect(screen.getAllByRole('button', { pressed: false }).map((b) => b.textContent)).toEqual(['Spam or scam', 'Offensive content', 'Misleading post', 'Child safety', 'Other']);
        expect(screen.queryAllByRole('button', { pressed: true })).toEqual([]);
    });

    it('opens with no reason picked and Submit off; choosing one turns Submit on, and nothing is sent before that', async () => {
        vi.mocked(reportAbuse).mockClear();
        render(<ReportModal {...props} />);
        const submit = screen.getByRole('button', { name: /Submit Report/i });
        expect(submit).toBeDisabled();
        // Off looks off, from the theme's roles: no red fill until there is something to send.
        expect(submit.className).toMatch(/(^| )bg-bg-hover( |$)/);
        expect(submit.className).toMatch(/(^| )text-text-muted( |$)/);
        expect(submit.className).not.toMatch(/bg-bp-danger-fill/);
        fireEvent.click(submit);
        fireEvent.change(screen.getByLabelText(/Additional details/i), { target: { value: 'words but no reason' } });
        expect(submit).toBeDisabled();
        expect(reportAbuse).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: /^Spam or scam$/ }));
        expect(submit).toBeEnabled();
        expect(submit.className).toMatch(/(^| )bg-bp-danger-fill( |$)/);
        fireEvent.click(submit);
        await waitFor(() => expect(reportAbuse).toHaveBeenCalledWith('pubkey_123', 'target_456', 'Spam or scam: words but no reason', 'post_9', undefined));
    });

    it('a failed send says why and keeps the choice and the words; the next try sends them (review of #1912, finding 3)', async () => {
        vi.spyOn(window, 'alert').mockImplementation(() => {});
        const onClose = vi.fn();
        vi.mocked(reportAbuse).mockClear();
        vi.mocked(reportAbuse).mockRejectedValueOnce(new Error('Could not reach the node.'));
        render(<ReportModal {...props} onClose={onClose} />);
        fireEvent.click(screen.getByRole('button', { name: /^Child safety$/ }));
        fireEvent.change(screen.getByLabelText(/Additional details/i), { target: { value: 'he asked my son for photos' } });
        fireEvent.click(screen.getByRole('button', { name: /Submit Report/i }));
        expect(await screen.findByText('Could not reach the node.')).toBeInTheDocument();
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: /Child safety$/ })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByLabelText(/Additional details/i)).toHaveValue('he asked my son for photos');
        expect(screen.getByRole('button', { name: /Submit Report/i })).toBeEnabled();
        fireEvent.click(screen.getByRole('button', { name: /Submit Report/i }));
        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(vi.mocked(reportAbuse).mock.calls.map((c) => c[2])).toEqual(['Child safety: he asked my son for photos', 'Child safety: he asked my son for photos']);
    });

    it('toggles reason selection and updates aria-pressed states', () => {
        render(
            <ReportModal
                isOpen={true}
                onClose={() => {}}
                reporterPubkey="pubkey_123"
                targetPubkey="target_456"
                targetName="Alice"
            />
        );

        const spamBtn = screen.getByRole('button', { name: /Spam or scam/i });
        const offensiveBtn = screen.getByRole('button', { name: /Offensive content/i });

        expect(spamBtn).toHaveAttribute('aria-pressed', 'false');
        expect(offensiveBtn).toHaveAttribute('aria-pressed', 'false');

        fireEvent.click(spamBtn);
        expect(spamBtn).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(offensiveBtn);

        expect(spamBtn).toHaveAttribute('aria-pressed', 'false');
        expect(offensiveBtn).toHaveAttribute('aria-pressed', 'true');
    });

    it('offers "Child safety" with its one-line hint, and sends it as picked (the server reads it from there)', async () => {
        vi.spyOn(window, 'alert').mockImplementation(() => {});
        vi.mocked(reportAbuse).mockClear();
        const { unmount } = render(<ReportModal {...props} />);
        expect(screen.getByText(/A child at risk, or sexual content involving a minor\./)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /^Child safety$/ }));
        fireEvent.click(screen.getByRole('button', { name: /Submit Report/i }));
        await waitFor(() => expect(reportAbuse).toHaveBeenCalledWith('pubkey_123', 'target_456', 'Child safety', 'post_9', undefined));
        unmount();

        vi.mocked(reportAbuse).mockClear();
        render(<ReportModal {...props} />);
        fireEvent.click(screen.getByRole('button', { name: /^Child safety$/ }));
        fireEvent.change(screen.getByLabelText(/Additional details/i), { target: { value: 'messages to my daughter' } });
        fireEvent.click(screen.getByRole('button', { name: /Submit Report/i }));
        await waitFor(() => expect(reportAbuse).toHaveBeenCalledWith('pubkey_123', 'target_456', 'Child safety: messages to my daughter', 'post_9', undefined));
    });

    it('keeps Cancel and Submit at the foot of the card while it scrolls, in light and dark (review of #1895, finding 6)', () => {
        render(<ReportModal isOpen onClose={() => {}} reporterPubkey="a" targetPubkey="b" targetName="Bob" />);
        const row = screen.getByTestId('report-actions');
        expect(within(row).getByRole('button', { name: 'Submit Report' })).toBeInTheDocument();
        expect(within(row).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
        // Sticky to the bottom of the scrolling card, with a solid background in each theme so the fields slide under it.
        expect(row.className).toMatch(/(^| )sticky( |$)/);
        // Its bottom edge is the card's outer edge, not the padding's: with bottom-0 it stopped one card padding short,
        // and fields scrolled through the strip below the buttons (review of #1912, finding 1).
        expect(row.className).toMatch(/(^| )-bottom-5( |$)/);
        expect(row.className).toMatch(/(^| )sm:-bottom-6( |$)/);
        expect(row.className).not.toMatch(/(^| )bottom-0( |$)/);
        expect(row.className).toMatch(/(^| )bg-white( |$)/);
        expect(row.className).toMatch(/(^| )dark:bg-nature-900( |$)/);
        // It is the last thing in the card that scrolls.
        const card = row.parentElement!;
        expect(card.className).toMatch(/overflow-y-auto/);
        // A focused field scrolls clear of the row, not under it.
        expect(card.className).toMatch(/(^| )scroll-pb-24( |$)/);
        expect(card.lastElementChild).toBe(row);
    });
});
