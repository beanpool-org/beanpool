import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { NodeRolesPanel, type RolesViewer } from './NodeRolesPanel';
import type { NodeProfile } from '../../lib/profiles';

/**
 * Owner-delete S4a: granting or taking an owner's or admin's role asks an owner's fresh proof (server roleChangeProof).
 * The panel itself, through the real node client: each viewer × the refusal → the box or the sentence; a grant carries
 * the code in its body, a removal (a DELETE, no body) as X-Fresh-Proof; nothing is re-sent without a new code.
 */
const node: NodeProfile = { id: 'n1', name: 'Riverbend', url: 'https://riverbend.example.org', adminPassword: 'pw' };
const ALICE = 'a1'.repeat(32);
const BOB = 'b2'.repeat(32);
const CAROL = 'c3'.repeat(32);
const members = [
    { publicKey: ALICE, callsign: 'alice', status: 'active' },
    { publicKey: BOB, callsign: 'bob', status: 'active' },
    { publicKey: CAROL, callsign: 'carol', status: 'active' },
];
const aliceOwner = { member_pubkey: ALICE, role: 'owner', granted_at: '2026-09-15T10:00:00.000Z', granted_by: 'owner:password', callsign: 'alice' };
const bobAdmin = { member_pubkey: BOB, role: 'admin', granted_at: '2026-09-16T10:00:00.000Z', granted_by: ALICE, callsign: 'bob' };
const CODE_ASK = { error: 'Enter a current code from your authenticator app (or a backup code) to change who is an owner or admin', totpRequired: true };
const WRONG = { error: 'Invalid 2FA code', totpRequired: true };
const STEP_UP = { error: 'Press Manage on your phone again, then make this change within 90 seconds.', code: 'step_up_required' };
const PHONE = { error: 'Do this from your phone: open BeanPool, press Manage, then make this change there.', code: 'phone_required', phoneRequired: true };
const OWNER_KEY: RolesViewer = { kind: 'key', memberPubkey: ALICE, role: 'owner' };

type Sent = { method: string; url: string; body: Record<string, unknown>; proof?: string };

/** A fake node: the role list, and each grant (POST) or removal (DELETE) answered in turn from `answers`. */
function mockNode(answers: Array<[number, unknown]>) {
    const sent: Sent[] = [];
    let roles = [aliceOwner, bobAdmin];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const reply = (status: number, json: unknown) => ({ ok: status >= 200 && status < 300, status, statusText: '', json: async () => json }) as Response;
        const method = init?.method || 'GET';
        if (url.includes('/api/local/admin/node-roles') && method !== 'GET') {
            const body = init?.body ? JSON.parse(String(init.body)) : {};
            sent.push({ method, url, body, proof: (init?.headers as Record<string, string> | undefined)?.['X-Fresh-Proof'] });
            const [status, json] = answers[Math.min(sent.length - 1, answers.length - 1)];
            if (status === 200 && method === 'POST') roles = [...roles, { ...bobAdmin, member_pubkey: body.pubkey, role: body.role, callsign: 'carol' }];
            if (status === 200 && method === 'DELETE') roles = roles.filter((r) => r.member_pubkey !== BOB);
            return reply(status, json);
        }
        if (url.includes('/api/local/admin/node-roles')) return reply(200, { roles });
        return reply(200, {});
    }));
    return sent;
}

async function render_(viewer: RolesViewer) {
    await act(async () => { render(<NodeRolesPanel activeNode={node} members={members} viewer={viewer} />); });
    await screen.findByTestId(`role-row-${BOB}`);
}

async function pressGrantCarolAdmin() {
    fireEvent.change(screen.getByLabelText(/Search by callsign/), { target: { value: 'car' } });
    await act(async () => { fireEvent.click(within(screen.getByRole('list', { name: 'Matching members' })).getByRole('button', { name: /carol/ })); });
    await act(async () => { fireEvent.click(screen.getByLabelText(/Admin/)); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Continue' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Yes, make carol an admin' })); });
}

async function pressRemoveBob() {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: "Remove bob's admin role" })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Yes, remove admin' })); });
}

async function enterCode(code: string) {
    fireEvent.change(await screen.findByTestId('roles-proof-input'), { target: { value: code } });
    await act(async () => { fireEvent.click(screen.getByTestId('roles-proof-confirm')); });
}

beforeEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });
afterEach(() => vi.unstubAllGlobals());

describe('NodeRolesPanel: the fresh proof (S4a)', () => {
    it('password viewer, grant: the box; a wrong code stays; a new code re-sends the same grant once with `code`', async () => {
        const sent = mockNode([[401, CODE_ASK], [401, WRONG], [200, { success: true }]]);
        await render_({ kind: 'password' });
        await pressGrantCarolAdmin();
        expect(await screen.findByText(/to change who is an owner or admin/)).toBeInTheDocument();
        await enterCode('111111');
        await waitFor(() => expect(screen.getByTestId('roles-proof-error')).toHaveTextContent('Invalid 2FA code'));
        expect(screen.getByTestId('roles-proof-confirm')).toBeDisabled();
        await enterCode('222222');
        expect(await screen.findByText('carol is now an admin.')).toBeInTheDocument();
        expect(screen.queryByTestId('roles-proof-code')).toBeNull();
        expect(sent.map((s) => [s.method, s.body.pubkey, s.body.role, s.body.code])).toEqual([
            ['POST', CAROL, 'admin', undefined], ['POST', CAROL, 'admin', '111111'], ['POST', CAROL, 'admin', '222222'],
        ]);
    });

    it('password viewer, remove: the box; the code travels as X-Fresh-Proof on the same DELETE', async () => {
        const sent = mockNode([[401, CODE_ASK], [200, { success: true }]]);
        await render_({ kind: 'password' });
        await pressRemoveBob();
        await enterCode('333333');
        expect(await screen.findByText('bob is no longer an admin.')).toBeInTheDocument();
        expect(sent.map((s) => [s.method, s.url.endsWith(`/node-roles/${BOB}/admin`), s.proof])).toEqual([['DELETE', true, undefined], ['DELETE', true, '333333']]);
    });

    it('phone viewer, hand-off stale, grant: the Manage-again sentence; one request; carol not shown as an admin', async () => {
        const sent = mockNode([[403, STEP_UP]]);
        await render_(OWNER_KEY);
        await pressGrantCarolAdmin();
        expect(await screen.findByTestId('roles-proof-step-up')).toHaveTextContent('Press Manage on your phone again');
        expect(screen.queryByTestId('roles-proof-input')).toBeNull();
        expect(sent).toHaveLength(1);
        expect(screen.queryByText('carol is now an admin.')).toBeNull();
    });

    it('computer viewer, remove: the from-your-phone sentence; one request; bob still listed', async () => {
        const sent = mockNode([[403, PHONE]]);
        await render_(OWNER_KEY);
        await pressRemoveBob();
        expect(await screen.findByTestId('roles-proof-phone')).toHaveTextContent('Do this from your phone');
        expect(sent).toHaveLength(1);
        expect(screen.getByTestId(`role-row-${BOB}`)).toBeInTheDocument();
    });
});
