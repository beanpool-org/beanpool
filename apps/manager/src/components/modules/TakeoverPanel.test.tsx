import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { TakeoverPanel, type TakeoverPreview, type TakeoverProgressData } from './TakeoverPanel';
import type { NodeProfile } from '../../lib/profiles';

const node: NodeProfile = { id: 'standby-1', name: 'Standby', url: 'https://standby.example.org', adminPassword: 'standby-own-pw' };

const MISSING = ['Decisions and their votes', 'enterprise pledges and keeper changes', 'invites', "members' notification settings"];
const STEPS = ['opened', 'undo-copy', 'identity-files', 'admin-settings', 'roles', 'public-address', 'role', 'pull-config', 'restart', 'audit', 'announcement', 'reseal', 'tunnel', 'done'];

function progress(state: TakeoverProgressData['state'], doneUpTo = -1, extra: Partial<TakeoverProgressData> = {}): TakeoverProgressData {
    return {
        role: state === 'complete' ? 'primary' : 'backup',
        state,
        startedAt: state === 'none' ? null : '2026-09-20T01:00:00.000Z',
        completedAt: state === 'complete' ? '2026-09-20T01:00:09.000Z' : null,
        authorisedBy: state === 'none' ? null : 'recovery code #1',
        peerId: state === 'none' ? null : '12D3KooWMainServerPeerIdThatIsQuiteLongIndeed',
        sealedAt: null,
        steps: STEPS.map((step, i) => ({ step, label: `Label ${step}`, done: i <= doneUpTo, at: null, detail: i <= doneUpTo ? `detail ${step}` : null })),
        error: null,
        result: state === 'complete'
            ? { roles: { written: 2, owners: ['@Anna'], skipped: [] }, audit: { ok: true, drift: 0, strandedEscrows: 0 }, tunnel: { source: 'older-envelope', message: 'The newest keys had no tunnel token, so it came from the copy locked earlier.' } }
            : null,
        missing: MISSING,
        afterwards: ["Sign in to this server's Settings with the community's admin password or an owner's key. This standby's own admin password no longer works."],
        codeUsed: state === 'complete' ? { codeId: 1, at: '2026-09-20T01:00:00.000Z', message: 'Your recovery code #1 was used to take over on 2026-09-20. Make a new one.' } : null,
        ...extra,
    };
}

const PREVIEW: TakeoverPreview = {
    sessionId: 's'.repeat(64),
    expiresAt: Date.now() + 600_000,
    envelope: { envelopeId: 'e'.repeat(32), sealedAt: '2026-09-19T10:00:00.000Z', codeId: 1, newerCopiesSkipped: 0 },
    communityId: 'abcd1234abcd1234',
    peerId: '12D3KooWMainServerPeerIdThatIsQuiteLongIndeed',
    owners: ['@Anna'],
    admins: 1,
    connectors: 2,
    publicAddress: 'riverbend.beanpool.org',
    tunnel: { source: 'envelope', message: 'The tunnel token came with the keys.' },
    mainServer: { url: 'https://riverbend.beanpool.org', answers: false, lastCopyAt: Date.parse('2026-09-19T12:00:00Z'), warning: null },
    missing: MISSING,
    afterwards: [],
};

type Handler = (body: any, headers: Record<string, string>) => { status: number; body: any } | 'network';

function stubFetch(handlers: Record<string, Handler>) {
    const calls: { path: string; body: any; headers: Record<string, string> }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        // Settings reaches another node through its /proxy/<scheme>/<host>/ path; the route is what matters here.
        const path = url.replace(/^.*?\/api\//, '/api/').replace(/\?.*$/, '');
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const headers = (init?.headers || {}) as Record<string, string>;
        calls.push({ path, body, headers });
        const h = handlers[path];
        const r = h ? h(body, headers) : { status: 404, body: {} };
        if (r === 'network') throw new TypeError('Failed to fetch');
        return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    });
    vi.stubGlobal('fetch', fetchMock);
    return calls;
}

