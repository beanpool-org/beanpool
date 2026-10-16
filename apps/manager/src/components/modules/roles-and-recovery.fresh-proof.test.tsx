import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TakeoverLockPanel } from './TakeoverLockPanel';
import { grantNodeRoleApi, revokeNodeRoleApi, makeRecoveryCode } from '../../lib/node-client';
import { FreshProofRequiredError } from '../../lib/fresh-proof';
import type { NodeProfile } from '../../lib/profiles';

/**
 * Owner-delete S4a: replacing the recovery code (server A11) and granting or taking an owner's or admin's role (server
 * roleChangeProof) ask an owner's fresh proof. Each viewer × the server's refusal → the box or the sentence; the code
 * travels in `code` (POST) or X-Fresh-Proof (the DELETE, which has no body).
 */
const node: NodeProfile = { id: 'n1', name: 'Riverbend', url: 'https://riverbend.example.org', adminPassword: 'pw' };
const CODE_ASK = { error: 'Enter a current code from your authenticator app (or a backup code) to replace the recovery code', totpRequired: true };
const WRONG = { error: 'Invalid 2FA code', totpRequired: true };
const STEP_UP = { error: 'Press Manage on your phone again, then make this change within 90 seconds.', code: 'step_up_required' };
const PHONE = { error: 'Do this from your phone: open BeanPool, press Manage, then make this change there.', code: 'phone_required', phoneRequired: true };
const STATUS = {
    state: 'sealed', message: 'Locked.', envelopeId: 'e'.repeat(32), sealedAt: '2026-09-18T04:02:00.000Z', sealReason: 'x',
    recipients: { owners: [{ pubkey: 'a'.repeat(64), callsign: 'anna' }], codes: [{ codeId: 2, createdAt: '2026-09-10T00:00:00.000Z' }] },
    skippedOwners: [], recoveryCode: { codeId: 2, createdAt: '2026-09-10T00:00:00.000Z' },
};
const MADE = { code: 'BPRC-3  FAKE-C0DE-0000-1111-2222-3333-4444', codeId: 3, replacedCodeId: 2, status: STATUS };

function mockNode(answers: Array<[number, unknown]>, sent: Array<{ body: Record<string, unknown>; headers: Record<string, string> }>) {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const reply = (status: number, json: unknown) => ({ ok: status >= 200 && status < 300, status, statusText: '', json: async () => json }) as Response;
        if (url.endsWith('/takeover/recovery-code') || url.includes('/node-roles')) {
            sent.push({ body: init?.body ? JSON.parse(String(init.body)) : {}, headers: (init?.headers || {}) as Record<string, string> });
            const [status, json] = answers[Math.min(sent.length - 1, answers.length - 1)];
            return reply(status, json);
        }
        if (url.endsWith('/takeover/status')) return reply(200, STATUS);
        if (url.endsWith('/backup-status')) return reply(200, { backupLock: { locked: true, codeId: 2, message: 'Locked.' } });
        return reply(200, {});
    }));
}

async function pressReplace(viewer?: React.ComponentProps<typeof TakeoverLockPanel>['viewer']) {
    render(<TakeoverLockPanel activeNode={node} viewer={viewer} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Replace it' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make a new code' }));
}

beforeEach(() => { vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); });
afterEach(() => vi.unstubAllGlobals());

