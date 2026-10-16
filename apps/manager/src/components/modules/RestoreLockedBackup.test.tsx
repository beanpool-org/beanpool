import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RestoreLockedBackup } from './RestoreLockedBackup';
import type { NodeProfile } from '../../lib/profiles';

const node: NodeProfile = { id: 'fresh', name: 'Fresh', url: 'https://fresh.example.org', adminPassword: 'fresh-pw' };
const file = new File([new Uint8Array([1, 2, 3])], 'beanpool-backup.bpsealed');
const BACKUP = { envelopeId: 'e'.repeat(32), createdAt: '2026-09-19T10:00:00.000Z', opensWith: '@anna, recovery code #1' };
const PHONE = {
    sessionId: 'p'.repeat(64), expiresAt: Date.now() + 600_000, qr: 'beanpool-unlock:v1?x', link: 'beanpool://unlock-keys?x',
    owners: ['@anna'], envelope: { envelopeId: 'e'.repeat(32), sealedAt: BACKUP.createdAt }, followToken: 'f'.repeat(64),
};

type Call = { path: string; headers: Record<string, string>; body: unknown };
function stubFetch(handler: (path: string, headers: Record<string, string>) => { status: number; body: unknown } | 'network') {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const path = url.replace(/^.*?\/api\//, '/api/');
        const headers = (init?.headers || {}) as Record<string, string>;
        calls.push({ path, headers, body: init?.body });
        const r = handler(path, headers);
        if (r === 'network') throw new TypeError('Failed to fetch');
        return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    }));
    return calls;
}

