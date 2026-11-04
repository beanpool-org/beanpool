import React from 'react';
import { render, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApplianceSection } from './ApplianceSection';
import type { NodeProfile } from '../../lib/profiles';
import HALL_READS from '../../lib/hall-reads.json';

/**
 * Lights-out (#2822): the node offers "Stand down" when the switch goes off only if nothing changed the hall copy, and
 * any POST, PUT, PATCH or DELETE it answers counts as a change unless the server names it (services/lights-out.ts
 * NOT_HALL_WRITES). So what Settings sends as it opens the Network tab (where the switch is) and the Backups tab is
 * recorded here, from the real tabs, and must be exactly lib/hall-reads.json; apps/server/src/test-lights-out.ts section 5
 * sends that same list through the node's real guard and holds it to the offer. A new write sent on opening fails here
 * first: add it to the list, and the server's test then asks for it to be a read the node names (or a GET).
 */
const node: NodeProfile = { id: 'hall', name: 'Riverbend', url: 'https://riverbend.example.org' };
const owner = { kind: 'key' as const, memberPubkey: 'a'.repeat(64), role: 'owner' as const };
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// The phone-screenshot harness's fake node (e2e/fixtures.mjs): a real-shaped answer to every request, so a card that
// sends its next request only after a real answer (a role, a status, a list) sends it here too.
const FAKE_NODE = '../../../e2e/fixtures.mjs';
type FakeNode = { mockResponse: (method: string, pathname: string, query: URLSearchParams, body: string) => { status: number; json: unknown } };

async function recordWrites() {
    const { mockResponse } = (await import(/* @vite-ignore */ FAKE_NODE)) as FakeNode;
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method || 'GET').toUpperCase();
        // A node reached through the fleet manager's proxy (/proxy/https/<host>/api/...) or directly: the node's own path.
        const u = new URL(String(url), 'http://settings.local');
        const p = u.pathname.slice(u.pathname.indexOf('/api/'));
        const body = init?.body ? String(init.body) : '';
        if (WRITE_METHODS.has(method)) sent.push(`${method} ${p}`);
        const answer = mockResponse(method, p, u.searchParams, body);
        return {
            ok: answer.status >= 200 && answer.status < 300, status: answer.status, statusText: '', headers: new Headers(),
            json: async () => answer.json, text: async () => JSON.stringify(answer.json),
        } as unknown as Response;
    }));
    return sent;
}

async function open(sub: 'network' | 'backups', isStandby: boolean) {
    await act(async () => {
        render(
            <ApplianceSection activeNode={node} diag={null} gateway={null} gatewayLoading={false} gatewaySuccess={null} gatewaySaving={false}
                nodeLogs={[]} onChangeGateway={vi.fn()} onSaveGateway={vi.fn()} onRefreshDiag={vi.fn()} onRefreshLogs={vi.fn()}
                onDownloadBackup={vi.fn()} onRunLedgerAudit={vi.fn()} auditState={{ running: false, result: null }} initialSubTab={sub}
                isStandby={isStandby} rolesViewer={owner} />
        );
    });
    // Each card's first answer can start its next read: let them all settle.
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

beforeEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });
afterEach(() => vi.unstubAllGlobals());

describe('what Settings sends as an owner opens it in the hall (lights-out stand-down offer)', () => {
    const views: Array<[keyof typeof HALL_READS.tabs, 'network' | 'backups', boolean]> = [
        ['network', 'network', false],
        ['backups', 'backups', false],
        ['backups on a standby', 'backups', true],
    ];
    it.each(views)('%s: exactly the list the node\'s test sends (hall-reads.json)', async (key, sub, isStandby) => {
        const sent = await recordWrites();
        await open(sub, isStandby);
        expect([...new Set(sent)].sort()).toEqual([...HALL_READS.tabs[key]].sort());
    });

    it('the schedule is read from snapshots/list, never from snapshots/config (which saves too)', () => {
        const all = Object.values(HALL_READS.tabs).flat();
        expect(all).toContain('POST /api/local/admin/snapshots/list');
        expect(all.filter((r) => r.includes('/snapshots/config'))).toEqual([]);
    });
});
