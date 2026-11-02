import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AssistantTakedownsPanel } from './AssistantTakedownsPanel';

const NODE = { id: 'n1', url: 'https://node.example', name: 'Node' } as any;
const CALL = {
    id: 't1', grantId: 'g1', grantName: 'Spam sweeper', member: 'Olive', at: '2026-11-01T10:00:00.000Z', reasonLabel: 'spam or a scam',
    why: '<img src=x onerror=alert(1)> looks like spam', via: 'ids', finalAfter: '2026-11-08T10:00:00.000Z',
    posts: [
        { id: 'p1', title: 'Cheap watches', author: 'Sam', type: 'offer', state: 'hidden' },
        { id: 'p2', title: 'Fake meet-up', author: 'Sam', type: 'event', state: 'left_hidden' },
        { id: 'p3', title: 'Back up', author: 'Mia', type: 'offer', state: 'put_back' },
    ],
};

function serve(answer: any, putBackAnswer: any = { back: ['p1'], gone: 0, success: true }) {
    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (!init || init.method !== 'POST') return new Response(JSON.stringify(answer));
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify(putBackAnswer));
    }));
    return calls;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Taken down by assistants', () => {
    it('draws nothing with nothing taken down, or for a moderator', async () => {
        serve({ canActOnMany: true, takedowns: [] });
        const { container } = render(<AssistantTakedownsPanel activeNode={NODE} />);
        await waitFor(() => expect(fetch).toHaveBeenCalled());
        expect(container.textContent).toBe('');
        cleanup();
        serve({ canActOnMany: true, takedowns: [CALL] });
        const mod = render(<AssistantTakedownsPanel activeNode={NODE} viewer={{ kind: 'key', role: 'moderator' } as any} />);
        expect(mod.container.textContent).toBe('');
    });

    it("shows the call, and the assistant's words as text, never as markup", async () => {
        serve({ canActOnMany: true, takedowns: [CALL] });
        render(<AssistantTakedownsPanel activeNode={NODE} />);
        expect(await screen.findByText(/Spam sweeper: 3 posts, spam or a scam/)).toBeTruthy();
        const why = screen.getByTestId('agent-takedown-why');
        expect(why.textContent).toContain('<img src=x');
        expect(why.querySelector('img')).toBeNull();
    });

    it('puts back one post, and clears nothing else', async () => {
        const calls = serve({ canActOnMany: false, takedowns: [CALL] });
        render(<AssistantTakedownsPanel activeNode={NODE} />);
        fireEvent.click(await screen.findByText('Show its posts'));
        expect(screen.getByText(/Left hidden: a deal in escrow/)).toBeTruthy();
        expect(screen.getAllByTestId('agent-takedown-put-back')).toHaveLength(2);
        fireEvent.click(screen.getAllByTestId('agent-takedown-put-back')[0]);
        await waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0].url).toMatch(/\/api\/local\/admin\/agent\/takedowns\/put-back$/);
        expect(calls[0].body).toEqual({ postId: 'p1' });
    });

    it('says everyone sees a post again only when they do', async () => {
        const putBackOne = async (answer: any) => {
            serve({ canActOnMany: false, takedowns: [CALL] }, answer);
            const panel = render(<AssistantTakedownsPanel activeNode={NODE} />);
            fireEvent.click(await screen.findByText('Show its posts'));
            fireEvent.click(screen.getAllByTestId('agent-takedown-put-back')[0]);
            const said = (await screen.findByRole('status')).textContent ?? '';
            panel.unmount();
            return said;
        };
        const hidden = await putBackOne({ back: ['p1'], stillHidden: ['p1'], gone: 0 });
        expect(hidden).toMatch(/^Put back: 1 post\. 1 post stayed hidden for the moderators, as before the assistant took it down\./);
        expect(hidden).not.toMatch(/everyone sees/);
        const mixed = await putBackOne({ back: ['p1', 'p2', 'p3'], stillHidden: ['p1'], gone: 0 });
        expect(mixed).toMatch(/1 post stayed hidden/);
        expect(mixed).toMatch(/2 posts back up: each author is told, and everyone sees them again\./);
        // A server older than this says nothing of what stayed hidden, and nothing did.
        expect(await putBackOne({ back: ['p1'], gone: 0 })).toMatch(/^Put back: 1 post\. 1 post back up: each author is told/);
    });

    it('offers an admin no whole-call button, and an owner one for a call and for a time', async () => {
        serve({ canActOnMany: false, takedowns: [CALL] });
        const admin = render(<AssistantTakedownsPanel activeNode={NODE} />);
        await screen.findByText('Show its posts');
        expect(screen.queryByTestId('agent-takedown-put-back-call')).toBeNull();
        expect(screen.queryByTestId('agent-takedowns-put-back-since')).toBeNull();
        admin.unmount();
        const calls = serve({ canActOnMany: true, takedowns: [CALL] });
        render(<AssistantTakedownsPanel activeNode={NODE} />);
        fireEvent.click(await screen.findByTestId('agent-takedowns-put-back-since'));
        await waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0].body.grantId).toBe('g1');
        expect(Number.isFinite(Date.parse(calls[0].body.since))).toBe(true);
    });

    it('asks before Remove now, and a post goes through the delete route Settings already has', async () => {
        const calls = serve({ canActOnMany: true, takedowns: [CALL] });
        render(<AssistantTakedownsPanel activeNode={NODE} />);
        fireEvent.click(await screen.findByText('Show its posts'));
        fireEvent.click(screen.getAllByTestId('agent-takedown-remove')[1]);
        expect(await screen.findByText(/It has a deal in escrow: removing it refunds the buyer/)).toBeTruthy();
        expect(calls).toHaveLength(0);
        fireEvent.click(screen.getAllByRole('button', { name: 'Remove now' }).at(-1)!);
        await waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0].url).toMatch(/\/api\/local\/admin\/posts\/p2\/delete$/);
    });

    it('says when a Child safety report is what left a post hidden, and that removing it closes that report', async () => {
        const left = { ...CALL, posts: [{ id: 'p4', title: 'Waiting for a person', author: 'Sam', type: 'offer', state: 'left_hidden', leftFor: 'child_safety', childSafetyOpen: true }] };
        const calls = serve({ canActOnMany: true, takedowns: [left] });
        render(<AssistantTakedownsPanel activeNode={NODE} />);
        fireEvent.click(await screen.findByText('Show its posts'));
        expect(screen.getByText(/Left hidden: a Child safety report is open/)).toBeTruthy();
        expect(screen.queryByText(/a deal in escrow/)).toBeNull();
        fireEvent.click(screen.getByTestId('agent-takedown-remove'));
        expect(await screen.findByText(/A Child safety report on it is still open.*Removing the post closes that report/)).toBeTruthy();
        expect(screen.queryByText(/refunds the buyer/)).toBeNull();
        expect(calls).toHaveLength(0);
    });

    it('warns from the first day of the hold: a Child safety report open on a post still only hidden', async () => {
        const held = { ...CALL, posts: [{ id: 'p5', title: 'Day two', author: 'Sam', type: 'offer', state: 'hidden', leftFor: null, childSafetyOpen: true }] };
        const calls = serve({ canActOnMany: true, takedowns: [held] });
        render(<AssistantTakedownsPanel activeNode={NODE} />);
        fireEvent.click(await screen.findByText('Show its posts'));
        expect(screen.getByText(/Hidden: a Child safety report is open/)).toBeTruthy();
        fireEvent.click(screen.getByTestId('agent-takedown-remove'));
        expect(await screen.findByText(/A Child safety report on it is still open.*Removing the post closes that report and tells whoever filed it/)).toBeTruthy();
        expect(screen.queryByText(/It goes for good/)).toBeNull();
        expect(calls).toHaveLength(0);
    });

    it('a hidden post with no such report keeps the plain words', async () => {
        serve({ canActOnMany: true, takedowns: [{ ...CALL, posts: [{ id: 'p6', title: 'Plain', author: 'Sam', type: 'offer', state: 'hidden', leftFor: null, childSafetyOpen: false }] }] });
        render(<AssistantTakedownsPanel activeNode={NODE} />);
        fireEvent.click(await screen.findByText('Show its posts'));
        expect(screen.queryByText(/Child safety report is open/)).toBeNull();
        fireEvent.click(screen.getByTestId('agent-takedown-remove'));
        expect(await screen.findByText(/It goes for good, without waiting for the 7 days/)).toBeTruthy();
        expect(screen.queryByText(/still open/)).toBeNull();
    });

    it('a post held for a deal with a Child safety report open says both, because the removal does both', async () => {
        serve({ canActOnMany: true, takedowns: [{ ...CALL, posts: [{ id: 'p7', title: 'Both', author: 'Sam', type: 'offer', state: 'left_hidden', leftFor: 'deal', childSafetyOpen: true }] }] });
        render(<AssistantTakedownsPanel activeNode={NODE} />);
        fireEvent.click(await screen.findByText('Show its posts'));
        expect(screen.getByText(/Left hidden: a deal in escrow, and a Child safety report is open/)).toBeTruthy();
        fireEvent.click(screen.getByTestId('agent-takedown-remove'));
        expect(await screen.findByText(/removing it refunds the buyer.*A Child safety report on it is still open/)).toBeTruthy();
    });

    it('says what a whole call left behind, and why, before and after', async () => {
        const calls = serve({ canActOnMany: true, takedowns: [CALL] }, { removed: ['p1'], left: ['p2'] });
        render(<AssistantTakedownsPanel activeNode={NODE} />);
        fireEvent.click(await screen.findByTestId('agent-takedown-remove-call'));
        expect(await screen.findByText(/A post with a deal in escrow or an open Child safety report stays for you to remove by itself/)).toBeTruthy();
        fireEvent.click(screen.getAllByRole('button', { name: 'Remove now' }).at(-1)!);
        await waitFor(() => expect(calls).toHaveLength(1));
        expect((await screen.findByRole('status')).textContent).toBe('Removed: 1 post. 1 post stayed hidden: a deal in escrow, or a Child safety report still open.');
    });
});
