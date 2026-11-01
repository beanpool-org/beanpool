import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ReportedDirectMessage } from './ReportedDirectMessage';

/**
 * The one direct message line a report names (server: test-dm-line-report.ts proves what each state means). This checks the
 * screen says each one, and never reads the reporter's words as proven: a signature says who wrote the sealed line, not
 * what it says.
 */

const BOB = 'b0'.repeat(32);

function serve(message: unknown, status = 200) {
    const fetchMock = vi.fn(async () => ({
        ok: status === 200, status, statusText: '',
        json: async () => (status === 200 ? { success: true, message } : { success: false, error: 'This report does not name a message' }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

const base = {
    kind: 'dm', id: 'm1', sentAt: '2026-10-25T01:00:00Z', signedAt: '2026-10-25T01:00:00Z', authorPubkey: BOB, authorCallsign: 'Bob', signer: BOB,
    signature: 'verified', words: { state: 'reported', text: 'Rude words' }, photo: false, line: 'same',
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('ReportedDirectMessage', () => {
    it('opens the line through the report, and names a direct message from its sender', async () => {
        const fetchMock = serve(base);
        render(<ReportedDirectMessage nodeUrl="https://node.example" reportId="r 1" adminPassword="pw" />);
        await screen.findByText('Rude words');
        expect(String(fetchMock.mock.calls[0]?.[0 as never])).toMatch(/node\.example\/api\/local\/admin\/reports\/r%201\/message$/);
        expect(screen.getByText('Direct message · from Bob')).toBeInTheDocument();
    });

    it('a verified signature says who sent it, and the words still read as the reporter\'s', async () => {
        serve(base);
        render(<ReportedDirectMessage nodeUrl="https://node.example" reportId="r1" />);
        expect(await screen.findByText('Signature verified')).toBeInTheDocument();
        expect(screen.getByText(/Bob signed this sealed message to the reporter \(b0b0b0b0…\)/)).toBeInTheDocument();
        expect(screen.getByText('What the reporter says it says')).toBeInTheDocument();
        expect(screen.getByText(/These are the reporter's own words. The signature can't prove them/)).toBeInTheDocument();
        expect(screen.getByText(/Nothing else in the chat can be read here/)).toBeInTheDocument();
    });

    it('a signature that fails shows no signer, and the words are still only the reporter\'s', async () => {
        serve({ ...base, signature: 'unverified', signer: null, signedAt: null });
        render(<ReportedDirectMessage nodeUrl="https://node.example" reportId="r1" />);
        expect(await screen.findByText('Could not be verified')).toBeInTheDocument();
        expect(screen.queryByText('Signature verified')).toBeNull();
        expect(screen.queryByText(/signed this sealed message/)).toBeNull();
        expect(screen.getByText('Rude words')).toBeInTheDocument();
    });

    it('a line from an older app says it has no signature', async () => {
        serve({ ...base, signature: 'unsigned', signer: null, signedAt: null });
        render(<ReportedDirectMessage nodeUrl="https://node.example" reportId="r1" />);
        expect(await screen.findByText('No signature')).toBeInTheDocument();
    });

    it('a shape the node should not send never reads as verified', async () => {
        serve({ ...base, signature: 'verified', signer: null });
        render(<ReportedDirectMessage nodeUrl="https://node.example" reportId="r1" />);
        expect(await screen.findByText('Could not be verified')).toBeInTheDocument();
    });

    it('says when the line was changed or is gone, that a photo stays sealed, and when no words came', async () => {
        serve({ ...base, line: 'gone', photo: true, words: { state: 'reported', text: '' } });
        render(<ReportedDirectMessage nodeUrl="https://node.example" reportId="r1" />);
        const box = within(await screen.findByTestId('reported-direct-message'));
        expect(await box.findByText(/no longer in the chat/)).toBeInTheDocument();
        expect(box.getByText('It had a photo, which stays sealed.')).toBeInTheDocument();
        expect(box.getByText('The reporter gave no words for it.')).toBeInTheDocument();
    });

    it('says so when the node would not open it', async () => {
        serve(null, 404);
        render(<ReportedDirectMessage nodeUrl="https://node.example" reportId="r1" />);
        expect(await screen.findByRole('alert')).toHaveTextContent('Could not open the reported message: This report does not name a message');
    });
});
