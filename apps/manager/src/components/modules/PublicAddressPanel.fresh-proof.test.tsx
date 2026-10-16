import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PublicAddressPanel } from './PublicAddressPanel';
import type { NodeProfile } from '../../lib/profiles';

/**
 * Owner-delete S4a: Take offline, Release a name and Claim over a live name ask an owner's fresh proof (server
 * public-address.ts requireFreshProof). The server's three refusals → the code box (password viewer), the "Manage again"
 * sentence (a stale phone hand-off) or the "from your phone" sentence (a computer's key session).
 */
const node: NodeProfile = { id: 'n1', name: 'Cairns', url: 'http://localhost:8080', adminPassword: 'pw' };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const CODE_ASK = { error: 'Enter a current code from your authenticator app (or a backup code) to take this community offline', totpRequired: true };
const WRONG = { error: 'Invalid 2FA code', totpRequired: true };
const STEP_UP = { error: 'Press Manage on your phone again, then make this change within 90 seconds.', code: 'step_up_required' };
const PHONE = { error: 'Do this from your phone: open BeanPool, press Manage, then make this change there.', code: 'phone_required', phoneRequired: true };

/** fetch where the offline route answers from `answers` in turn; records each offline body. */
function mockNode(answers: Array<[number, unknown]>, sent: Array<Record<string, unknown>>, path = '/public-address/offline') {
    vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
        const u = String(url);
        if (u.includes(path) && opts?.method === 'POST') {
            sent.push(JSON.parse(String(opts.body || '{}')));
            const [status, body] = answers[Math.min(sent.length - 1, answers.length - 1)];
            return json(status, body);
        }
        if (u.includes('/public-address/status')) return json(200, { status: 'live', hostname: 'cairns.beanpool.org', name: 'cairns', mode: 'tunnel' });
        if (u.includes('/extra-names')) return json(200, { names: [{ name: 'old-cairns', hostname: 'old-cairns.beanpool.org', releasable: true }] });
        return json(200, { logs: [] });
    });
}

