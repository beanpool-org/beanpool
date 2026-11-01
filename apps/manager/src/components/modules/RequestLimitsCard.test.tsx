import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RequestLimitsCard } from './RequestLimitsCard';

/** Who reports stopped from sending message requests, as a moderator sees it, and the Undo (server: test-request-limits.ts). */

const SAM = 'a1'.repeat(32);
const LIMIT = { id: 'l1', publicKey: SAM, callsign: 'Sam', how: 'same_wording', madeAt: '2026-11-01T00:00:00.000Z', until: '2026-11-08T00:00:00.000Z' };

function node(limits: unknown[], undo: { status: number; body: unknown } = { status: 200, body: { success: true } }) {
    const calls: { url: string; method: string }[] = [];
    let current = limits;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method ?? 'GET' });
        if (init?.method === 'POST') {
            if (undo.status === 200) current = [];
            return new Response(JSON.stringify(undo.body), { status: undo.status });
        }
        return new Response(JSON.stringify({ success: true, limits: current }), { status: 200 });
    }));
    return calls;
}

describe('RequestLimitsCard', () => {
    beforeEach(() => { vi.unstubAllGlobals(); });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('shows nothing when nobody is limited', async () => {
        const calls = node([]);
        const { container } = render(<RequestLimitsCard nodeUrl="https://node.example" />);
        await waitFor(() => expect(calls.length).toBe(1));
        expect(container).toBeEmptyDOMElement();
    });

    it('names who, why and until when, and says it is not a pause', async () => {
        node([LIMIT]);
        render(<RequestLimitsCard nodeUrl="https://node.example" />);
        const row = await screen.findByTestId('request-limit');
        expect(row).toHaveTextContent('Sam');
        expect(row).toHaveTextContent('Two people reported the same words.');
        expect(row).toHaveTextContent('Until');
        expect(screen.getByTestId('request-limits')).toHaveTextContent('They can still answer people who wrote to them, and post.');
    });

    it('Undo asks the node for that member, says so, and the row goes', async () => {
        const calls = node([LIMIT]);
        render(<RequestLimitsCard nodeUrl="https://node.example" />);
        fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
        expect(await screen.findByRole('status')).toHaveTextContent('Sam can send message requests again');
        expect(calls.some((c) => c.method === 'POST' && c.url.endsWith(`/api/local/admin/members/${SAM}/request-limit/undo`))).toBe(true);
        expect(screen.queryByTestId('request-limit')).toBeNull();
    });

    it('a refused Undo says the node\'s words and keeps the row', async () => {
        node([LIMIT], { status: 403, body: { success: false, error: 'A moderator cannot undo a limit on themselves' } });
        render(<RequestLimitsCard nodeUrl="https://node.example" />);
        fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('A moderator cannot undo a limit on themselves');
        expect(screen.getByTestId('request-limit')).toBeInTheDocument();
    });
});
