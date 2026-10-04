import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RetirePasswordPanel, RETIRE_CONFIRM_WORD } from './RetirePasswordPanel';
import { AdminLoginCard } from '../auth/AdminLoginCard';
import type { NodeProfile } from '../../lib/profiles';
import { fetchClaimState } from '../../lib/node-claim';

vi.mock('../../lib/node-claim', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../lib/node-claim')>()),
    fetchClaimState: vi.fn(async () => ({ kind: 'claimed' })),
    fetchCommunityInfo: vi.fn(async () => ({ primaryAddress: null, addresses: [] })),
}));

const node: NodeProfile = { id: 'local-node', name: 'Mullumbimby Node', url: 'http://localhost:8080', adminPassword: '' };
const OWNER_KEY = { kind: 'key', memberPubkey: 'o'.repeat(64), role: 'owner' } as const;
const ADMIN_KEY = { kind: 'key', memberPubkey: 'a'.repeat(64), role: 'admin' } as const;

type Call = { url: string; init?: RequestInit };

/** A fake node: GET answers `state.view`; POST retire answers `retire` (default: retired by Olive). */
function fakeNode(state: { view: Record<string, unknown>; retire?: { status: number; body: unknown } }) {
    const calls: Call[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith('/api/local/admin/auth/password-retirement')) {
            return new Response(JSON.stringify(state.view), { status: 200 });
        }
        if (url.endsWith('/api/local/admin/auth/retire-password')) {
            const r = state.retire ?? { status: 200, body: { success: true, passwordRetired: true, retiredAt: Date.UTC(2026, 9, 4), retiredByCallsign: 'Olive', owners: 1, hasBreakGlassCode: true } };
            return new Response(JSON.stringify(r.body), { status: r.status });
        }
        if (url.endsWith('/api/local/status')) {
            return new Response(JSON.stringify(state.view), { status: 200 });
        }
        return new Response('{}', { status: 200 });
    });
    return calls;
}

const notRetired = (over: Record<string, unknown> = {}) => ({ passwordRetired: false, retiredAt: null, retiredByCallsign: null, owners: 1, hasBreakGlassCode: true, ...over });

