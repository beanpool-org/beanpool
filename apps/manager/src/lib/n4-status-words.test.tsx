import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { fetchNodeSnapshotSchedule, updateNodeSnapshotSchedule, forceNodeResync, updateGatewayConfig } from './node-client';
import * as nodeClient from './node-client';
import { ApplianceSection } from '../components/modules/ApplianceSection';
import type { NodeProfile } from './profiles';

/**
 * opus-1984 N4: the screens in this lane that showed a bare HTTP status (the snapshot schedule, the fleet build's
 * resync, the gateway save) say what happened in words: the node's own sentence when it gave one, else what the status
 * means for the person. Reset and snapshot Delete are S4b's.
 */
const NODE = 'https://riverbend.example.org';

function answer(status: number, body: unknown) {
    vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: status >= 200 && status < 300, status, statusText: status === 404 ? 'Not Found' : status === 400 ? 'Bad Request' : 'Server Error',
        json: async () => { if (body === undefined) throw new Error('not json'); return body; },
    }) as unknown as Response));
}

beforeEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });
afterEach(() => vi.unstubAllGlobals());

describe('N4: no bare HTTP status (S4a)', () => {
    const calls: Array<[string, () => Promise<unknown>]> = [
        ['schedule read', () => fetchNodeSnapshotSchedule(NODE, 'pw')],
        ['schedule save', () => updateNodeSnapshotSchedule(NODE, { keep: 3 }, 'pw')],
        ['fleet resync', () => forceNodeResync(NODE, 'pw')],
        ['gateway save', () => updateGatewayConfig(NODE, {}, 'pw')],
    ];

    it.each(calls)('%s: the node\'s own sentence when it gives one', async (_, call) => {
        answer(400, { error: 'keep must be a whole number of snapshots from 3 to 14' });
        await expect(call()).rejects.toThrow('keep must be a whole number of snapshots from 3 to 14');
    });

    it.each(calls)('%s: without one, what the status means, never "HTTP <n>"', async (_, call) => {
        answer(500, undefined);
        await expect(call()).rejects.toThrow('The server had a problem. Nothing was changed. Try again in a minute.');
        answer(404, undefined);
        await expect(call()).rejects.toThrow('This server does not offer that any more. Update the server, then try again.');
        answer(403, {});
        await expect(call()).rejects.toThrow('Only an owner can make this change.');
        answer(400, {});
        await expect(call()).rejects.not.toThrow(/HTTP \d{3}/);
    });

    it('the backup schedule card says it in words when the node cannot be read', async () => {
        vi.spyOn(nodeClient, 'fetchNodeSnapshots').mockResolvedValue([]);
        answer(500, undefined);
        const node: NodeProfile = { id: 'n1', name: 'Riverbend', url: NODE, adminPassword: 'pw' };
        await act(async () => {
            render(
                <ApplianceSection activeNode={node} diag={null} gateway={null} gatewayLoading={false} gatewaySuccess={null} gatewaySaving={false}
                    nodeLogs={[]} onChangeGateway={vi.fn()} onSaveGateway={vi.fn()} onRefreshDiag={vi.fn()} onRefreshLogs={vi.fn()}
                    onDownloadBackup={vi.fn()} onRunLedgerAudit={vi.fn()} auditState={{ running: false, result: null }} initialSubTab="backups" />
            );
        });
        const said = await screen.findByText(/Couldn't read this node's backup schedule.*The server had a problem/);
        expect(said.textContent).not.toMatch(/HTTP \d{3}/);
    });
});
