import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PeerConnectorsPanel } from './PeerConnectorsPanel';
import { StandbyReplicationPanel } from './StandbyReplicationPanel';
import type { NodeProfile } from '../../lib/profiles';

/**
 * Owner-delete S4a (S2b D2's closing list): a `mirror` link's add, change, disconnect and remove (server community.ts) and
 * the server a standby copies from (server backup.ts replication-config/save) ask an owner's fresh proof. Each of the
 * three viewers × the server's refusal → the code box, the "Manage again" sentence or the "from your phone" sentence.
 */
const node: NodeProfile = { id: 'n1', name: 'Cairns', url: 'http://localhost:8080', adminPassword: 'pw' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const CODE_ASK = { error: 'Enter a current code from your authenticator app (or a backup code) to add or change a mirror link', totpRequired: true };
const WRONG = { error: 'That 2FA code was already used. Wait for the next one from your authenticator app.', totpRequired: true };
const STEP_UP = { error: 'Press Manage on your phone again, then make this change within 90 seconds.', code: 'step_up_required' };
const PHONE = { error: 'Do this from your phone: open BeanPool, press Manage, then make this change there.', code: 'phone_required', phoneRequired: true };
const MIRROR = { address: 'wss://main.example.org', trustLevel: 'mirror', callsign: 'Main', enabled: false };

function mockNode(path: string, answers: Array<[number, unknown]>, sent: Array<Record<string, unknown>>) {
    vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
        const u = new URL(String(url), 'http://localhost:8080').pathname;
        if (u.endsWith(path) && opts?.method === 'POST') {
            sent.push(JSON.parse(String(opts.body || '{}')));
            const [status, body] = answers[Math.min(sent.length - 1, answers.length - 1)];
            return json(status, body);
        }
        if (u.endsWith('/api/local/connectors')) return json(200, [MIRROR]);
        if (u.endsWith('/backup-status')) return json(200, { role: 'standby', primaryUrl: 'https://old.example.org' });
        if (u.endsWith('/replication-config/get')) return json(200, { hasToken: true });
        return json(200, {});
    });
}

async function addMirrorLink() {
    render(<PeerConnectorsPanel activeNode={node} />);
    fireEvent.change(await screen.findByLabelText(/Peer Address/i), { target: { value: 'wss://new-main.example.org' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Peer/i }));
}

async function saveCopySource() {
    render(<StandbyReplicationPanel activeNode={node} />);
    const url = await screen.findByLabelText(/Primary Node HTTPS URL/i);
    await waitFor(() => expect((url as HTMLInputElement).value).toBe('https://old.example.org'));
    fireEvent.change(url, { target: { value: 'https://new.example.org' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Connection/i }));
}

describe('PeerConnectorsPanel: a link the server guards asks the fresh proof (S4a)', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('password viewer: add opens the code box; a spent code says so and stays; a new code re-sends the same add once', async () => {
        const sent: Array<Record<string, unknown>> = [];
        mockNode('/api/local/connectors', [[401, CODE_ASK], [401, WRONG], [200, { success: true }]], sent);
        await addMirrorLink();
        fireEvent.change(await screen.findByTestId('connector-proof-input'), { target: { value: '111111' } });
        fireEvent.click(screen.getByTestId('connector-proof-confirm'));
        await waitFor(() => expect(screen.getByTestId('connector-proof-error')).toHaveTextContent('already used'));
        expect(screen.getByTestId('connector-proof-confirm')).toBeDisabled();
        fireEvent.change(screen.getByTestId('connector-proof-input'), { target: { value: '222222' } });
        fireEvent.click(screen.getByTestId('connector-proof-confirm'));
        await waitFor(() => expect(screen.queryByTestId('connector-proof-code')).not.toBeInTheDocument());
        expect(sent.map((b) => b.code)).toEqual([undefined, '111111', '222222']);
        expect(new Set(sent.map((b) => b.address))).toEqual(new Set(['wss://new-main.example.org']));
    });

    it('phone viewer, hand-off stale: adding a mirror link says press Manage on your phone again; nothing re-sent', async () => {
        const sent: Array<Record<string, unknown>> = [];
        mockNode('/api/local/connectors', [[403, STEP_UP]], sent);
        await addMirrorLink();
        expect(await screen.findByTestId('connector-proof-step-up')).toHaveTextContent('Press Manage on your phone again');
        expect(sent).toHaveLength(1);
    });

    it('computer viewer: disconnecting a mirror link says do this from your phone, and is not re-sent', async () => {
        const sent: Array<Record<string, unknown>> = [];
        mockNode('/api/local/connectors/remove', [[403, PHONE]], sent);
        render(<PeerConnectorsPanel activeNode={node} />);
        await screen.findByText('Main');
        const remove = screen.getAllByRole('button').find((b) => /remove/i.test(b.getAttribute('aria-label') || b.textContent || ''));
        expect(remove).toBeTruthy();
        fireEvent.click(remove!);
        const confirm = screen.getAllByRole('button').filter((b) => /remove/i.test(b.textContent || '')).pop()!;
        fireEvent.click(confirm);
        expect(await screen.findByTestId('connector-proof-phone')).toHaveTextContent('Do this from your phone');
        expect(screen.queryByTestId('connector-proof-input')).not.toBeInTheDocument();
        expect(sent).toHaveLength(1);
    });
});

describe('StandbyReplicationPanel: the server it copies from asks the fresh proof (S4a)', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('password viewer: the code box, then the same save re-sent once with the code', async () => {
        const sent: Array<Record<string, unknown>> = [];
        mockNode('/api/local/admin/replication-config/save', [[401, { ...CODE_ASK, error: 'Enter a current code from your authenticator app (or a backup code) to change which server this standby copies from' }], [200, { success: true }]], sent);
        await saveCopySource();
        expect(await screen.findByText(/to change which server this standby copies from/)).toBeInTheDocument();
        fireEvent.change(screen.getByTestId('standby-proof-input'), { target: { value: '123456' } });
        fireEvent.click(screen.getByTestId('standby-proof-confirm'));
        await waitFor(() => expect(screen.getByText(/saved successfully/)).toBeInTheDocument());
        expect(sent).toEqual([
            { password: 'pw', primaryUrl: 'https://new.example.org' },
            { password: 'pw', primaryUrl: 'https://new.example.org', code: '123456' },
        ]);
    });

    it('phone viewer, hand-off stale: the Manage-again sentence; nothing re-sent', async () => {
        const sent: Array<Record<string, unknown>> = [];
        mockNode('/api/local/admin/replication-config/save', [[403, STEP_UP]], sent);
        await saveCopySource();
        expect(await screen.findByTestId('standby-proof-step-up')).toBeInTheDocument();
        expect(sent).toHaveLength(1);
    });

    it('computer viewer: the from-your-phone sentence; nothing re-sent', async () => {
        const sent: Array<Record<string, unknown>> = [];
        mockNode('/api/local/admin/replication-config/save', [[403, PHONE]], sent);
        await saveCopySource();
        expect(await screen.findByTestId('standby-proof-phone')).toBeInTheDocument();
        expect(screen.queryByText(/Failed to save/)).not.toBeInTheDocument();
        expect(sent).toHaveLength(1);
    });
});
