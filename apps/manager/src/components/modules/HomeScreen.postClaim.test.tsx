/**
 * The one "what next" after claiming (DESIGN-new-operator-path-fable.md S6, Marty's decision 3, 9 Nov 2026): Settings Home's
 * Action required lists what an owner still has to do, each row opening the place it is done. Core settings has its row
 * already (HomeScreen.test.tsx, "Core settings"); this file covers the other two the design names: a recovery code
 * (Backups) and a second owner (People & Safety → Owners & admins), shown to owners only, and only while missing.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TakeoverStatus } from '../../lib/node-client';

// `status` is the answer; an Error is a read that fails, and PENDING a read that never answers.
const takeover = vi.hoisted(() => ({ status: null as unknown, calls: 0, PENDING: Symbol('pending') }));
vi.mock('../../lib/node-client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../lib/node-client')>()),
    fetchTakeoverStatus: vi.fn(() => {
        takeover.calls++;
        if (takeover.status === takeover.PENDING) return new Promise(() => {});
        if (takeover.status instanceof Error) return Promise.reject(takeover.status);
        return Promise.resolve(takeover.status);
    }),
}));
// A community shape Home reads itself (no `shape` prop) never answers here: the slow read of a standby's shape.
vi.mock('../../lib/community-shape', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../lib/community-shape')>()),
    fetchCommunityShape: vi.fn(() => new Promise(() => {})),
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
        // Shown once the take-over status says this is no standby (#3147 review, note 2).
        await screen.findByRole('button', { name: /One owner so far/ });
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

    // #3147's deciding review, note 2: the second-owner row trusted only the community shape's standby flag, so on a standby
    // whose shape read was slow or failed it said "One owner so far". It now goes by the take-over status's own standby
    // state, as the recovery-code row does.
    it('a standby whose community shape is slow or failed: no second-owner row, from the take-over status', async () => {
        takeover.status = status(null, 'standby');
        const { unmount } = render(<HomeScreen {...props} shape={null} activeNode={NODE} viewer={OWNER} nodeData={data(1) as any} onNavigate={vi.fn()} />);
        await waitFor(() => expect(takeover.calls).toBe(1));
        expect(screen.queryByRole('button', { name: /One owner so far/ })).toBeNull();
        unmount();

        // The shape is still on its way (undefined: Home reads it itself, and the read never answers).
        const pending = render(<HomeScreen {...props} shape={undefined} activeNode={NODE} viewer={OWNER} nodeData={data(1) as any} onNavigate={vi.fn()} />);
        await waitFor(() => expect(takeover.calls).toBe(2));
        expect(screen.queryByRole('button', { name: /One owner so far/ })).toBeNull();
        pending.unmount();
    });

    it('the take-over status not read (failed): no second-owner row either, as Home lists nothing it cannot back', async () => {
        takeover.status = new Error('offline');
        render(<HomeScreen {...props} activeNode={NODE} viewer={OWNER} nodeData={data(1) as any} onNavigate={vi.fn()} />);
        await waitFor(() => expect(takeover.calls).toBe(1));
        expect(screen.queryByRole('button', { name: /One owner so far/ })).toBeNull();
        // Nor All clear: the row was never checked (#3155 review).
        await waitFor(() => expect(screen.getByTestId('home-action-required')).toHaveTextContent(/Couldn't check the recovery code and the second owner/));
        expect(screen.getByTestId('home-action-required')).not.toHaveTextContent(/All clear/);
    });

    it('a main server whose take-over state is an error still gets the second-owner row (it is no standby)', async () => {
        takeover.status = status(null, 'error');
        render(<HomeScreen {...props} activeNode={NODE} viewer={OWNER} nodeData={data(1) as any} onNavigate={vi.fn()} />);
        expect(await screen.findByRole('button', { name: /One owner so far/ })).toBeInTheDocument();
        // An error state names no recovery code it can stand behind: no recovery-code row.
        expect(screen.queryByRole('button', { name: /No recovery code yet/ })).toBeNull();
    });

    // #3155's deciding review: with the owner rows behind the take-over status, a one-owner main server said "All clear"
    // until that read answered, and kept saying it when the read failed. A read not in yet, or failed, is unchecked like
    // the node's data and diagnostics: "Checking …" or "Couldn't check …", never All clear.
    describe('the take-over status not in yet, or failed: no All clear', () => {
        it('still loading: "Checking the recovery code and the second owner…", no All clear', async () => {
            takeover.status = takeover.PENDING;
            render(<HomeScreen {...props} activeNode={NODE} viewer={OWNER} nodeData={data(1) as any} onNavigate={vi.fn()} />);
            await waitFor(() => expect(takeover.calls).toBe(1));
            const panel = screen.getByTestId('home-action-required');
            expect(panel).not.toHaveTextContent(/All clear/);
            expect(panel).toHaveTextContent('Checking the recovery code and the second owner…');
        });

        it('failed: "Couldn\'t check" with the reason and a retry that reads it again; no All clear', async () => {
            takeover.status = new Error('offline');
            render(<HomeScreen {...props} activeNode={NODE} viewer={OWNER} nodeData={data(1) as any} onNavigate={vi.fn()} />);
            const panel = screen.getByTestId('home-action-required');
            await waitFor(() => expect(panel).toHaveTextContent("Couldn't check the recovery code and the second owner (offline)."));
            expect(panel).not.toHaveTextContent(/All clear/);
            // The retry reads the take-over status again; this time it answers, and the row it backs shows.
            takeover.status = status({ codeId: 1, createdAt: '2026-11-09T00:00:00.000Z' });
            fireEvent.click(screen.getByRole('button', { name: 'Retry the checks' }));
            await screen.findByRole('button', { name: /One owner so far/ });
            expect(takeover.calls).toBe(2);
            expect(panel).not.toHaveTextContent(/Couldn't check/);
            expect(panel).not.toHaveTextContent(/All clear/);
        });

        it('failed with two owners: only the recovery code is unchecked; no All clear', async () => {
            takeover.status = new Error('HTTP 502');
            render(<HomeScreen {...props} activeNode={NODE} viewer={OWNER} nodeData={data(2) as any} onNavigate={vi.fn()} />);
            const panel = screen.getByTestId('home-action-required');
            await waitFor(() => expect(panel).toHaveTextContent("Couldn't check the recovery code (HTTP 502)."));
            expect(panel).not.toHaveTextContent(/second owner/);
            expect(panel).not.toHaveTextContent(/All clear/);
        });

        it('an answer that names no recovery code (a server from before it): unchecked, update it; no All clear', async () => {
            takeover.status = { state: 'sealed', message: '' };
            render(<HomeScreen {...props} activeNode={NODE} viewer={OWNER} nodeData={data(2) as any} onNavigate={vi.fn()} />);
            const panel = screen.getByTestId('home-action-required');
            await waitFor(() => expect(panel).toHaveTextContent("Couldn't check the recovery code: this server doesn't send them yet, so update it."));
            expect(panel).not.toHaveTextContent(/All clear/);
        });

        it('a main server in the take-over error state: the recovery code unchecked, in the node\'s words; no All clear', async () => {
            takeover.status = { ...status(null, 'error'), message: 'The take-over keys could not be re-locked: disk full.' };
            render(<HomeScreen {...props} activeNode={NODE} viewer={OWNER} nodeData={data(2) as any} onNavigate={vi.fn()} />);
            const panel = screen.getByTestId('home-action-required');
            await waitFor(() => expect(panel).toHaveTextContent("Couldn't check the recovery code (The take-over keys could not be re-locked: disk full)."));
            expect(panel).not.toHaveTextContent(/All clear/);
        });

        it('a standby that answered: nothing unchecked, so All clear (its main server\'s owners do both)', async () => {
            takeover.status = status(null, 'standby');
            render(<HomeScreen {...props} activeNode={NODE} viewer={OWNER} nodeData={data(1) as any} onNavigate={vi.fn()} />);
            expect(await screen.findByText(/All clear/)).toBeInTheDocument();
            expect(screen.getByTestId('home-action-required')).not.toHaveTextContent(/Checking|Couldn't check/);
        });

        it('an admin reads no take-over status, so it holds nothing back', () => {
            render(<HomeScreen {...props} activeNode={NODE} viewer={ADMIN} nodeData={data(1) as any} onNavigate={vi.fn()} />);
            expect(screen.getByText(/All clear/)).toBeInTheDocument();
            expect(takeover.calls).toBe(0);
        });
    });
});
