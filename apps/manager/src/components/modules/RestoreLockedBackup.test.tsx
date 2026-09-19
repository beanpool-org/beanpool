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

    it('says who can open it and offers both ways', () => {
        stubFetch(() => ({ status: 500, body: {} }));
        render(<RestoreLockedBackup activeNode={node} file={file} backup={BACKUP} canUseCode canUsePhone onDone={vi.fn()} onCancel={vi.fn()} />);
        expect(screen.getByText(/It opens with: @anna, recovery code #1/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: "Open with an owner's phone" })).toBeInTheDocument();
        expect(screen.getByLabelText(/printed recovery code/)).toBeInTheDocument();
        for (const b of screen.getAllByRole('button')) expect(b.className).toMatch(/min-h-\[48px\]/);
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
        const calls = stubFetch(() => ({ status: 200, body: { success: true } }));
        const onDone = vi.fn();
        render(<RestoreLockedBackup activeNode={node} file={file} backup={BACKUP} canUseCode canUsePhone={false} onDone={onDone} onCancel={vi.fn()} />);
        expect(screen.queryByRole('button', { name: "Open with an owner's phone" })).toBeNull();
        fireEvent.change(screen.getByLabelText(/printed recovery code/), { target: { value: 'BPRC-1 ABCD' } });
        fireEvent.click(screen.getByRole('button', { name: 'Open with the code and restore' }));
        await waitFor(() => expect(onDone).toHaveBeenCalled());
        expect(calls[0].headers).toMatchObject({ 'X-Recovery-Code': 'BPRC-1 ABCD' });
    });
});
