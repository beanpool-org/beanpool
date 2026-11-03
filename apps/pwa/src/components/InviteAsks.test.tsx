/**
 * A member asks an admin to invite someone, on the web (components/InviteAsks.tsx): the small button, the short sheet and its
 * keyboard path, what the member has asked, and an owner's or admin's answers. The node is a stubbed fetch behind the real
 * lib/invite-asks.ts calls; its rules are apps/server test-invite-asks.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AskAnAdmin, InviteAsksToAnswer } from './InviteAsks';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
function stub(route: Route) {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return route(url, init);
    }));
    return calls;
}
const SAM = { id: 'a1', firstName: 'Sam', howKnown: 'runs the <b>bakery</b>', askedAt: '2026-11-03T00:00:00.000Z' };
const fill = (name: string, how: string) => {
    fireEvent.change(screen.getByTestId('invite-ask-first-name'), { target: { value: name } });
    fireEvent.change(screen.getByTestId('invite-ask-how-known'), { target: { value: how } });
};
const none = { waiting: [], answers: [] };
const member = () => render(<AskAnAdmin onCopy={vi.fn()} onShare={vi.fn()} />);

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('asking', () => {
    it('is a small button, and no list until there is something to list', async () => {
        const calls = stub(() => json(200, none));
        member();
        await waitFor(() => expect(calls.some((c) => c.url === '/api/invite/asks/mine')).toBe(true));
        expect(screen.getByRole('button', { name: 'Ask an admin to invite someone' })).toBeTruthy();
        expect(screen.queryByRole('heading', { name: 'What you’ve asked' })).toBeNull();
    });

    it('the sheet takes focus, needs both lines, sends them, and closes', async () => {
        const calls = stub((url, init) => (init?.method === 'POST' ? json(201, { ask: SAM }) : json(200, none)));
        member();
        fireEvent.click(screen.getByTestId('invite-ask-open'));
        const dialog = screen.getByRole('dialog');
        expect(document.activeElement).toBe(screen.getByTestId('invite-ask-first-name'));
        const send = within(dialog).getByTestId('invite-ask-send') as HTMLButtonElement;
        expect(send.disabled).toBe(true);
        fill('Sam', '   ');
        expect(send.disabled).toBe(true);
        fill('  Sam ', ' from the bakery ');
        expect(send.disabled).toBe(false);
        fireEvent.submit(send.closest('form')!);
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(calls.find((c) => c.method === 'POST')).toEqual({ url: '/api/invite/asks', method: 'POST', body: { firstName: 'Sam', howKnown: 'from the bakery' } });
    });

    it('holds no more than its limits, and asks for nothing else', () => {
        stub(() => json(200, none));
        member();
        fireEvent.click(screen.getByTestId('invite-ask-open'));
        const dialog = screen.getByRole('dialog');
        expect((screen.getByTestId('invite-ask-first-name') as HTMLInputElement).maxLength).toBe(30);
        expect((screen.getByTestId('invite-ask-how-known') as HTMLInputElement).maxLength).toBe(140);
        expect(dialog.querySelectorAll('input').length).toBe(2);
    });

    it('Escape closes the sheet', () => {
        stub(() => json(200, none));
        member();
        fireEvent.click(screen.getByTestId('invite-ask-open'));
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('a refusal is said in the sheet, in the node\'s words, and the lines stay', async () => {
        stub((url, init) => (init?.method === 'POST' ? json(429, { error: 'You’ve asked 3 times today. You can ask again tomorrow.', code: 'asked_enough_today' }) : json(200, none)));
        member();
        fireEvent.click(screen.getByTestId('invite-ask-open'));
        fill('Sam', 'bakery');
        fireEvent.submit(screen.getByTestId('invite-ask-send').closest('form')!);
        expect((await screen.findByRole('alert')).textContent).toBe('You’ve asked 3 times today. You can ask again tomorrow.');
        expect((screen.getByTestId('invite-ask-first-name') as HTMLInputElement).value).toBe('Sam');
    });

    it('with no answer from the node, says so', async () => {
        stub((url, init) => { if (init?.method === 'POST') throw new TypeError('offline'); return json(200, none); });
        member();
        fireEvent.click(screen.getByTestId('invite-ask-open'));
        fill('Sam', 'bakery');
        fireEvent.submit(screen.getByTestId('invite-ask-send').closest('form')!);
        expect((await screen.findByRole('alert')).textContent).toBe("Couldn't reach your community. Check your connection and try again.");
    });
});

describe('what the member has asked', () => {
    it('shows what waits, fenced as plain text, and takes it back', async () => {
        let waiting = [SAM];
        const calls = stub((url, init) => {
            if (init?.method === 'POST') { waiting = []; return json(200, { ok: true }); }
            return json(200, { waiting, answers: [] });
        });
        member();
        const row = await screen.findByTestId('invite-ask-waiting-a1');
        expect(screen.getByRole('heading', { name: 'What you’ve asked' })).toBeTruthy();
        expect(within(row).getByText('Waiting for an admin')).toBeTruthy();
        const fence = within(row).getByTestId('invite-ask-fence');
        expect(fence.textContent).toContain('runs the <b>bakery</b>');
        expect(fence.querySelector('b')).toBeNull();
        fireEvent.click(within(row).getByRole('button', { name: 'Take it back' }));
        await waitFor(() => expect(screen.queryByTestId('invite-ask-waiting-a1')).toBeNull());
        expect(calls.find((c) => c.method === 'POST')?.url).toBe('/api/invite/asks/a1/withdraw');
    });

    it('shows the code to pass on, with Copy and Share', async () => {
        stub(() => json(200, { waiting: [], answers: [{ id: 'n1', outcome: 'invited', state: 'ready', code: 'INV-ABCD-EFGH', askedAt: SAM.askedAt, answeredAt: SAM.askedAt }] }));
        const onCopy = vi.fn();
        const onShare = vi.fn();
        render(<AskAnAdmin onCopy={onCopy} onShare={onShare} />);
        const row = await screen.findByTestId('invite-ask-answer-n1');
        expect(within(row).getByText('An admin made an invite for you to pass on. It works once, for 30 days.')).toBeTruthy();
        expect(within(row).getByText('INV-ABCD-EFGH')).toBeTruthy();
        fireEvent.click(within(row).getByRole('button', { name: 'Copy invite link' }));
        fireEvent.click(within(row).getByRole('button', { name: 'Share invite link' }));
        expect(onCopy).toHaveBeenCalledWith('INV-ABCD-EFGH');
        expect(onShare).toHaveBeenCalledWith('INV-ABCD-EFGH');
    });

    it('shows a No and its reason, fenced', async () => {
        stub(() => json(200, { waiting: [], answers: [{ id: 'n2', outcome: 'no', reason: 'We don’t <i>know</i> them', askedAt: SAM.askedAt, answeredAt: SAM.askedAt }] }));
        member();
        const row = await screen.findByTestId('invite-ask-answer-n2');
        expect(within(row).getByText('An admin said no.')).toBeTruthy();
        const fence = within(row).getByTestId('invite-ask-fence');
        expect(fence.textContent).toBe('We don’t <i>know</i> them');
        expect(fence.querySelector('i')).toBeNull();
    });
});

describe('answering', () => {
    const ASK = { ...SAM, askerPubkey: 'k'.repeat(64), askerCallsign: 'Mel' };
    it('shows nothing to someone the node refuses, or with nothing waiting', async () => {
        const calls = stub(() => json(403, { error: 'no', code: 'admins_only' }));
        const { container } = render(<InviteAsksToAnswer offersVouch={false} />);
        await waitFor(() => expect(calls.length).toBe(1));
        expect(container.textContent).toBe('');
    });

    it('names who asked, fences the words, and sends an invite with None by default', async () => {
        let asks = [ASK];
        const calls = stub((url, init) => {
            if (init?.method === 'POST') { asks = []; return json(200, { ok: true }); }
            return json(200, { asks, total: asks.length });
        });
        render(<InviteAsksToAnswer offersVouch={false} />);
        const row = await screen.findByTestId('invite-ask-a1');
        expect(within(row).getByText('Asked by Mel')).toBeTruthy();
        expect(within(row).getByTestId('invite-ask-fence').querySelector('b')).toBeNull();
        expect(within(row).queryByText('Vouch for them')).toBeNull();
        fireEvent.click(within(row).getByRole('button', { name: 'Send invite' }));
        expect((await screen.findByRole('status')).textContent).toBe('Sent. The code is with the member now.');
        expect(calls.find((c) => c.method === 'POST')).toEqual({ url: '/api/invite/asks/a1/send', method: 'POST', body: {} });
    });

    it('offers the vouch to someone who can give one, and sends the level chosen', async () => {
        const calls = stub((url, init) => (init?.method === 'POST' ? json(200, { ok: true }) : json(200, { asks: [ASK], total: 1 })));
        render(<InviteAsksToAnswer offersVouch />);
        const row = await screen.findByTestId('invite-ask-a1');
        fireEvent.click(within(row).getByRole('radio', { name: '50 Beans' }));
        fireEvent.click(within(row).getByRole('button', { name: 'Send invite' }));
        await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
        expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ vouchLevel: 2 });
    });

    it('No opens a short reason, and sends it', async () => {
        const calls = stub((url, init) => (init?.method === 'POST' ? json(200, { ok: true }) : json(200, { asks: [ASK], total: 1 })));
        render(<InviteAsksToAnswer offersVouch={false} />);
        const row = await screen.findByTestId('invite-ask-a1');
        fireEvent.click(within(row).getByTestId('invite-ask-no-a1'));
        const reason = within(row).getByTestId('invite-ask-reason-a1') as HTMLInputElement;
        expect(reason.maxLength).toBe(100);
        fireEvent.change(reason, { target: { value: ' Not this year ' } });
        fireEvent.click(within(row).getByTestId('invite-ask-send-no-a1'));
        await screen.findByRole('status');
        expect(calls.find((c) => c.method === 'POST')).toEqual({ url: '/api/invite/asks/a1/no', method: 'POST', body: { reason: 'Not this year' } });
    });

    it('says when another admin got there first', async () => {
        stub((url, init) => (init?.method === 'POST' ? json(404, { error: 'This ask is no longer waiting. It may have been answered or taken back.', code: 'not_found' }) : json(200, { asks: [ASK], total: 1 })));
        render(<InviteAsksToAnswer offersVouch={false} />);
        fireEvent.click(await screen.findByTestId('invite-ask-invite-a1'));
        expect((await screen.findByRole('alert')).textContent).toBe('This ask is no longer waiting. It may have been answered or taken back.');
    });
});
