/**
 * Front doors S2: "Ask to join {community}" on the web's Find card, the phone's button and form (find-community.tsx): Ask
 * to join → Your name (the member's, filled) and A few words about yourself → Send → "You asked to join", remembered in this
 * browser for Home's waiting card. The community's refusals are its own words. The community is a stubbed fetch behind the
 * real lib/knock.ts sendKnock. Fails before S2: the web had no Ask to join (AskedCommunity said to open the app).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { t } from '@beanpool/core';
import { AskToJoin } from './AskToJoin';
import { KNOCK_MESSAGES, rememberedKnocks } from '../lib/knock';
import type { BeanPoolIdentity } from '../lib/identity';

const ME: BeanPoolIdentity = { publicKey: 'a'.repeat(64), privateKey: '00'.repeat(32), callsign: 'Ana', createdAt: '2026-01-01T00:00:00.000Z' } as BeanPoolIdentity;
const RIVERSIDE = { key: 'r', name: 'Riverside', url: 'https://riverside.example.org' };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function stub(answer: () => Response) {
    const sent: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        sent.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return answer();
    }));
    return sent;
}

function openForm() {
    fireEvent.click(screen.getByRole('button', { name: 'Ask to join Riverside' }));
    return {
        name: screen.getByLabelText('Your name') as HTMLInputElement,
        message: screen.getByLabelText('A few words about yourself') as HTMLTextAreaElement,
        send: screen.getByRole('button', { name: 'Send' }),
    };
}

beforeEach(() => { localStorage.clear(); localStorage.setItem('bp_node_url', 'https://global.example.org'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('Ask to join on the web', () => {
    it('the button opens the phone\'s form, the name filled with the member\'s', () => {
        render(<AskToJoin community={RIVERSIDE} identity={ME} asked={false} />);
        expect(screen.getByRole('button', { name: 'Ask to join Riverside' }).textContent).toBe('Ask to join');
        const { name, message } = openForm();
        expect(name.value).toBe('Ana');
        expect(message.placeholder).toBe("Where you live, what you'd like to share or learn");
        expect(screen.getByText('0/280')).toBeTruthy();
    });

    it('sends the knock to the community itself, says "You asked to join", remembers it, and tells Home', async () => {
        const sent = stub(() => json(201, { knock: { status: 'pending' } }));
        const onAsked = vi.fn();
        render(<AskToJoin community={RIVERSIDE} identity={ME} asked={false} onAsked={onAsked} />);
        const { message, send } = openForm();
        fireEvent.change(message, { target: { value: 'I grow tomatoes by the river.' } });
        fireEvent.click(send);
        expect(await screen.findByRole('status')).toHaveTextContent(t(KNOCK_MESSAGES.waiting));
        expect(screen.queryByRole('form')).toBeNull();
        expect(sent).toEqual([{
            url: 'https://riverside.example.org/api/join/knock',
            body: { message: 'I grow tomatoes by the river.', callsign: 'Ana', fromNode: 'global.example.org', toNode: 'riverside.example.org' },
        }]);
        expect((await rememberedKnocks(ME.publicKey)).map(k => [k.url, k.name, k.key])).toEqual([['https://riverside.example.org', 'Riverside', 'r']]);
        expect(onAsked).toHaveBeenCalledTimes(1);
    });

    it('"You asked to join" stays only until Home holds the request; if Home lets it go (Got it), Ask to join is back, no stale line', async () => {
        stub(() => json(201, { knock: { status: 'pending' } }));
        const { container, rerender } = render(<AskToJoin community={RIVERSIDE} identity={ME} asked={false} onAsked={() => {}} />);
        const { message, send } = openForm();
        fireEvent.change(message, { target: { value: 'Hello' } });
        fireEvent.click(send);
        expect(await screen.findByRole('status')).toHaveTextContent(t(KNOCK_MESSAGES.waiting));
        // Home read its memory again (onAsked): its card says how the request fares from here.
        rerender(<AskToJoin community={RIVERSIDE} identity={ME} asked onAsked={() => {}} />);
        expect(container.innerHTML).toBe('');
        // Got it on a request the community no longer holds: Home forgets it.
        rerender(<AskToJoin community={RIVERSIDE} identity={ME} asked={false} onAsked={() => {}} />);
        expect(screen.getByRole('button', { name: 'Ask to join Riverside' })).toBeTruthy();
        expect(document.body.textContent).not.toContain(t(KNOCK_MESSAGES.waiting));
    });

    it('holds the member to the node\'s limits before sending anything', () => {
        const sent = stub(() => json(201, {}));
        render(<AskToJoin community={RIVERSIDE} identity={ME} asked={false} />);
        const { name, send } = openForm();
        fireEvent.click(send);
        expect(screen.getByRole('alert')).toHaveTextContent('Please say a few words about yourself.');
        fireEvent.change(name, { target: { value: 'A' } });
        fireEvent.click(send);
        expect(screen.getByRole('alert')).toHaveTextContent('Please give a name of at least 2 characters.');
        expect(sent).toEqual([]);
    });

    it('a refusal is the community\'s own words, and the form stays to try again', async () => {
        const words = 'Too many requests to join have come from this network today (5). Please try again tomorrow.';
        stub(() => json(429, { error: words, code: 'rate_limited' }));
        const onAsked = vi.fn();
        render(<AskToJoin community={RIVERSIDE} identity={ME} asked={false} onAsked={onAsked} />);
        const { message, send } = openForm();
        fireEvent.change(message, { target: { value: 'Hello' } });
        fireEvent.click(send);
        expect(await screen.findByRole('alert')).toHaveTextContent(words);
        expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
        expect(await rememberedKnocks(ME.publicKey)).toEqual([]);
        expect(onAsked).not.toHaveBeenCalled();
    });

    it('a member there already is told so, and nothing is remembered', async () => {
        stub(() => json(409, { error: 'You are already a member of this community.', code: 'already_member' }));
        render(<AskToJoin community={RIVERSIDE} identity={ME} asked={false} />);
        const { message, send } = openForm();
        fireEvent.change(message, { target: { value: 'Hello' } });
        fireEvent.click(send);
        expect(await screen.findByRole('status')).toHaveTextContent('You are already a member of this community.');
        expect(await rememberedKnocks(ME.publicKey)).toEqual([]);
    });

    it('a community it can\'t reach: the app\'s words', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
        render(<AskToJoin community={RIVERSIDE} identity={ME} asked={false} />);
        const { message, send } = openForm();
        fireEvent.change(message, { target: { value: 'Hello' } });
        fireEvent.click(send);
        expect(await screen.findByRole('alert')).toHaveTextContent(t(KNOCK_MESSAGES.unreachable));
    });

    it('already asked from this browser: nothing here (Home\'s card says how it fares, with Cancel my request)', () => {
        const { container } = render(<AskToJoin community={RIVERSIDE} identity={ME} asked />);
        expect(container.innerHTML).toBe('');
    });

    it('cancelled within the day: nothing to press, and no line (Home said so in the visit it was cancelled: #2573)', async () => {
        localStorage.setItem('beanpool_knocks', JSON.stringify({
            pubkey: ME.publicKey,
            knocks: [{ url: 'https://riverside.example.org', name: 'Riverside', key: 'r', sentAt: new Date(Date.now() - 7_200_000).toISOString(), cancelledAt: new Date(Date.now() - 3_600_000).toISOString() }],
        }));
        const { container } = render(<AskToJoin community={RIVERSIDE} identity={ME} asked={false} />);
        await waitFor(() => expect(container.innerHTML).toBe(''));
        expect(document.body.textContent).not.toContain(t(KNOCK_MESSAGES.cancelled));
    });

    it('a request cancelled more than a day ago: Ask to join again', async () => {
        localStorage.setItem('beanpool_knocks', JSON.stringify({
            pubkey: ME.publicKey,
            knocks: [{ url: 'https://riverside.example.org', name: 'Riverside', key: 'r', sentAt: new Date(Date.now() - 50 * 3_600_000).toISOString(), cancelledAt: new Date(Date.now() - 25 * 3_600_000).toISOString() }],
        }));
        render(<AskToJoin community={RIVERSIDE} identity={ME} asked={false} />);
        await new Promise(r => setTimeout(r, 0));
        expect(screen.getByRole('button', { name: 'Ask to join Riverside' })).toBeTruthy();
    });

    it('no usable address: said so, nothing to press', () => {
        render(<AskToJoin community={{ key: 'x', name: 'Hilltop', url: 'http://hilltop.example.org' }} identity={ME} asked={false} />);
        expect(screen.getByText(t(KNOCK_MESSAGES.noAddress))).toBeTruthy();
        expect(screen.queryByRole('button')).toBeNull();
    });
});
