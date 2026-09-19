import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { TakeoverLockPanel, printInstructions } from './TakeoverLockPanel';
import type { NodeProfile } from '../../lib/profiles';
import type { TakeoverStatus } from '../../lib/node-client';

// A FAKE code in the real printed shape (every letter is a Crockford character). Never a real one.
const FAKE_CODE = 'BPRC-3  FAKE-C0DE-0000-1111-2222-3333-4444';
const FAKE_GROUP = 'C0DE';

const node: NodeProfile = { id: 'n1', name: 'Riverbend node', url: 'https://riverbend.example.org', adminPassword: 'pw-fixture' };

const SEALED: TakeoverStatus = {
    state: 'sealed',
    message: "This server's take-over keys are locked to 2 owners and recovery code #2; any one of them can open them.",
    envelopeId: 'e'.repeat(32),
    sealedAt: '2026-09-18T04:02:00.000Z',
    sealReason: 'owner role granted',
    recipients: {
        owners: [{ pubkey: 'a'.repeat(64), callsign: 'anna' }, { pubkey: 'b'.repeat(64), callsign: 'ben' }],
        codes: [{ codeId: 2, createdAt: '2026-09-10T00:00:00.000Z' }],
    },
    skippedOwners: [],
    recoveryCode: { codeId: 2, createdAt: '2026-09-10T00:00:00.000Z' },
};
const NO_CODE: TakeoverStatus = {
    ...SEALED,
    message: "This server's take-over keys are locked to 2 owners; any one of them can open them.",
    recipients: { owners: SEALED.recipients.owners, codes: [] },
    recoveryCode: null,
};
const LOCKED = { locked: true, codeId: 2, message: 'Backups are locked to recovery code #2 and 2 owners.' };
const NOT_LOCKED = { locked: false, reason: 'no-recovery-code', message: 'Backups are not locked yet: make a recovery code to lock them.' };

type Reply = { status?: number; json: unknown } | (() => { status?: number; json: unknown });
function mockNode(routes: Record<string, Reply>) {
    const calls: { url: string; body: string }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: String(init?.body ?? '') });
        const key = Object.keys(routes).find((k) => url.endsWith(k));
        const r = key ? routes[key] : { status: 404, json: { error: 'Not found' } };
        const { status = 200, json } = typeof r === 'function' ? r() : r;
        return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => json } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, calls };
}

const statusRoute = '/api/local/admin/takeover/status';
const backupRoute = '/api/local/admin/backup-status';
const makeRoute = '/api/local/admin/takeover/recovery-code';
const checkRoute = '/api/local/admin/takeover/recovery-code/check';

beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe('TakeoverLockPanel — the status', () => {
    it('locked: owners by callsign, the code by number, when it was last re-locked, and backups locked', async () => {
        mockNode({ [statusRoute]: { json: SEALED }, [backupRoute]: { json: { role: 'primary', backupLock: LOCKED } } });
        render(<TakeoverLockPanel activeNode={node} />);
        const state = await screen.findByTestId('takeover-state');
        await waitFor(() => expect(state).toHaveTextContent('Locked.'));
        expect(state).toHaveTextContent(/locked to 2 owners and recovery code #2/);
        const list = screen.getByTestId('takeover-recipients');
        expect(within(list).getByText(/@anna/)).toBeInTheDocument();
        expect(within(list).getByText(/@ben/)).toBeInTheDocument();
        expect(within(list).getByText(/Recovery code #2/)).toBeInTheDocument();
        expect(screen.getByTestId('takeover-sealed-at')).toHaveTextContent(/Last re-locked .*2026.*\(owner role granted\)/);
        await waitFor(() => expect(screen.getByTestId('backup-lock')).toHaveTextContent('🔒 Backups are locked to recovery code #2 and 2 owners.'));
        expect(screen.getByTestId('recovery-code-line')).toHaveTextContent(/Recovery code #2, made .*2026/);
    });

    it('not locked yet: says why, and that backups are not locked', async () => {
        mockNode({
            [statusRoute]: { json: { ...NO_CODE, state: 'no-recipients', envelopeId: null, sealedAt: null, recipients: { owners: [], codes: [] },
                message: 'No take-over envelope: this server has no owner and no recovery code, so there is nobody to lock its keys to. Make someone an owner, or make a recovery code.' } },
            [backupRoute]: { json: { backupLock: NOT_LOCKED } },
        });
        render(<TakeoverLockPanel activeNode={node} />);
        await waitFor(() => expect(screen.getByTestId('takeover-state')).toHaveTextContent(/Not locked yet\..*no owner and no recovery code/));
        expect(screen.queryByTestId('takeover-recipients')).toBeNull();
        await waitFor(() => expect(screen.getByTestId('backup-lock')).toHaveTextContent('🔓 Backups are not locked yet'));
        expect(screen.getByTestId('recovery-code-line')).toHaveTextContent('No printed recovery code.');
        expect(screen.getByRole('button', { name: 'Make a recovery code' })).toBeInTheDocument();
    });

    it('error: shows the node\'s reason in red, never "Locked"', async () => {
        mockNode({
            [statusRoute]: { json: { ...SEALED, state: 'error', message: 'The take-over keys could not be re-locked: disk full.' } },
            [backupRoute]: { json: { backupLock: LOCKED } },
        });
        render(<TakeoverLockPanel activeNode={node} />);
        await waitFor(() => expect(screen.getByTestId('takeover-state')).toHaveTextContent('Error. The take-over keys could not be re-locked: disk full.'));
        expect(screen.getByTestId('takeover-state')).not.toHaveTextContent('Locked.');
    });

    it('the node cannot be read: says so; an old node says it is too old', async () => {
        mockNode({ [statusRoute]: { status: 500, json: { error: 'boom' } }, [backupRoute]: { status: 500, json: {} } });
        const { unmount } = render(<TakeoverLockPanel activeNode={node} />);
        await waitFor(() => expect(screen.getByTestId('takeover-state')).toHaveTextContent('Could not read who can unlock this community: boom.'));
        await waitFor(() => expect(screen.getByTestId('backup-lock')).toHaveTextContent('did not say whether its backups are locked'));
        expect(screen.queryByRole('button', { name: /recovery code|Replace it/ })).toBeNull();
        unmount();
        mockNode({ [backupRoute]: { json: {} } }); // no status route at all
        render(<TakeoverLockPanel activeNode={node} />);
        await waitFor(() => expect(screen.getByTestId('takeover-state')).toHaveTextContent('too old'));
    });

    it('standby: says to make the code on the main server, and shows no code actions', async () => {
        mockNode({
            [statusRoute]: { json: { ...NO_CODE, state: 'standby', envelopeId: null, message: 'This is a standby: it holds no take-over keys of its own.' } },
            [backupRoute]: { json: { role: 'backup', backupLock: NOT_LOCKED } },
        });
        render(<TakeoverLockPanel activeNode={node} />);
        await waitFor(() => expect(screen.getByTestId('takeover-state')).toHaveTextContent(/standby.*main server/));
        expect(screen.queryByRole('button', { name: 'Make a recovery code' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Check a code' })).toBeNull();
    });

    it('names an owner left out of the lock', async () => {
        mockNode({
            [statusRoute]: { json: { ...SEALED, skippedOwners: [{ pubkey: 'c'.repeat(64), callsign: 'cleo', why: 'the key is not a usable Ed25519 public key' }] } },
            [backupRoute]: { json: { backupLock: LOCKED } },
        });
        render(<TakeoverLockPanel activeNode={node} />);
        expect(await screen.findByText(/@cleo is an owner but is not in the lock: the key is not a usable Ed25519 public key/)).toBeInTheDocument();
    });
});

describe('TakeoverLockPanel — who sees the code actions', () => {
    it('an admin (key sign-in) sees the status but not make, replace or check', async () => {
        mockNode({ [statusRoute]: { json: SEALED }, [backupRoute]: { json: { backupLock: LOCKED } } });
        render(<TakeoverLockPanel activeNode={node} viewer={{ kind: 'key', memberPubkey: 'd'.repeat(64), role: 'admin' }} />);
        await waitFor(() => expect(screen.getByTestId('takeover-state')).toHaveTextContent('Locked.'));
        expect(screen.getByTestId('takeover-recipients')).toHaveTextContent('@anna');
        expect(screen.queryByRole('button', { name: 'Replace it' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Make a recovery code' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Check a code' })).toBeNull();
        expect(screen.getByTestId('owners-only-note')).toHaveTextContent('Only an owner can make, replace or check the recovery code.');
    });

    it('an admin with no code yet cannot make one either', async () => {
        mockNode({ [statusRoute]: { json: NO_CODE }, [backupRoute]: { json: { backupLock: NOT_LOCKED } } });
        render(<TakeoverLockPanel activeNode={node} viewer={{ kind: 'key', memberPubkey: 'd'.repeat(64), role: 'admin' }} />);
        await waitFor(() => expect(screen.getByTestId('recovery-code-line')).toHaveTextContent('No printed recovery code.'));
        expect(screen.queryByRole('button', { name: 'Make a recovery code' })).toBeNull();
    });

    it('an owner (key sign-in) and the admin password see them', async () => {
        mockNode({ [statusRoute]: { json: SEALED }, [backupRoute]: { json: { backupLock: LOCKED } } });
        const { unmount } = render(<TakeoverLockPanel activeNode={node} viewer={{ kind: 'key', memberPubkey: 'a'.repeat(64), role: 'owner' }} />);
        expect(await screen.findByRole('button', { name: 'Replace it' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Check a code' })).toBeInTheDocument();
        unmount();
        render(<TakeoverLockPanel activeNode={node} viewer={{ kind: 'password' }} />);
        expect(await screen.findByRole('button', { name: 'Replace it' })).toBeInTheDocument();
    });
});

describe('TakeoverLockPanel — the code, once', () => {
    it('shows the code once, keeps it out of every storage and log, and drops it when the card closes', async () => {
        const setItem = vi.spyOn(Storage.prototype, 'setItem');
        const idbOpen = vi.fn();
        vi.stubGlobal('indexedDB', { open: idbOpen, deleteDatabase: vi.fn() });
        const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
        let status = NO_CODE;
        const { calls } = mockNode({
            [statusRoute]: () => ({ json: status }),
            [backupRoute]: () => ({ json: { backupLock: status.recoveryCode ? LOCKED : NOT_LOCKED } }),
            [makeRoute]: () => {
                status = { ...SEALED, recoveryCode: { codeId: 3, createdAt: '2026-09-20T01:00:00.000Z' } };
                return { json: { success: true, code: FAKE_CODE, codeId: 3, createdAt: '2026-09-20T01:00:00.000Z', replacedCodeId: null, status } };
            },
        });
        render(<TakeoverLockPanel activeNode={node} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Make a recovery code' }));

        const dialog = await screen.findByRole('dialog', { name: 'Recovery code #3' });
        const shownCode = within(dialog).getByTestId('recovery-code');
        expect(shownCode).toHaveTextContent('BPRC-3');
        expect(shownCode).toHaveTextContent(/FAKE-C0DE-0000-1111-2222-3333-4444/);
        expect(within(dialog).getByText(/It is shown once/)).toBeInTheDocument();

        // Done waits for the tickbox; a stray Escape does not throw the code away.
        const done = within(dialog).getByRole('button', { name: 'Done' });
        expect(done).toBeDisabled();
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.getByRole('dialog', { name: 'Recovery code #3' })).toBeInTheDocument();
        fireEvent.click(within(dialog).getByRole('checkbox', { name: /I've printed it or written it down/ }));
        expect(done).toBeEnabled();
        fireEvent.click(done);

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        // Gone from the page, and the card now shows only its number.
        expect(document.body.textContent).not.toContain(FAKE_GROUP);
        await waitFor(() => expect(screen.getByTestId('recovery-code-line')).toHaveTextContent('Recovery code #3'));
        expect(screen.queryByTestId('recovery-code')).toBeNull();

        // Never stored or logged, and sent nowhere: only the create response carried it.
        const inArgs = (args: unknown[][]) => args.some((a) => JSON.stringify(a).includes(FAKE_GROUP));
        expect(inArgs(setItem.mock.calls)).toBe(false);
        expect(idbOpen).not.toHaveBeenCalled();
        for (const l of logs) expect(inArgs(l.mock.calls)).toBe(false);
        for (const s of [localStorage, sessionStorage]) {
            for (let i = 0; i < s.length; i++) expect(String(s.getItem(s.key(i)!))).not.toContain(FAKE_GROUP);
        }
        expect(JSON.stringify(window.history.state ?? null)).not.toContain(FAKE_GROUP);
        expect(calls.some((c) => c.body.includes(FAKE_GROUP) || c.url.includes(FAKE_GROUP))).toBe(false);
        expect(calls.filter((c) => c.url.endsWith(makeRoute))).toHaveLength(1);
    });

    it('the ✕ closes it without the tickbox, and the code is gone', async () => {
        mockNode({
            [statusRoute]: { json: NO_CODE }, [backupRoute]: { json: { backupLock: NOT_LOCKED } },
            [makeRoute]: { json: { success: true, code: FAKE_CODE, codeId: 3, createdAt: '2026-09-20T01:00:00.000Z', replacedCodeId: null, status: SEALED } },
        });
        render(<TakeoverLockPanel activeNode={node} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Make a recovery code' }));
        await screen.findByRole('dialog', { name: 'Recovery code #3' });
        fireEvent.click(screen.getByRole('button', { name: 'Close recovery code' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(document.body.textContent).not.toContain(FAKE_GROUP);
    });

    it('the print view: the code, the community, the date and the instructions; Print prints', async () => {
        const print = vi.fn();
        vi.stubGlobal('print', print);
        mockNode({
            [statusRoute]: { json: NO_CODE }, [backupRoute]: { json: { backupLock: NOT_LOCKED } },
            [makeRoute]: { json: { success: true, code: FAKE_CODE, codeId: 3, createdAt: '2026-09-20T01:00:00.000Z', replacedCodeId: null, status: SEALED } },
        });
        render(<TakeoverLockPanel activeNode={node} communityName="Riverbend Commons" />);
        fireEvent.click(await screen.findByRole('button', { name: 'Make a recovery code' }));
        fireEvent.click(await screen.findByRole('button', { name: /Print$/ }));
        const sheet = await screen.findByTestId('print-sheet');
        expect(within(sheet).getByText('BeanPool recovery code #3')).toBeInTheDocument();
        expect(within(sheet).getByTestId('print-community')).toHaveTextContent('Riverbend Commons');
        expect(sheet).toHaveTextContent(/Made .*2026/);
        expect(within(sheet).getByTestId('recovery-code')).toHaveTextContent(/BPRC-3.*FAKE-C0DE-0000-1111-2222-3333-4444/);
        const madeOn = within(sheet).getByText(/^Made /).textContent!.replace(/^Made /, '');
        for (const line of printInstructions(3, madeOn)) expect(sheet).toHaveTextContent(line);
        expect(sheet).toHaveTextContent(/what the code is for|only if every owner has lost their phone/);
        expect(sheet).toHaveTextContent(/Type it where the server asks/);
        fireEvent.click(within(sheet).getByRole('button', { name: /Print this page/ }));
        expect(print).toHaveBeenCalledTimes(1);
        // Closing the print view returns to the code; closing that drops both.
        fireEvent.click(within(sheet).getByRole('button', { name: 'Close print view' }));
        expect(screen.getByRole('dialog', { name: 'Recovery code #3' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Close recovery code' }));
        await waitFor(() => expect(screen.queryByTestId('print-sheet')).toBeNull());
        expect(document.body.textContent).not.toContain(FAKE_GROUP);
    });

    it('the print view falls back to the node name without a community name', async () => {
        mockNode({
            [statusRoute]: { json: NO_CODE }, [backupRoute]: { json: { backupLock: NOT_LOCKED } },
            [makeRoute]: { json: { success: true, code: FAKE_CODE, codeId: 3, createdAt: '2026-09-20T01:00:00.000Z', replacedCodeId: null, status: SEALED } },
        });
        render(<TakeoverLockPanel activeNode={node} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Make a recovery code' }));
        fireEvent.click(await screen.findByRole('button', { name: /Print$/ }));
        expect(await screen.findByTestId('print-community')).toHaveTextContent('Riverbend node');
    });

    it('replacing warns that old backups stay locked to the old code as well as the owners, then asks with replace', async () => {
        const { calls } = mockNode({
            [statusRoute]: { json: SEALED }, [backupRoute]: { json: { backupLock: LOCKED } },
            [makeRoute]: { json: { success: true, code: FAKE_CODE, codeId: 3, createdAt: '2026-09-20T01:00:00.000Z', replacedCodeId: 2, status: SEALED } },
        });
        render(<TakeoverLockPanel activeNode={node} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Replace it' }));
        const warn = await screen.findByRole('dialog', { name: 'Replace recovery code #2?' });
        expect(warn).toHaveTextContent('Backups made before now stay locked to the old code #2 as well as the owners.');
        expect(warn).toHaveTextContent('Keep the old paper until those backups are destroyed.');
        expect(calls.some((c) => c.url.endsWith(makeRoute))).toBe(false);
        fireEvent.click(within(warn).getByRole('button', { name: 'Make a new code' }));
        const shown = await screen.findByRole('dialog', { name: 'Recovery code #3' });
        expect(shown).toHaveTextContent('Code #2 no longer opens anything locked from now on.');
        const made = calls.filter((c) => c.url.endsWith(makeRoute));
        expect(made).toHaveLength(1);
        expect(JSON.parse(made[0].body).replace).toBe(true);
    });

    it('a refusal (a code already exists, a standby) shows the node\'s words and no code', async () => {
        mockNode({
            [statusRoute]: { json: NO_CODE }, [backupRoute]: { json: { backupLock: NOT_LOCKED } },
            [makeRoute]: { status: 409, json: { error: 'This server is a standby: it seals nothing, so a recovery code made here would open nothing. Make the code in the main server\'s Settings.', standby: true } },
        });
        render(<TakeoverLockPanel activeNode={node} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Make a recovery code' }));
        expect(await screen.findByRole('alert')).toHaveTextContent(/standby.*main server/);
        expect(screen.queryByRole('dialog')).toBeNull();
    });
});

describe('TakeoverLockPanel — check a code', () => {
    async function openCheck(reply: Reply) {
        const env = mockNode({ [statusRoute]: { json: SEALED }, [backupRoute]: { json: { backupLock: LOCKED } }, [checkRoute]: reply });
        render(<TakeoverLockPanel activeNode={node} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Check a code' }));
        const dialog = await screen.findByRole('dialog', { name: 'Check a recovery code' });
        fireEvent.change(within(dialog).getByLabelText('Recovery code'), { target: { value: FAKE_CODE } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Check' }));
        return { dialog, ...env };
    }

    it('true: says the paper is right', async () => {
        const { dialog, calls } = await openCheck({ json: { matches: true, codeId: 2 } });
        await waitFor(() => expect(within(dialog).getByTestId('check-result')).toHaveTextContent('✓ Yes — this is recovery code #2. Your paper is right.'));
        expect(JSON.parse(calls.find((c) => c.url.endsWith(checkRoute))!.body).code).toBe(FAKE_CODE);
    });

    it('false: says it does not match', async () => {
        const { dialog } = await openCheck({ json: { matches: false, codeId: 2 } });
        await waitFor(() => expect(within(dialog).getByTestId('check-result')).toHaveTextContent('✗ No — this does not match recovery code #2.'));
    });

    it('a typo: the node\'s words, before any guess counts', async () => {
        const { dialog } = await openCheck({ status: 400, json: { error: 'That code has a typo: check what you typed.', typo: true } });
        await waitFor(() => expect(within(dialog).getByTestId('check-result')).toHaveTextContent('✗ That code has a typo: check what you typed.'));
    });

    it('closing clears what was typed', async () => {
        const { dialog } = await openCheck({ json: { matches: true, codeId: 2 } });
        await waitFor(() => expect(within(dialog).getByTestId('check-result')).toBeInTheDocument());
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close check a code' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        fireEvent.click(screen.getByRole('button', { name: 'Check a code' }));
        const again = await screen.findByRole('dialog', { name: 'Check a recovery code' });
        expect((within(again).getByLabelText('Recovery code') as HTMLInputElement).value).toBe('');
    });
});