describe('TakeoverPanel', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        sessionStorage.clear();
    });

    it('is not shown on a main server that never took over', async () => {
        stubFetch({ '/api/local/admin/takeover/progress': () => ({ status: 200, body: progress('none') }) });
        const { container } = render(<TakeoverPanel activeNode={node} isStandby={false} />);
        await waitFor(() => expect(container.querySelector('#takeover-panel')).toBeNull());
    });

    it('a main server another took over from says so: replaced, read-only, and where it saw it', async () => {
        stubFetch({
            '/api/local/admin/takeover/progress': () => ({
                status: 200,
                body: {
                    ...progress('none'), role: 'primary',
                    replaced: {
                        epoch: 1, ownEpoch: 0, since: '2026-09-20T01:00:00.000Z', detectedAt: '2026-09-21T08:00:00.000Z',
                        url: 'https://riverbend.beanpool.org/api/node/identity-epoch',
                        message: 'This server was replaced on 2026-09-20. It is now read-only.',
                    },
                },
            }),
        });
        render(<TakeoverPanel activeNode={node} isStandby={false} pollMs={60_000} />);
        const alert = await screen.findByText(/This server was replaced on 2026-09-20\. It is now read-only\./);
        const box = alert.closest('#takeover-replaced') as HTMLElement;
        expect(box).not.toBeNull();
        expect(box.textContent).toContain('riverbend.beanpool.org');
        expect(box.textContent).toContain("Don't run this server as the main server again");
        expect(screen.queryByRole('button', { name: 'Take over as the main server' })).toBeNull();
    });

    it('two confirms: the explanation with what will be missing, then the code, then the preview and "Take over now"', async () => {
        const calls = stubFetch({
            // After the confirm the screen follows with the progress token.
            '/api/local/admin/takeover/progress': (_b, headers) => ({ status: 200, body: headers['X-Takeover-Progress'] ? progress('restarting', 8) : progress('none') }),
            '/api/local/admin/takeover/open': (body) => body.code === 'BPRC-1 RIGHT'
                ? { status: 200, body: { success: true, preview: PREVIEW } }
                : { status: 403, body: { error: 'That is not recovery code #1. Check the paper and try again.', wrongCode: true } },
            '/api/local/admin/takeover/confirm': () => ({ status: 200, body: { success: true, progressToken: 'a'.repeat(64), progress: progress('restarting', 8) } }),
        });
        render(<TakeoverPanel activeNode={node} isStandby pollMs={60_000} />);

        fireEvent.click(await screen.findByRole('button', { name: 'Take over as the main server' }));
        const dialog = screen.getByRole('dialog');
        expect(within(dialog).getByText('Take over as the main server?')).toBeInTheDocument();
        expect(within(dialog).getByText(/Do this only if the main server is really gone/)).toBeInTheDocument();
        const missing = dialog.querySelector('#takeover-missing')!;
        for (const m of MISSING) expect(within(missing as HTMLElement).getByText(m)).toBeInTheDocument();
        expect(within(dialog).getByText(/this standby's own password stops working/)).toBeInTheDocument();
        expect(calls.some((c) => c.path.endsWith('/open'))).toBe(false);

        fireEvent.click(within(dialog).getByRole('button', { name: 'I understand, continue' }));
        const input = screen.getByLabelText(/The recovery code on the paper/);
        fireEvent.change(input, { target: { value: 'BPRC-1 WRONG' } });
        fireEvent.click(screen.getByRole('button', { name: 'Open the keys' }));
        expect(await screen.findByText(/That is not recovery code #1/)).toBeInTheDocument();

        fireEvent.change(input, { target: { value: 'BPRC-1 RIGHT' } });
        fireEvent.click(screen.getByRole('button', { name: 'Open the keys' }));
        const pv = await screen.findByText(/Identity kept:/);
        expect(pv.textContent).toContain(PREVIEW.peerId);
        expect(screen.getByText(/Owners: @Anna; admins: 1/)).toBeInTheDocument();
        expect(screen.getByText(/Links with other communities: 2/)).toBeInTheDocument();
        expect(screen.getByText(/riverbend.beanpool.org. The tunnel token came with the keys/)).toBeInTheDocument();
        expect(screen.getByText(/The main server does not answer/)).toBeInTheDocument();
        expect(screen.getByText('It will not have:')).toBeInTheDocument();

        // The last confirm needs the tickbox.
        const takeOver = screen.getByRole('button', { name: 'Take over now' });
        expect(takeOver).toBeDisabled();
        fireEvent.click(screen.getByLabelText(/The main server is gone, and nobody will start it again/));
        expect(takeOver).not.toBeDisabled();
        fireEvent.click(takeOver);

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        const confirmCall = calls.find((c) => c.path.endsWith('/confirm'))!;
        expect(confirmCall.body).toMatchObject({ sessionId: PREVIEW.sessionId, confirm: true });
        expect(await screen.findByText('Taking over…')).toBeInTheDocument();
        expect(sessionStorage.getItem('bp-takeover-progress:standby-1')).toBe('a'.repeat(64));
    });

    it('says the server is restarting while it does not answer, then shows the true result with the progress token', async () => {
        sessionStorage.setItem('bp-takeover-progress:standby-1', 'b'.repeat(64));
        let phase: 'down' | 'done' = 'down';
        const calls = stubFetch({
            '/api/local/admin/takeover/progress': (_b, headers) => {
                if (headers['X-Takeover-Progress'] !== 'b'.repeat(64)) return { status: 401, body: { error: 'Unauthorized' } };
                return phase === 'down' ? 'network' : { status: 200, body: progress('complete', 13) };
            },
        });
        render(<TakeoverPanel activeNode={node} isStandby={false} pollMs={20} />);
        // The first answer is a network failure: nothing is claimed.
        await waitFor(() => expect(calls.length).toBeGreaterThan(0));
        expect(screen.queryByText(/is now the community's main server/)).toBeNull();

        phase = 'done';
        expect(await screen.findByText(/This server is now the community's main server/)).toBeInTheDocument();
        expect(screen.getByText('The ledger adds up.')).toBeInTheDocument();
        expect(screen.getByText(/came from the copy locked earlier/)).toBeInTheDocument();
        expect(screen.getByText(/This standby's own admin password no longer works/)).toBeInTheDocument();
        expect(screen.getByRole('alert').textContent).toContain('Make a new one');
        const steps = document.querySelectorAll('[data-step]');
        expect(steps).toHaveLength(14);
        expect([...steps].every((s) => s.getAttribute('data-done') === 'yes')).toBe(true);
        // Polling stops at the result.
        const n = calls.length;
        await new Promise((r) => setTimeout(r, 100));
        expect(calls.length).toBe(n);
    });

    it('shows a stopped take-over plainly, naming the step', async () => {
        sessionStorage.setItem('bp-takeover-progress:standby-1', 'c'.repeat(64));
        stubFetch({
            '/api/local/admin/takeover/progress': () => ({
                status: 200,
                body: progress('failed', 3, { error: { step: 'roles', label: "Brought back the community's owners and admins", message: 'disk full' } }),
            }),
        });
        render(<TakeoverPanel activeNode={node} isStandby pollMs={60_000} />);
        expect(await screen.findByText(/The take-over stopped/)).toBeInTheDocument();
        expect(screen.getByRole('alert').textContent).toContain('disk full');
        expect(screen.queryByRole('button', { name: 'Take over as the main server' })).toBeNull();
    });

    it('the explanation still lists what will be missing when the progress call failed', async () => {
        stubFetch({ '/api/local/admin/takeover/progress': () => 'network' });
        render(<TakeoverPanel activeNode={node} isStandby pollMs={60_000} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Take over as the main server' }));
        expect(screen.getByText('invites')).toBeInTheDocument();
        expect(screen.getByText('Decisions and their votes')).toBeInTheDocument();
    });
});

describe("TakeoverPanel — with an owner's phone (sealed keys slice 6)", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        sessionStorage.clear();
    });

    const PHONE = {
        success: true, sessionId: 'p'.repeat(64), expiresAt: Date.now() + 600_000,
        qr: 'beanpool-unlock:v1?u=https%3A%2F%2Fstandby.example.org&s=' + 'p'.repeat(64),
        link: 'beanpool://unlock-keys?u=https%3A%2F%2Fstandby.example.org&s=' + 'p'.repeat(64),
        owners: ['@Anna'], envelope: { envelopeId: 'e'.repeat(32), sealedAt: '2026-09-19T10:00:00.000Z' },
    };

    it('shows the QR, waits for the phone, then the same preview and confirm as the code', async () => {
        let unlocked = false;
        const calls = stubFetch({
            '/api/local/admin/takeover/progress': () => ({ status: 200, body: progress('none') }),
            '/api/local/admin/takeover/phone/start': () => ({ status: 200, body: PHONE }),
            '/api/local/admin/takeover/phone/wait': () => unlocked
                ? { status: 200, body: { state: 'unlocked', unlockedBy: '@Anna', preview: { ...PREVIEW, openedBy: "@Anna's phone", envelope: { ...PREVIEW.envelope, codeId: null } } } }
                : { status: 200, body: { state: 'waiting', expiresAt: PHONE.expiresAt } },
            '/api/local/admin/takeover/confirm': () => ({ status: 200, body: { success: true, progressToken: 'd'.repeat(64), progress: progress('restarting', 8) } }),
        });
        render(<TakeoverPanel activeNode={node} isStandby pollMs={20} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Take over as the main server' }));
        expect(screen.getByText(/or with any one owner's phone/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: "I understand: use an owner's phone" }));

        const qr = await screen.findByTestId('owner-phone-unlock');
        expect(within(qr).getByAltText("Code for an owner's phone")).toBeInTheDocument();
        expect(within(qr).getByText('@Anna')).toBeInTheDocument();
        expect(within(qr).getByText(PHONE.link)).toBeInTheDocument();
        const start = calls.find((c) => c.path.endsWith('/phone/start'))!;
        expect(start.body).toMatchObject({ serverUrl: 'https://standby.example.org' });
        await waitFor(() => expect(calls.filter((c) => c.path.endsWith('/phone/wait')).length).toBeGreaterThan(1));
        expect(calls.find((c) => c.path.endsWith('/phone/wait'))!.body).toMatchObject({ sessionId: PHONE.sessionId });

        unlocked = true;
        expect(await screen.findByText(/opened by @Anna's phone/)).toBeInTheDocument();
        fireEvent.click(screen.getByLabelText(/The main server is gone, and nobody will start it again/));
        fireEvent.click(screen.getByRole('button', { name: 'Take over now' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(calls.find((c) => c.path.endsWith('/confirm'))!.body).toMatchObject({ sessionId: PREVIEW.sessionId, confirm: true });
    });

    it('says when the code ran out, offers a new one, and cancels the session on close', async () => {
        const calls = stubFetch({
            '/api/local/admin/takeover/progress': () => ({ status: 200, body: progress('none') }),
            '/api/local/admin/takeover/phone/start': () => ({ status: 200, body: PHONE }),
            '/api/local/admin/takeover/phone/wait': () => ({ status: 200, body: { state: 'expired' } }),
            '/api/local/admin/unlock/cancel': () => ({ status: 200, body: { success: true } }),
        });
        render(<TakeoverPanel activeNode={node} isStandby pollMs={20} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Take over as the main server' }));
        fireEvent.click(screen.getByRole('button', { name: "I understand: use an owner's phone" }));
        expect(await screen.findByText(/The code ran out before a phone used it/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Make a new code' })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Make a new code' }));
        await screen.findByTestId('owner-phone-unlock');
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(calls.some((c) => c.path.endsWith('/unlock/cancel'))).toBe(true));
    });

    it('a standby whose keys are locked to the code only says so', async () => {
        stubFetch({
            '/api/local/admin/takeover/progress': () => ({ status: 200, body: progress('none') }),
            '/api/local/admin/takeover/phone/start': () => ({ status: 409, body: { error: 'The take-over keys this standby holds are locked to the recovery code only.', noOwnerStanza: true } }),
        });
        render(<TakeoverPanel activeNode={node} isStandby pollMs={20} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Take over as the main server' }));
        fireEvent.click(screen.getByRole('button', { name: "I understand: use an owner's phone" }));
        expect(await screen.findByText(/locked to the recovery code only/)).toBeInTheDocument();
    });
});
