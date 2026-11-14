/**
 * The one "what next" after claiming (DESIGN-new-operator-path-fable.md S6, Marty's decision 3, 9 Nov 2026): Settings Home's
 * Action required lists what an owner still has to do, each row opening the place it is done. Core settings has its row
 * already (HomeScreen.test.tsx, "Core settings"); this file covers the other two the design names: a recovery code
 * (Backups) and a second owner (People & Safety → Owners & admins), shown to owners only, and only while missing.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TakeoverStatus } from '../../lib/node-client';

const takeover = vi.hoisted(() => ({ status: null as unknown, calls: 0 }));
vi.mock('../../lib/node-client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../lib/node-client')>()),
    fetchTakeoverStatus: vi.fn(async () => {
        takeover.calls++;
        if (takeover.status instanceof Error) throw takeover.status;
        return takeover.status;
    }),
}));

import { HomeScreen } from './HomeScreen';

const NODE = { id: 'n1', name: 'Riverside Exchange', url: 'https://riverside.example.org', token: 't' } as any;
const OWNER = { kind: 'key', memberPubkey: 'o', role: 'owner' } as const;
const ADMIN = { kind: 'key', memberPubkey: 'a', role: 'admin' } as const;
const LOCKED_SHAPE = {
    settings: { join: { value: 'members' }, beans: { value: true }, decisions: { value: true } },
    core: { lock: { at: '2026-11-03T10:00:00.000Z' } },
} as any;
const diag: any = { activeWsConnections: 1, dbSizeBytes: 1, walSizeBytes: 0, serverAlerts: { count: 0, items: [] } };
const counts = (owners: number) => ({ members: 3, treasuries: 1, doorMembers: 0, owners, platforms: { ios: 0, android: 1, web: 0, unknown: 2 } });
const data = (owners: number) => ({
    members: [], counts: counts(owners), reportCount: 0, escrowDisputesCount: 0,
    tradeTotals: { deals: 0, volume: 0, cancelled: 0 }, commonsBalance: 0,
});
const status = (recoveryCode: TakeoverStatus['recoveryCode'], state: TakeoverStatus['state'] = 'sealed'): TakeoverStatus => ({
    state, message: '', envelopeId: null, sealedAt: null, sealReason: null,
    recipients: { owners: [], codes: [] }, skippedOwners: [], recoveryCode,
});

const props = {
    communityName: 'Riverside Exchange',
    publicDomain: 'riverside.example.org',
    diag,
    onInviteMember: vi.fn(),
    onCreateEnterprise: vi.fn(),
    onDownloadBackup: vi.fn().mockResolvedValue(undefined),
    onRunLedgerAudit: vi.fn().mockResolvedValue(undefined),
    auditState: { running: false, result: { ok: true, drift: 0, sumBalances: 0 } },
    shape: LOCKED_SHAPE,
};

beforeEach(() => {
    takeover.status = status({ codeId: 1, createdAt: '2026-11-09T00:00:00.000Z' });
    takeover.calls = 0;
});

describe('Settings Home after the claim: the essentials on Action required', () => {
    it('one owner: "add a second owner", opening Owners & admins; All clear stays hidden', async () => {
        const onNavigate = vi.fn();
        render(<HomeScreen {...props} activeNode={NODE} viewer={OWNER} nodeData={data(1) as any} onNavigate={onNavigate} />);
        const panel = screen.getByTestId('home-action-required');
        expect(panel).toHaveTextContent('One owner so far · add a second owner, so a lost phone never locks the community out ›');
        expect(panel).not.toHaveTextContent(/All clear/);
        fireEvent.click(screen.getByRole('button', { name: /One owner so far/ }));
        expect(onNavigate).toHaveBeenCalledWith('people', 'roles', undefined);
    });

    it('two owners: no second-owner row, and All clear once the recovery code is read', async () => {
        render(<HomeScreen {...props} activeNode={NODE} viewer={OWNER} nodeData={data(2) as any} onNavigate={vi.fn()} />);
        await waitFor(() => expect(takeover.calls).toBe(1));
        expect(screen.queryByRole('button', { name: /One owner so far/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /No recovery code yet/ })).toBeNull();
        expect(screen.getByText(/All clear/)).toBeInTheDocument();
    });

    it('no recovery code: "make one", opening Backups', async () => {
        takeover.status = status(null);
        const onNavigate = vi.fn();
        render(<HomeScreen {...props} activeNode={NODE} viewer={OWNER} nodeData={data(2) as any} onNavigate={onNavigate} />);
        const row = await screen.findByRole('button', { name: /No recovery code yet/ });
        expect(row).toHaveTextContent('No recovery code yet · make one, so a backup can bring this community back on a new server ›');
        expect(screen.getByTestId('home-action-required')).not.toHaveTextContent(/All clear/);
        fireEvent.click(row);
        expect(onNavigate).toHaveBeenCalledWith('appliance', 'backups', undefined);
    });

    it('an admin is shown neither (both are owners\' to do), and the recovery code is not asked for', async () => {
        takeover.status = status(null);
        render(<HomeScreen {...props} activeNode={NODE} viewer={ADMIN} nodeData={data(1) as any} onNavigate={vi.fn()} />);
        expect(screen.queryByRole('button', { name: /One owner so far/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /No recovery code yet/ })).toBeNull();
        expect(takeover.calls).toBe(0);
    });

    it('a standby, a read that fails, or a server that sends no counts: no row it cannot back', async () => {
        takeover.status = status(null, 'standby');
        const { unmount } = render(<HomeScreen {...props} activeNode={NODE} viewer={OWNER} nodeData={data(2) as any} onNavigate={vi.fn()} />);
        await waitFor(() => expect(takeover.calls).toBe(1));
        expect(screen.queryByRole('button', { name: /No recovery code yet/ })).toBeNull();
        unmount();

        takeover.status = new Error('offline');
        const second = render(<HomeScreen {...props} activeNode={NODE} viewer={OWNER} nodeData={data(2) as any} onNavigate={vi.fn()} />);
        await waitFor(() => expect(takeover.calls).toBe(2));
        expect(screen.queryByRole('button', { name: /No recovery code yet/ })).toBeNull();
        second.unmount();

        const { counts: _none, ...noCounts } = data(1);
        render(<HomeScreen {...props} viewer={OWNER} nodeData={noCounts as any} onNavigate={vi.fn()} />);
        expect(screen.queryByRole('button', { name: /One owner so far/ })).toBeNull();
    });
});
