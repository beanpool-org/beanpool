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

function serve(answer: any) {
    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (!init || init.method !== 'POST') return new Response(JSON.stringify(answer));
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ back: ['p1'], gone: 0, success: true }));
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
});