describe('TakeoverLockPanel: Replace asks the fresh proof (S4a)', () => {
    it('password viewer: the code box; a wrong code says so and stays; a new code re-sends the same replace once', async () => {
        const sent: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
        mockNode([[401, CODE_ASK], [401, WRONG], [200, MADE]], sent);
        await pressReplace();
        expect(await screen.findByText(/to replace the recovery code/)).toBeInTheDocument();
        fireEvent.change(screen.getByTestId('recovery-proof-input'), { target: { value: '111111' } });
        fireEvent.click(screen.getByTestId('recovery-proof-confirm'));
        await waitFor(() => expect(screen.getByTestId('recovery-proof-error')).toHaveTextContent('Invalid 2FA code'));
        expect(screen.getByTestId('recovery-proof-confirm')).toBeDisabled();
        fireEvent.change(screen.getByTestId('recovery-proof-input'), { target: { value: '222222' } });
        fireEvent.click(screen.getByTestId('recovery-proof-confirm'));
        await waitFor(() => expect(screen.queryByTestId('recovery-proof-code')).not.toBeInTheDocument());
        expect(sent.map((s) => [s.body.replace, s.body.code])).toEqual([[true, undefined], [true, '111111'], [true, '222222']]);
        expect(screen.queryByRole('alert', { name: /HTTP/ })).toBeNull();
    });

    it('phone viewer, hand-off stale: the Manage-again sentence, nothing re-sent', async () => {
        const sent: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
        mockNode([[403, STEP_UP]], sent);
        await pressReplace({ kind: 'key', memberPubkey: 'a'.repeat(64), role: 'owner' });
        expect(await screen.findByTestId('recovery-proof-step-up')).toHaveTextContent('Press Manage on your phone again');
        expect(sent).toHaveLength(1);
    });

    it('computer viewer: the from-your-phone sentence, nothing re-sent', async () => {
        const sent: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
        mockNode([[403, PHONE]], sent);
        await pressReplace({ kind: 'key', memberPubkey: 'a'.repeat(64), role: 'owner' });
        expect(await screen.findByTestId('recovery-proof-phone')).toHaveTextContent('Do this from your phone');
        expect(sent).toHaveLength(1);
    });
});

describe('node roles and the recovery code: how the proof travels (S4a)', () => {
    it('grant: `code` in the body; a refusal asking for it throws FreshProofRequiredError with the viewer\'s kind', async () => {
        const sent: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
        mockNode([[401, CODE_ASK], [403, PHONE], [403, STEP_UP], [200, { success: true }]], sent);
        await expect(grantNodeRoleApi(node.url, 'b'.repeat(64), 'admin', 'pw')).rejects.toMatchObject({ refusal: { kind: 'code' } });
        await expect(grantNodeRoleApi(node.url, 'b'.repeat(64), 'admin', 'pw')).rejects.toMatchObject({ refusal: { kind: 'phone' } });
        await expect(grantNodeRoleApi(node.url, 'b'.repeat(64), 'admin', 'pw')).rejects.toBeInstanceOf(FreshProofRequiredError);
        await grantNodeRoleApi(node.url, 'b'.repeat(64), 'admin', 'pw', undefined, '123456');
        expect(sent[0].body.code).toBeUndefined();
        expect(sent[3].body).toMatchObject({ pubkey: 'b'.repeat(64), role: 'admin', code: '123456' });
    });

    it('revoke: a DELETE with no body, so the code travels as X-Fresh-Proof', async () => {
        const sent: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
        mockNode([[401, CODE_ASK], [200, { success: true }]], sent);
        await expect(revokeNodeRoleApi(node.url, 'b'.repeat(64), 'owner', 'pw')).rejects.toMatchObject({ refusal: { kind: 'code' } });
        expect(sent[0].headers['X-Fresh-Proof']).toBeUndefined();
        await revokeNodeRoleApi(node.url, 'b'.repeat(64), 'owner', 'pw', undefined, '654321');
        expect(sent[1].headers['X-Fresh-Proof']).toBe('654321');
    });

    it('replace the recovery code: `code` in the body beside `replace`; an ordinary refusal still says the node\'s words', async () => {
        const sent: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
        mockNode([[409, { error: 'A recovery code already exists.' }], [200, MADE]], sent);
        await expect(makeRecoveryCode(node.url, true, 'pw')).rejects.toThrow('A recovery code already exists.');
        await makeRecoveryCode(node.url, true, 'pw', undefined, '999999');
        expect(sent[1].body).toMatchObject({ replace: true, code: '999999' });
    });
});
