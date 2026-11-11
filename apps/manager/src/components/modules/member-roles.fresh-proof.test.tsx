import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemberDetailModal } from './MemberDetailModal';
import { grantNodeRoleApi, revokeNodeRoleApi } from '../../lib/node-client';

/**
 * Owner-delete S4a, opus-2028 B2: member detail's Grant Owner / Grant Admin / Revoke ask an owner's fresh proof each time
 * (server roleChangeNeedsOwner), as Owners & admins does. Each viewer × the refusal → the sentence in the member's
 * screen, through the real node client; nothing is re-sent until the button is pressed again, and no request carries a
 * code (the server asks none).
 */
const NODE = 'https://riverbend.example.org';
const member = { publicKey: 'a'.repeat(64), callsign: 'anna', status: 'active' };
// The old typed-code ask: the server never sends it any more, so an answer that carries it opens no box.
const OLD_CODE_ASK = { error: 'Enter a current code from your authenticator app (or a backup code) to change who is an owner or admin', totpRequired: true };
const STEP_UP = { error: 'Press Manage on your phone again, then make this change within 90 seconds.', code: 'step_up_required' };
const PHONE = { error: 'Do this from your phone: open BeanPool, press Manage, then make this change there.', code: 'phone_required', phoneRequired: true };

type Sent = { method: string; url: string; body: Record<string, unknown>; proof: string | null };

function mockNode(answers: Array<[number, unknown]>) {
    const sent: Sent[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const reply = (status: number, json: unknown) => ({ ok: status >= 200 && status < 300, status, statusText: '', json: async () => json }) as Response;
        if (url.includes('/api/local/admin/node-roles')) {
            const headers = (init?.headers ?? {}) as Record<string, string>;
            sent.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : {}, proof: headers['X-Fresh-Proof'] ?? null });
            const [status, json] = answers[Math.min(sent.length - 1, answers.length - 1)];
            return reply(status, json);
        }
        return reply(200, {});
    }));
    return sent;
}

function open(nodeRole: 'owner' | 'admin' | null = null) {
    render(
        <MemberDetailModal member={member} isFrozen={false} nodeRole={nodeRole} onToggleFreeze={vi.fn()} onClose={vi.fn()} nodeUrl={NODE}
            onGrantNodeRole={(pk, role, code) => grantNodeRoleApi(NODE, pk, role, 'pw', code).then(() => {})}
            onRevokeNodeRole={(pk, role, code) => revokeNodeRoleApi(NODE, pk, role, 'pw', code).then(() => {})} />,
    );
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => vi.unstubAllGlobals());

describe('Member detail: granting or taking an owner\'s or admin\'s role (S4a, opus-2028 B2)', () => {
    it('Grant Admin with a stale unlock: the Manage-again sentence beside the role (no code field); the next press sends the same grant with no code', async () => {
        const sent = mockNode([[403, STEP_UP], [200, { success: true }]]);
        open();
        fireEvent.click(screen.getByRole('button', { name: /Grant Admin/ }));
        expect(await screen.findByTestId('member-role-proof-step-up')).toHaveTextContent('Press Manage on your phone again');
        expect(screen.queryByTestId('member-role-proof-input')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /Grant Admin/ }));
        expect(await screen.findByText(/Granted admin role successfully/)).toBeInTheDocument();
        expect(sent.map((s) => [s.method, s.body.pubkey, s.body.role, s.body.code])).toEqual([
            ['POST', member.publicKey, 'admin', undefined],
            ['POST', member.publicKey, 'admin', undefined],
        ]);
        expect(screen.queryByTestId('member-role-proof-step-up')).toBeNull();
        // The refusal is never said as "Action Blocked".
        expect(screen.queryByText('Action Blocked')).toBeNull();
    });

    it('Revoke owner with a stale unlock: the same DELETE is sent again on the next press, with no X-Fresh-Proof', async () => {
        const sent = mockNode([[403, STEP_UP], [200, { success: true }]]);
        open('owner');
        fireEvent.click(screen.getByRole('button', { name: 'Revoke owner' }));
        expect(await screen.findByTestId('member-role-proof-step-up')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Revoke owner' }));
        expect(await screen.findByText(/Revoked owner role successfully/)).toBeInTheDocument();
        expect(sent.map((s) => [s.method, s.url.endsWith(`/node-roles/${member.publicKey}/owner`), s.proof])).toEqual([
            ['DELETE', true, null],
            ['DELETE', true, null],
        ]);
    });

    it('an answer asking a typed code (the old shape) opens no box and sends no code: the node\'s sentence is the role card\'s', async () => {
        const sent = mockNode([[401, OLD_CODE_ASK]]);
        open();
        fireEvent.click(screen.getByRole('button', { name: /Grant Admin/ }));
        expect(await screen.findByText(/to change who is an owner or admin/)).toBeInTheDocument();
        expect(screen.queryByTestId('member-role-proof-code')).toBeNull();
        expect(screen.queryByTestId('member-role-proof-input')).toBeNull();
        expect(sent).toHaveLength(1);
        expect(sent[0].body.code).toBeUndefined();
    });

    it('Grant Owner, phone viewer with a stale hand-off: the Manage-again sentence; nothing re-sent', async () => {
        const sent = mockNode([[403, STEP_UP]]);
        open();
        fireEvent.click(screen.getByRole('button', { name: /Grant Owner/ }));
        expect(await screen.findByTestId('member-role-proof-step-up')).toHaveTextContent('Press Manage on your phone again');
        await new Promise((r) => setTimeout(r, 20));
        expect(sent).toHaveLength(1);
        expect(screen.queryByText('Action Blocked')).toBeNull();
    });

    it('Revoke admin, computer viewer: the from-your-phone sentence; nothing re-sent', async () => {
        const sent = mockNode([[403, PHONE]]);
        open('admin');
        fireEvent.click(screen.getByRole('button', { name: 'Revoke admin' }));
        expect(await screen.findByTestId('member-role-proof-phone')).toHaveTextContent('Do this from your phone');
        await waitFor(() => expect(sent).toHaveLength(1));
        expect(screen.queryByText('Action Blocked')).toBeNull();
    });

    it('any other refusal is still said in the role card (the last-owner guard)', async () => {
        mockNode([[409, { error: 'Cannot remove the last owner' }]]);
        open('owner');
        fireEvent.click(screen.getByRole('button', { name: 'Revoke owner' }));
        expect(await screen.findByText(/Cannot remove the last owner/)).toBeInTheDocument();
        expect(screen.queryByTestId('member-role-proof-code')).toBeNull();
    });
});