describe('RetirePasswordPanel', () => {
    beforeEach(() => { vi.restoreAllMocks(); });
    afterEach(() => { vi.restoreAllMocks(); });

    it('is not drawn for an admin', () => {
        fakeNode({ view: notRetired() });
        const { container } = render(<RetirePasswordPanel activeNode={node} viewer={ADMIN_KEY} />);
        expect(container.innerHTML).toBe('');
    });

    it('says what stays, and a password session is told to sign in with the phone', async () => {
        fakeNode({ view: notRetired({ hasBreakGlassCode: null }) });
        render(<RetirePasswordPanel activeNode={node} viewer={{ kind: 'password' }} />);
        expect(await screen.findByText(/What stays:/)).toBeInTheDocument();
        expect(screen.getByText(/beanpool recover/, { selector: 'code' })).toBeInTheDocument();
        expect(screen.getByText(/Only an owner signed in with their phone can retire it/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Retire the admin password/ })).toBeNull();
    });

    it('sends an owner with no break-glass code to make one first', async () => {
        fakeNode({ view: notRetired({ hasBreakGlassCode: false }) });
        render(<RetirePasswordPanel activeNode={node} viewer={OWNER_KEY} />);
        expect(await screen.findByText(/Make your break-glass code first/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Retire the admin password/ })).toBeNull();
    });

    it('needs the one-owner tick and the typed word, then sends acceptOneOwner and shows who retired it', async () => {
        const calls = fakeNode({ view: notRetired() });
        render(<RetirePasswordPanel activeNode={node} viewer={OWNER_KEY} />);
        const button = await screen.findByRole('button', { name: /Retire the admin password/ });
        expect(button).toBeDisabled();
        fireEvent.change(screen.getByLabelText(/Type RETIRE to confirm/), { target: { value: RETIRE_CONFIRM_WORD } });
        expect(button).toBeDisabled();
        fireEvent.click(screen.getByRole('checkbox', { name: /I accept one owner/ }));
        expect(button).not.toBeDisabled();
        fireEvent.click(button);
        expect(await screen.findByTestId('retired-line')).toHaveTextContent(/Retired on .*2026 by Olive/);
        const post = calls.find(c => c.url.endsWith('/retire-password'));
        expect(JSON.parse(String(post?.init?.body))).toEqual({ acceptOneOwner: true });
    });

    it('with two owners there is no tick and none is sent', async () => {
        const calls = fakeNode({ view: notRetired({ owners: 2 }) });
        render(<RetirePasswordPanel activeNode={node} viewer={OWNER_KEY} />);
        const button = await screen.findByRole('button', { name: /Retire the admin password/ });
        expect(screen.queryByRole('checkbox')).toBeNull();
        fireEvent.change(screen.getByLabelText(/Type RETIRE to confirm/), { target: { value: 'retire' } });
        expect(button).toBeDisabled();
        fireEvent.change(screen.getByLabelText(/Type RETIRE to confirm/), { target: { value: RETIRE_CONFIRM_WORD } });
        fireEvent.click(button);
        await waitFor(() => expect(calls.some(c => c.url.endsWith('/retire-password'))).toBe(true));
        expect(JSON.parse(String(calls.find(c => c.url.endsWith('/retire-password'))?.init?.body))).toEqual({});
    });

    it('shows the node\'s refusal', async () => {
        fakeNode({ view: notRetired({ owners: 2 }), retire: { status: 403, body: { error: 'step_up_required: press Manage again' } } });
        render(<RetirePasswordPanel activeNode={node} viewer={OWNER_KEY} />);
        const button = await screen.findByRole('button', { name: /Retire the admin password/ });
        fireEvent.change(screen.getByLabelText(/Type RETIRE to confirm/), { target: { value: RETIRE_CONFIRM_WORD } });
        fireEvent.click(button);
        expect(await screen.findByRole('alert')).toHaveTextContent(/not retired: step_up_required/);
    });

    it('once retired shows the date and callsign, and no button', async () => {
        fakeNode({ view: { passwordRetired: true, retiredAt: Date.UTC(2026, 9, 3), retiredByCallsign: 'Olive', owners: 2, hasBreakGlassCode: true } });
        render(<RetirePasswordPanel activeNode={node} viewer={OWNER_KEY} />);
        expect(await screen.findByTestId('retired-line')).toHaveTextContent(/Retired on .*2026 by Olive/);
        expect(screen.queryByRole('button')).toBeNull();
    });
});

describe('AdminLoginCard on a node whose password is retired', () => {
    beforeEach(() => { vi.restoreAllMocks(); });
    afterEach(() => { vi.restoreAllMocks(); });

    it('shows no password field, only the phone sign-in', async () => {
        fakeNode({ view: {} });
        vi.mocked(fetchClaimState).mockResolvedValueOnce({ kind: 'claimed', password: false, retired: true });
        render(<AdminLoginCard nodeUrl="http://localhost:8080" onPasswordSession={vi.fn()} onKeySession={vi.fn()} />);
        expect(await screen.findByTestId('password-retired-signin')).toBeInTheDocument();
        expect(screen.queryByPlaceholderText('Password')).toBeNull();
        expect(screen.queryByRole('button', { name: /Unlock Settings/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /Use the password/ })).toBeNull();
    });

    it('keeps the password form on a node that still has one', async () => {
        fakeNode({ view: {} });
        render(<AdminLoginCard nodeUrl="http://localhost:8080" onPasswordSession={vi.fn()} onKeySession={vi.fn()} />);
        await waitFor(() => expect(vi.mocked(fetchClaimState)).toHaveBeenCalled());
        expect(screen.getByPlaceholderText('Password')).toBeInTheDocument();
        expect(screen.queryByTestId('password-retired-signin')).toBeNull();
    });
});