describe('RestoreLockedBackup', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('says who can open it and offers both ways', async () => {
        stubFetch(() => ({ status: 500, body: {} }));
        render(<RestoreLockedBackup activeNode={node} file={file} backup={BACKUP} canUseCode canUsePhone onDone={vi.fn()} onCancel={vi.fn()} />);
        expect(screen.getByText('@anna, recovery code #1')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: "Open with an owner's phone" })).toBeInTheDocument();
        expect(screen.getByLabelText(/printed recovery code/)).toBeInTheDocument();
        for (const b of screen.getAllByRole('button')) expect(b.className).toMatch(/min-h-\[48px\]/);
        await waitFor(() => expect(screen.getByTestId('restore-community').textContent).toContain('This server: could not be read'));
    });

    it('with a phone: re-sends the file asking for a phone, shows the QR, follows it with its token to "restored"', async () => {
        let restored = false;
        const calls = stubFetch((path) => {
            if (path === '/api/local/admin/restore') return { status: 202, body: { needsOwnerPhone: true, phone: PHONE, backup: BACKUP } };
            if (path === '/api/local/admin/restore/phone/wait') return { status: 200, body: restored ? { state: 'restored', unlockedBy: '@anna', result: { restoredKeys: true } } : { state: 'waiting' } };
            return { status: 404, body: {} };
        });
        const onDone = vi.fn();
        render(<RestoreLockedBackup activeNode={node} file={file} backup={BACKUP} canUseCode canUsePhone onDone={onDone} onCancel={vi.fn()} pollMs={20} />);
        fireEvent.click(screen.getByRole('button', { name: "Open with an owner's phone" }));
        await screen.findByTestId('owner-phone-unlock');
        const upload = calls.find((c) => c.path === '/api/local/admin/restore')!;
        expect(upload.headers).toMatchObject({ 'X-Unlock-With': 'phone', 'X-Unlock-Server-Url': 'https://fresh.example.org', 'X-Admin-Password': 'fresh-pw' });
        expect(upload.body).toBe(file);
        await waitFor(() => expect(calls.some((c) => c.path === '/api/local/admin/restore/phone/wait')).toBe(true));
        // Followed with the token, not the password: the restore brings back the community's password.
        expect(calls.find((c) => c.path === '/api/local/admin/restore/phone/wait')!.headers['X-Unlock-Follow']).toBe(PHONE.followToken);
        restored = true;
        await waitFor(() => expect(onDone).toHaveBeenCalledWith(expect.stringMatching(/opened by @anna's phone/)));
    });

    it('a server that goes quiet and comes back without the session has restarted with the backup: not a failure', async () => {
        let phase: 'quiet' | 'back' = 'quiet';
        stubFetch((path) => {
            if (path === '/api/local/admin/restore') return { status: 202, body: { phone: PHONE } };
            return phase === 'quiet' ? 'network' : { status: 401, body: { error: 'Unauthorized' } };
        });
        const onDone = vi.fn();
        render(<RestoreLockedBackup activeNode={node} file={file} backup={BACKUP} canUseCode={false} canUsePhone onDone={onDone} onCancel={vi.fn()} pollMs={20} />);
        fireEvent.click(screen.getByRole('button', { name: "Open with an owner's phone" }));
        expect(await screen.findByText(/The server is restarting with the restored backup/)).toBeInTheDocument();
        phase = 'back';
        await waitFor(() => expect(onDone).toHaveBeenCalledWith(expect.stringMatching(/restarted with the restored backup/)));
    });

    it('with the code: re-sends the file with the code', async () => {
        const calls = stubFetch((path) => path === '/api/local/admin/restore'
            ? { status: 200, body: { success: true, complete: true, images: { restored: 0, error: null, referenced: 0, missing: 0, missingKeys: [] }, restoredKeys: true,
                restorePointNote: 'Restore point 2026-10-16T02-30-00.123Z-before-restore is kept until at least 2026-10-23. You can roll back to it from Backups & Restore, or on the server with `beanpool restore-point roll-back 2026-10-16T02-30-00.123Z-before-restore`.',
                restartNote: 'The server restarts now; sign in again.' } }
            : { status: 404, body: {} });
        const onDone = vi.fn();
        render(<RestoreLockedBackup activeNode={node} file={file} backup={BACKUP} canUseCode canUsePhone={false} onDone={onDone} onCancel={vi.fn()} />);
        expect(screen.queryByRole('button', { name: "Open with an owner's phone" })).toBeNull();
        fireEvent.change(screen.getByLabelText(/printed recovery code/), { target: { value: 'BPRC-1 ABCD' } });
        fireEvent.click(screen.getByRole('button', { name: 'Open with the code and restore' }));
        await waitFor(() => expect(onDone).toHaveBeenCalled());
        expect(calls.find((c) => c.path === '/api/local/admin/restore')!.headers).toMatchObject({ 'X-Recovery-Code': 'BPRC-1 ABCD' });
        // After (design case 18 §3.4): the restore point it kept, the restart, and the backup's password.
        const said = onDone.mock.calls[0][0] as string;
        expect(said).toMatch(/^Backup restored\./);
        expect(said).toContain('Restore point 2026-10-16T02-30-00.123Z-before-restore is kept until at least 2026-10-23.');
        expect(said).toContain('The server restarts now; sign in again.');
        expect(said).toMatch(/admin password and two-factor sign-in it had when it was made/);
    });

    // The confirmation (design case 18 §3.4; the shell's prompt does the same, #2017): the file's community and the key that
    // locked it beside this server's own, what is lost, the restore point; and never a window confirm().
    const HERE = { communityId: 'c0ffee00c0ffee00', primaryPeerId: '12D3KooWThisServerXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' };
    it('shows the file\'s community and signer beside this server\'s, what is lost and the restore point, with no confirm()', async () => {
        const confirmSpy = vi.spyOn(window, 'confirm');
        const calls = stubFetch((path) => path === '/api/local/admin/backup-enroll' ? { status: 200, body: HERE } : { status: 404, body: {} });
        const mine = { ...BACKUP, communityId: HERE.communityId, sealedBy: HERE.primaryPeerId };
        render(<RestoreLockedBackup activeNode={node} file={file} backup={mine} canUseCode canUsePhone onDone={vi.fn()} onCancel={vi.fn()} />);
        expect(await screen.findByText("This community's backup, locked by this server.")).toBeInTheDocument();
        const community = screen.getByTestId('restore-community');
        expect(community.textContent).toContain(`This backup: ${HERE.communityId}`);
        expect(community.textContent).toContain(`This server: ${HERE.communityId}`);
        const signer = screen.getByTestId('restore-signer');
        expect(signer.textContent).toContain(`This backup: ${HERE.primaryPeerId}`);
        expect(signer.textContent).toContain(`This server: ${HERE.primaryPeerId}`);
        expect(screen.getByText(/beanpool-backup\.bpsealed, made/)).toBeInTheDocument();
        expect(screen.getByText(/will be lost\. A restore point is taken first/)).toBeInTheDocument();
        expect(calls.find((c) => c.path === '/api/local/admin/backup-enroll')!.headers).toMatchObject({ 'X-Admin-Password': 'fresh-pw' });
        // Nothing is sent to the restore route until a way to open it is chosen.
        expect(calls.some((c) => c.path === '/api/local/admin/restore')).toBe(false);
        expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('another community\'s file, or one locked by another machine, says so beside this server\'s', async () => {
        stubFetch((path) => path === '/api/local/admin/backup-enroll' ? { status: 200, body: HERE } : { status: 404, body: {} });
        const theirs = { ...BACKUP, communityId: 'beefbeefbeefbeef', sealedBy: '12D3KooWOtherMachineYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY' };
        const view = render(<RestoreLockedBackup activeNode={node} file={file} backup={theirs} canUseCode canUsePhone onDone={vi.fn()} onCancel={vi.fn()} />);
        expect(await screen.findByText(/A different community's backup\. Restoring it replaces the community on this server/)).toBeInTheDocument();
        expect(screen.getByTestId('restore-community').textContent).toContain('This server: c0ffee00c0ffee00');
        view.unmount();
        render(<RestoreLockedBackup activeNode={node} file={file} backup={{ ...theirs, communityId: HERE.communityId }} canUseCode canUsePhone onDone={vi.fn()} onCancel={vi.fn()} />);
        expect(await screen.findByText("This community's backup, locked by another machine.")).toBeInTheDocument();
    });

    it('when this server\'s own IDs cannot be read, it says so and claims no match', async () => {
        stubFetch((path) => path === '/api/local/admin/backup-enroll' ? { status: 503, body: { error: 'Genesis not initialized yet' } } : { status: 404, body: {} });
        render(<RestoreLockedBackup activeNode={node} file={file} backup={{ ...BACKUP, communityId: HERE.communityId, sealedBy: HERE.primaryPeerId }} canUseCode canUsePhone onDone={vi.fn()} onCancel={vi.fn()} />);
        await waitFor(() => expect(screen.getByTestId('restore-community').textContent).toContain('This server: could not be read'));
        expect(screen.queryByTestId('restore-verdict')).toBeNull();
    });
});
