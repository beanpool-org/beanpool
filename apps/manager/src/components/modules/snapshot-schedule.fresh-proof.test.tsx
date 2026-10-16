import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { ApplianceSection } from './ApplianceSection';
import type { NodeProfile } from '../../lib/profiles';
import * as nodeClient from '../../lib/node-client';

/**
 * Owner-delete S4a: keeping fewer snapshots, or turning them off, asks an owner's fresh proof (server backup.ts
 * snapshotsLessened); keeping more asks nothing. The node decides which, so the schedule is sent without a code first:
 * a raise goes through in one request, a lowering opens the box (or the sentence) and the SAME schedule is re-sent once
 * with the code.
 */
const node: NodeProfile = { id: 'n1', name: 'Riverbend', url: 'https://riverbend.example.org', adminPassword: 'pw' };
const NOW = { enabled: true, intervalHours: 24, keep: 7 };
const CODE_ASK = { error: 'Enter a current code from your authenticator app (or a backup code) to keep fewer snapshots, or make them cover less time', totpRequired: true };
const STEP_UP = { error: 'Press Manage on your phone again, then make this change within 90 seconds.', code: 'step_up_required' };
const PHONE = { error: 'Do this from your phone: open BeanPool, press Manage, then make this change there.', code: 'phone_required', phoneRequired: true };

function mockNode(answers: Array<[number, unknown]>) {
    const sent: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const reply = (status: number, json: unknown) => ({ ok: status >= 200 && status < 300, status, statusText: '', json: async () => json }) as Response;
        if (url.endsWith('/snapshots/config')) {
            const body = init?.body ? JSON.parse(String(init.body)) : {};
            sent.push(body);
            const [status, json] = answers[Math.min(sent.length - 1, answers.length - 1)];
            return reply(status, status === 200 ? { success: true, config: { enabled: body.enabled, intervalHours: body.intervalHours, keep: body.keep } } : json);
        }
        return reply(200, { updateAvailable: false, currentVersion: '1.4.2', connectors: [], enabled: false });
    }));
    return sent;
}

async function openBackups() {
    await act(async () => {
        render(
            <ApplianceSection activeNode={node} diag={null} gateway={null} gatewayLoading={false} gatewaySuccess={null} gatewaySaving={false}
                nodeLogs={[]} onChangeGateway={vi.fn()} onSaveGateway={vi.fn()} onRefreshDiag={vi.fn()} onRefreshLogs={vi.fn()}
                onDownloadBackup={vi.fn()} onRunLedgerAudit={vi.fn()} auditState={{ running: false, result: null }} initialSubTab="backups" />
        );
    });
    await screen.findByDisplayValue('Keep last 7 snapshots (1 week)');
}

const save = () => act(async () => { fireEvent.click(screen.getByRole('button', { name: /^save$/i })); });

beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
    vi.spyOn(nodeClient, 'fetchNodeSnapshots').mockResolvedValue([]);
    vi.spyOn(nodeClient, 'fetchNodeSnapshotSchedule').mockResolvedValue({ ...NOW });
});
afterEach(() => vi.unstubAllGlobals());

describe('Snapshot schedule: fewer kept or off asks the fresh proof (S4a)', () => {
    it('keeping more asks nothing: one request, no code, no box', async () => {
        const sent = mockNode([[200, {}]]);
        await openBackups();
        fireEvent.change(screen.getByDisplayValue('Keep last 7 snapshots (1 week)'), { target: { value: '14' } });
        await save();
        expect(await screen.findByText('Backup schedule updated successfully.')).toBeInTheDocument();
        expect(sent).toEqual([expect.objectContaining({ keep: 14 })]);
        expect(sent[0].code).toBeUndefined();
        expect(screen.queryByTestId('schedule-proof-code')).toBeNull();
    });

    it('password viewer, keeping fewer: the box; the code re-sends the same schedule once', async () => {
        const sent = mockNode([[401, CODE_ASK], [200, {}]]);
        await openBackups();
        fireEvent.change(screen.getByDisplayValue('Keep last 7 snapshots (1 week)'), { target: { value: '3' } });
        await save();
        expect(await screen.findByText(/to keep fewer snapshots/)).toBeInTheDocument();
        // The refusal is the box's to say, not a status line of its own.
        expect(screen.queryByText('Backup schedule updated successfully.')).toBeNull();
        fireEvent.change(screen.getByTestId('schedule-proof-input'), { target: { value: '246810' } });
        fireEvent.click(screen.getByTestId('schedule-proof-confirm'));
        expect(await screen.findByText('Backup schedule updated successfully.')).toBeInTheDocument();
        expect(sent.map((b) => [b.enabled, b.intervalHours, b.keep, b.code])).toEqual([[true, 24, 3, undefined], [true, 24, 3, '246810']]);
    });

    it('phone viewer, hand-off stale, turning them off: the Manage-again sentence; nothing re-sent', async () => {
        const sent = mockNode([[403, STEP_UP]]);
        await openBackups();
        fireEvent.click(screen.getByRole('checkbox', { name: /enable automated snapshots/i }));
        await save();
        expect(await screen.findByTestId('schedule-proof-step-up')).toHaveTextContent('Press Manage on your phone again');
        await waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0]).toMatchObject({ enabled: false });
    });

    it('computer viewer, keeping fewer: the from-your-phone sentence; nothing re-sent', async () => {
        const sent = mockNode([[403, PHONE]]);
        await openBackups();
        fireEvent.change(screen.getByDisplayValue('Keep last 7 snapshots (1 week)'), { target: { value: '3' } });
        await save();
        expect(await screen.findByTestId('schedule-proof-phone')).toHaveTextContent('Do this from your phone');
        expect(sent).toHaveLength(1);
    });

    it('Cancel in the box puts the node\'s schedule back in the form and says it was not saved (opus-2028 N5)', async () => {
        const sent = mockNode([[403, STEP_UP]]);
        await openBackups();
        fireEvent.click(screen.getByRole('checkbox', { name: /enable automated snapshots/i }));
        fireEvent.change(screen.getByDisplayValue('Keep last 7 snapshots (1 week)'), { target: { value: '3' } });
        await save();
        await screen.findByTestId('schedule-proof-step-up');
        expect(screen.getByText('Disabled')).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('schedule-proof-dismiss'));
        expect(screen.getByDisplayValue('Keep last 7 snapshots (1 week)')).toBeInTheDocument();
        expect(screen.getByRole('checkbox', { name: /enable automated snapshots/i })).toBeChecked();
        expect(screen.getByText('Active (24h)')).toBeInTheDocument();
        expect(screen.getByText("Not saved. The form shows the node's schedule again.")).toBeInTheDocument();
        expect(sent).toHaveLength(1);
    });
});
