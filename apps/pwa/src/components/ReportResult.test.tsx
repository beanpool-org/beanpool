/**
 * What a report says once it is sent, and where a visitor can report (rehearsal 14 Oct N3). The modal and the Market's
 * inline form said "Report submitted" in a browser alert(); now the sentence is in place, only after the node took the
 * report, and a failed send says why there instead. A signed-out visitor has no report of their own (a report is a
 * member's, signed): the listing sheet says so and links the website's safety page. Nothing anonymous is sent.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ReportModal } from './ReportModal';
import { VisitorPostDetail } from './VisitorListing';
import { reportAbuse } from '../lib/api';
import { REPORT_WORDS, VISITOR_REPORT_URL } from '../lib/reportReasons';

const REPORT_SENT = REPORT_WORDS.sent;
import type { MarketplacePost } from '../lib/api';

vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), reportAbuse: vi.fn() }));

const props = { isOpen: true, reporterPubkey: 'me', targetPubkey: 'them', targetName: 'Alice', targetPostId: 'post_9' };

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the report modal says what became of the report, in the card', () => {
    it('sent: the sentence, no alert, and the caller hears of it as Done closes the card', async () => {
        const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
        vi.mocked(reportAbuse).mockResolvedValueOnce({ success: true });
        const onClose = vi.fn();
        const onReported = vi.fn();
        render(<ReportModal {...props} onClose={onClose} onReported={onReported} />);
        fireEvent.click(screen.getByRole('button', { name: /^Spam or scam$/ }));
        fireEvent.click(screen.getByRole('button', { name: /Submit Report/i }));
        expect(await screen.findByTestId('report-sent')).toHaveTextContent(REPORT_SENT);
        expect(within(screen.getByRole('dialog')).getByRole('status')).toHaveTextContent(REPORT_SENT);
        expect(screen.queryByRole('button', { name: /Submit Report/i })).toBeNull();
        expect(onClose).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(onReported).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(alert).not.toHaveBeenCalled();
    });

    it('failed: says why, never that it was sent, and no alert', async () => {
        const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
        vi.mocked(reportAbuse).mockRejectedValueOnce(new Error('Could not reach the node.'));
        const onReported = vi.fn();
        render(<ReportModal {...props} onClose={vi.fn()} onReported={onReported} />);
        fireEvent.click(screen.getByRole('button', { name: /^Other$/ }));
        fireEvent.click(screen.getByRole('button', { name: /Submit Report/i }));
        expect(await screen.findByText('Could not reach the node.')).toBeInTheDocument();
        expect(screen.queryByTestId('report-sent')).toBeNull();
        expect(document.body.textContent).not.toContain(REPORT_SENT);
        expect(onReported).not.toHaveBeenCalled();
        expect(alert).not.toHaveBeenCalled();
    });

    it('closing a sent card with ✕ still tells the caller; closing an unsent one does not', async () => {
        vi.mocked(reportAbuse).mockResolvedValueOnce({ success: true });
        const onReported = vi.fn();
        const { unmount } = render(<ReportModal {...props} onClose={vi.fn()} onReported={onReported} />);
        fireEvent.click(screen.getByRole('button', { name: /Close report dialog/i }));
        expect(onReported).not.toHaveBeenCalled();
        unmount();
        render(<ReportModal {...props} onClose={vi.fn()} onReported={onReported} />);
        fireEvent.click(screen.getByRole('button', { name: /^Other$/ }));
        fireEvent.click(screen.getByRole('button', { name: /Submit Report/i }));
        await screen.findByTestId('report-sent');
        fireEvent.click(screen.getByRole('button', { name: /Close report dialog/i }));
        expect(onReported).toHaveBeenCalledTimes(1);
    });
});

describe("the Market's inline report form", () => {
    it('says its result under the form, never in an alert()', () => {
        const src = readFileSync(resolve(__dirname, '../pages/MarketplacePage.tsx'), 'utf8');
        const block = src.slice(src.indexOf('🚩 Report'), src.indexOf("{submittingReport ? 'Sending...' : 'Submit Report'}"));
        expect(block).toContain('reportAbuse(');
        expect(block).not.toMatch(/\balert\(/);
        expect(block).toContain('setReportNote({ sent: true, text: t(REPORT_WORDS.sent) })');
        expect(src).toContain('data-testid="report-note"');
    });
});

describe('a signed-out visitor', () => {
    it('is told where to report, with a link to the safety page, and is given no report button', () => {
        const post = { id: 'p1', type: 'offer', category: 'food', title: 'Sourdough loaves', description: 'Fresh', credits: 0, status: 'active', createdAt: new Date().toISOString() } as unknown as MarketplacePost;
        render(<VisitorPostDetail post={post} beans={false} distanceKm={null} onBack={vi.fn()} onJoin={vi.fn()} />);
        const line = screen.getByTestId('visitor-report');
        expect(line).toHaveTextContent(/Members report it from the listing/);
        expect(within(line).getByRole('link', { name: 'Without an account, tell us on our safety page.' })).toHaveAttribute('href', VISITOR_REPORT_URL);
        expect(screen.queryByRole('button', { name: /report/i })).toBeNull();
    });
});