async function pressTakeOffline() {
    await waitFor(() => expect(screen.getByRole('button', { name: /Take offline/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Take offline/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Take Offline' }));
}

describe('PublicAddressPanel: an owner\'s fresh proof (S4a)', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('password viewer: Take offline opens the code box; Confirm re-sends the same request once, with the code', async () => {
        const sent: Array<Record<string, unknown>> = [];
        mockNode([[401, CODE_ASK], [200, { success: true, status: 'none' }]], sent);
        render(<PublicAddressPanel activeNode={node} />);
        await pressTakeOffline();
        const input = await screen.findByTestId('address-proof-input');
        expect(screen.getByText(/to take this community offline/)).toBeInTheDocument();
        expect(sent).toHaveLength(1);
        expect(sent[0].code).toBeUndefined();
        fireEvent.change(input, { target: { value: '123456' } });
        fireEvent.click(screen.getByTestId('address-proof-confirm'));
        await waitFor(() => expect(screen.getByText(/Public address released/)).toBeInTheDocument());
        expect(sent).toHaveLength(2);
        expect(sent[1].code).toBe('123456');
        expect(screen.queryByTestId('address-proof-code')).not.toBeInTheDocument();
    });

    it('password viewer: a wrong or spent code says so, the field stays, and the same code is never sent twice', async () => {
        const sent: Array<Record<string, unknown>> = [];
        mockNode([[401, CODE_ASK], [401, WRONG], [200, { success: true, status: 'none' }]], sent);
        render(<PublicAddressPanel activeNode={node} />);
        await pressTakeOffline();
        const input = await screen.findByTestId('address-proof-input');
        fireEvent.change(input, { target: { value: '111111' } });
        fireEvent.click(screen.getByTestId('address-proof-confirm'));
        await waitFor(() => expect(screen.getByTestId('address-proof-error')).toHaveTextContent('Invalid 2FA code'));
        expect(screen.getByTestId('address-proof-input')).toBeInTheDocument();
        expect(sent).toHaveLength(2);
        // The same code again: Confirm waits for a new one.
        expect(screen.getByTestId('address-proof-confirm')).toBeDisabled();
        fireEvent.submit(screen.getByTestId('address-proof-code'));
        await new Promise((r) => setTimeout(r, 20));
        expect(sent).toHaveLength(2);
        fireEvent.change(screen.getByTestId('address-proof-input'), { target: { value: '222222' } });
        fireEvent.click(screen.getByTestId('address-proof-confirm'));
        await waitFor(() => expect(screen.getByText(/Public address released/)).toBeInTheDocument());
        expect(sent.map((b) => b.code)).toEqual([undefined, '111111', '222222']);
    });

    it('phone viewer, hand-off stale: says press Manage on the phone again; no code box, nothing re-sent', async () => {
        const sent: Array<Record<string, unknown>> = [];
        mockNode([[403, STEP_UP]], sent);
        render(<PublicAddressPanel activeNode={node} viewer={{ kind: 'key', memberPubkey: 'a'.repeat(64), role: 'owner' }} />);
        await pressTakeOffline();
        expect(await screen.findByTestId('address-proof-step-up')).toHaveTextContent('Press Manage on your phone again, then make this change within 90 seconds.');
        expect(screen.queryByTestId('address-proof-input')).not.toBeInTheDocument();
        await new Promise((r) => setTimeout(r, 20));
        expect(sent).toHaveLength(1);
    });

    it('computer viewer: says do this from your phone; no code box, nothing re-sent', async () => {
        const sent: Array<Record<string, unknown>> = [];
        mockNode([[403, PHONE]], sent);
        render(<PublicAddressPanel activeNode={node} viewer={{ kind: 'key', memberPubkey: 'a'.repeat(64), role: 'owner' }} />);
        await pressTakeOffline();
        expect(await screen.findByTestId('address-proof-phone')).toHaveTextContent('Do this from your phone: open BeanPool, press Manage, then make this change there.');
        expect(screen.queryByTestId('address-proof-input')).not.toBeInTheDocument();
        expect(sent).toHaveLength(1);
    });

    it('Release a name: the code box, then the same release re-sent with the code', async () => {
        const sent: Array<Record<string, unknown>> = [];
        mockNode([[401, { ...CODE_ASK, error: 'Enter a current code from your authenticator app (or a backup code) to release a name' }], [200, { success: true }]], sent, '/release-name');
        render(<PublicAddressPanel activeNode={node} />);
        const release = await screen.findByRole('button', { name: /Release/i });
        fireEvent.click(release);
        fireEvent.click(screen.getByRole('button', { name: 'Release it' }));
        fireEvent.change(await screen.findByTestId('address-proof-input'), { target: { value: '654321' } });
        fireEvent.click(screen.getByTestId('address-proof-confirm'));
        await waitFor(() => expect(screen.getByText(/old-cairns.beanpool.org released/)).toBeInTheDocument());
        expect(sent).toEqual([{ name: 'old-cairns', password: 'pw' }, { name: 'old-cairns', password: 'pw', code: '654321' }]);
    });

    it('Claim over a live name from a computer: says do this from your phone', async () => {
        const sent: Array<Record<string, unknown>> = [];
        mockNode([[403, PHONE]], sent, '/public-address/claim');
        render(<PublicAddressPanel activeNode={node} viewer={{ kind: 'key', memberPubkey: 'a'.repeat(64), role: 'owner' }} />);
        const input = await screen.findByPlaceholderText('e.g. cairns');
        fireEvent.change(input, { target: { value: 'newcairns' } });
        fireEvent.submit(input.closest('form')!);
        expect(await screen.findByTestId('address-proof-phone')).toBeInTheDocument();
        expect(sent).toHaveLength(1);
    });

    it('New tunnel key is not offered to an admin viewer; an owner sees it', async () => {
        mockNode([[200, {}]], []);
        const { unmount } = render(<PublicAddressPanel activeNode={node} viewer={{ kind: 'key', memberPubkey: 'b'.repeat(64), role: 'admin' }} />);
        await waitFor(() => expect(screen.getByRole('button', { name: /Take offline/i })).toBeInTheDocument());
        expect(screen.queryByRole('button', { name: /New tunnel key/i })).not.toBeInTheDocument();
        unmount();
        render(<PublicAddressPanel activeNode={node} viewer={{ kind: 'key', memberPubkey: 'a'.repeat(64), role: 'owner' }} />);
        expect(await screen.findByRole('button', { name: /New tunnel key/i })).toBeInTheDocument();
    });
});
