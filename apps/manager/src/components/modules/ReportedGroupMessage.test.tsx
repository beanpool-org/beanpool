import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ReportedGroupMessage } from './ReportedGroupMessage';

/**
 * The one group chat message a report names, as the node opened it with its reporter's key (server:
 * test-group-chat-report.ts proves what each state means). This checks the screen says each one, and shows only what
 * was disclosed: words only when verified, a photo only when verified and only as an image data URI.
 */

const BOB = 'b0'.repeat(32);
const PHOTO = `data:image/jpeg;base64,${'QUJD'.repeat(8)}`;

function reply(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => body } as unknown as Response;
}

function serve(message: unknown, status = 200) {
    const fetchMock = vi.fn(async () => reply(status, status === 200 ? { success: true, message } : { success: false, error: 'This report does not name a message' }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

const base = {
    id: 'm1', groupId: 'g1', groupName: 'Garden Crew', sentAt: '2026-10-25T01:00:00Z', editedAt: null,
    authorPubkey: BOB, authorCallsign: 'Bob', signer: BOB,
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('ReportedGroupMessage', () => {
    it('opens the reported message through the report, with the admin credentials', async () => {
        const fetchMock = serve({ ...base, words: { state: 'verified', text: 'Rude words' }, photo: null });
        render(<ReportedGroupMessage nodeUrl="https://node.example" reportId="r 1" adminPassword="pw" />);
        await screen.findByText('Rude words');
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        // Through the manager's node address (resolveNodeApiUrl), to the report's own route.
        expect(String(url)).toMatch(/node\.example\/api\/local\/admin\/reports\/r%201\/message$/);
        expect(init.credentials).toBe('same-origin');
    });

    it('shows verified words with who signed them, and says nothing else of the chat is here', async () => {
        serve({ ...base, words: { state: 'verified', text: 'Rude words' }, photo: null });
        render(<ReportedGroupMessage nodeUrl="https://node.example" reportId="r1" />);
        expect(await screen.findByText('Verified')).toBeInTheDocument();
        expect(screen.getByText('Rude words')).toBeInTheDocument();
        expect(screen.getByText(/Signed by Bob's key \(b0b0b0b0…\)/)).toBeInTheDocument();
        expect(screen.getByText(/Group chat message · Garden Crew · from Bob/)).toBeInTheDocument();
        expect(screen.getByText('Only this one message was shared with the report. Nothing else in the chat can be read here.')).toBeInTheDocument();
        expect(screen.queryByRole('img')).toBeNull();
    });

    it('shows a verified photo with its caption', async () => {
        serve({ ...base, words: { state: 'verified', text: 'Look' }, photo: { state: 'verified', dataUri: PHOTO } });
        render(<ReportedGroupMessage nodeUrl="https://node.example" reportId="r1" />);
        const img = await screen.findByRole('img', { name: 'The reported photo' });
        expect(img).toHaveAttribute('src', PHOTO);
        expect(screen.getByText('Look')).toBeInTheDocument();
    });

    it('reads "Could not be verified" and shows no words when the key does not open the message as its author\'s', async () => {
        serve({ ...base, signer: null, words: { state: 'unverified', text: 'smuggled words' }, photo: { state: 'unverified' } });
        render(<ReportedGroupMessage nodeUrl="https://node.example" reportId="r1" />);
        expect(await screen.findByText('Could not be verified')).toBeInTheDocument();
        expect(screen.getByText(/does not open this message as signed by the member who sent it/)).toBeInTheDocument();
        expect(screen.queryByText('smuggled words')).toBeNull();
        expect(screen.queryByText('Verified')).toBeNull();
        expect(screen.queryByRole('img')).toBeNull();
    });

    it('says a swapped photo could not be verified while the words did', async () => {
        serve({ ...base, words: { state: 'verified', text: 'Look' }, photo: { state: 'unverified' } });
        render(<ReportedGroupMessage nodeUrl="https://node.example" reportId="r1" />);
        expect(await screen.findByText('Photo could not be verified')).toBeInTheDocument();
        expect(screen.getByText('Verified')).toBeInTheDocument();
        expect(screen.queryByRole('img')).toBeNull();
    });

    it('after a standby took over: the words open and the photo reads Image unavailable, saying why', async () => {
        serve({ ...base, words: { state: 'verified', text: 'Look' }, photo: { state: 'unavailable' } });
        render(<ReportedGroupMessage nodeUrl="https://node.example" reportId="r1" />);
        expect(await screen.findByText(/^Image unavailable\. Photos in chats are not copied to a standby server/)).toBeInTheDocument();
        expect(screen.getByText('Look')).toBeInTheDocument();
        expect(screen.queryByRole('img')).toBeNull();
    });

    it('says who took a deleted message away', async () => {
        serve({ ...base, signer: null, words: { state: 'gone', by: 'author' }, photo: null });
        const { unmount } = render(<ReportedGroupMessage nodeUrl="https://node.example" reportId="r1" />);
        expect(await screen.findByText(/^Its author deleted this message after it was reported/)).toBeInTheDocument();
        unmount();
        serve({ ...base, signer: null, words: { state: 'gone', by: 'convenor' }, photo: null });
        render(<ReportedGroupMessage nodeUrl="https://node.example" reportId="r2" />);
        expect(await screen.findByText(/^A convenor removed this message/)).toBeInTheDocument();
    });

    it('never puts anything but an image data URI in an <img>', async () => {
        serve({ ...base, words: { state: 'verified', text: 'Look' }, photo: { state: 'verified', dataUri: 'https://tracker.example/pixel.gif' } });
        render(<ReportedGroupMessage nodeUrl="https://node.example" reportId="r1" />);
        expect(await screen.findByText('Photo could not be verified')).toBeInTheDocument();
        expect(screen.queryByRole('img')).toBeNull();
    });

    it('says so when the node will not open it', async () => {
        serve(null, 404);
        render(<ReportedGroupMessage nodeUrl="https://node.example" reportId="r1" groupName="Garden Crew" />);
        expect(await screen.findByRole('alert')).toHaveTextContent('Could not open the reported message: This report does not name a message');
        expect(screen.getByText(/Group chat message · Garden Crew/)).toBeInTheDocument();
    });

    it('shows that it is opening while the node answers', async () => {
        vi.stubGlobal('fetch', vi.fn(() => new Promise(() => { /* never answers */ })));
        render(<ReportedGroupMessage nodeUrl="https://node.example" reportId="r1" />);
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Opening the reported message…'));
    });
});
