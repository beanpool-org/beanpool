import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OffboxBackupsPanel } from './OffboxBackupsPanel';
import type { NodeProfile } from '../../lib/profiles';
import type { OffboxStatus, OffboxDestinationStatus } from '../../lib/node-client';

const node: NodeProfile = { id: 'node-1', name: 'Node', url: 'https://node.example.com', adminPassword: 'pw-owner' };

function dest(over: Partial<OffboxDestinationStatus>): OffboxDestinationStatus {
    return {
        id: 'env-1', name: 'R2', source: 'env', endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'bp-backups', region: 'auto',
        prefix: '', accessKeyId: 'AKID…01', secretSet: true, problems: [], health: 'ok', lastSuccessAt: Date.UTC(2026, 9, 1, 2), lastSuccessBytes: 5_000_000,
        lastAttemptAt: Date.UTC(2026, 9, 1, 2), lastError: null, failures: 0, nextAttemptAt: Date.UTC(2026, 9, 2, 2), lastPruneAt: null, lastPruneError: null,
        ...over,
    };
}

function status(over: Partial<OffboxStatus>): OffboxStatus {
    return {
        state: 'sending', message: 'Locked backups go off the box every 24 hours to 2 destinations, each kept 30 days.',
        intervalHours: 24, intervalFrom: 'default', retentionDays: 30, retentionFrom: 'default', maxRetentionDays: 30, maxIntervalHours: 168,
        running: false, destinations: [], ...over,
    };
}

const json = (body: unknown, ok = true, status = 200) => ({ ok, status, statusText: '', json: async () => body });

describe('OffboxBackupsPanel', () => {
    beforeEach(() => { vi.restoreAllMocks(); });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('shows a loading state indicator while status request is pending', async () => {
        let resolveFetch!: (val: any) => void;
        const pendingPromise = new Promise((resolve) => { resolveFetch = resolve; });
        vi.stubGlobal('fetch', vi.fn(() => pendingPromise));
        render(<OffboxBackupsPanel activeNode={node} />);
        expect(screen.getByTestId('offbox-loading')).toHaveTextContent('Loading backup settings…');
        resolveFetch(json(status({})));
        await waitFor(() => expect(screen.queryByTestId('offbox-loading')).toBeNull());
    });

    it('says in words why nothing goes off the box without a recovery code, and offers no "send now"', async () => {
        const words = 'Nothing goes off the box: this server has no recovery code, so its backups are not locked, and only a locked backup may leave the server.';
        vi.stubGlobal('fetch', vi.fn(async () => json(status({ state: 'not-locked', message: words, destinations: [dest({ health: 'waiting', lastSuccessAt: null })] }))));
        render(<OffboxBackupsPanel activeNode={node} />);
        expect(await screen.findByTestId('offbox-message')).toHaveTextContent(words);
        expect(screen.queryByRole('button', { name: 'Send one now' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Add a destination' })).toBeInTheDocument();
    });

    it("shows each destination's state, a failing one's error, sends one now, lists and downloads", async () => {
        const failing = dest({ id: 'd-0011223344', name: 'Outside', source: 'settings', health: 'failing', failures: 2, lastError: 'bucket "x" at s3.example: PUT failed after 3 tries: HTTP 503' });
        const calls: { url: string; body: any }[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
            const body = init?.body ? JSON.parse(String(init.body)) : null;
            calls.push({ url: String(url), body });
            if (String(url).includes('/offbox-backups/status')) return json(status({ destinations: [dest({}), failing] }));
            if (String(url).includes('/offbox-backups/run')) return json({ started: true, status: status({ destinations: [dest({}), failing], running: true }) });
            if (String(url).includes('/offbox-backups/list')) {
                return json({ destination: 'env-1', backups: [{ key: 'c0ffee/beanpool-backup-2026-10-01T02-00-00.bpsealed', community: 'c0ffee', file: 'beanpool-backup-2026-10-01T02-00-00.bpsealed', madeAt: Date.UTC(2026, 9, 1, 2), bytes: 5_000_000, ours: true }] });
            }
            if (String(url).includes('/offbox-backups/download')) {
                return { ok: true, status: 200, headers: new Headers({ 'content-disposition': 'attachment; filename="beanpool-backup-2026-10-01T02-00-00.bpsealed"' }), blob: async () => new Blob(['x']) };
            }
            return json({});
        }));
        const createObjectURL = vi.fn(() => 'blob:x');
        vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
        const user = userEvent.setup();
        render(<OffboxBackupsPanel activeNode={node} />);
        const row = await screen.findByTestId('offbox-destination-d-0011223344');
        expect(row).toHaveTextContent('Failing');
        expect(row).toHaveTextContent('HTTP 503');
        expect(screen.getByTestId('offbox-destination-env-1')).toHaveTextContent('Working');
        expect(screen.getByTestId('offbox-destination-env-1')).toHaveTextContent('set in .env');
        // A destination from .env is changed in .env only.
        expect(within(screen.getByTestId('offbox-destination-env-1')).queryByRole('button', { name: 'Remove' })).toBeNull();

        await user.click(screen.getByRole('button', { name: 'Send one now' }));
        await waitFor(() => expect(calls.some((c) => c.url.includes('/offbox-backups/run'))).toBe(true));
        expect(await screen.findByRole('button', { name: 'Sending…' })).toBeDisabled();

        await user.click(within(screen.getByTestId('offbox-destination-env-1')).getByRole('button', { name: 'Show backups' }));
        const list = await screen.findByTestId('offbox-backup-list');
        await user.click(within(list).getByRole('button', { name: 'Download' }));
        await waitFor(() => expect(calls.some((c) => c.url.includes('/offbox-backups/download') && c.url.includes('destination=env-1')
            && c.url.includes(encodeURIComponent('c0ffee/beanpool-backup-2026-10-01T02-00-00.bpsealed')))).toBe(true));
    });

    it('adds a destination with its secret, never shows the secret again, and a change sends neither the key id nor the secret', async () => {
        const SECRET = 'super-SECRET-value-123';
        let current = status({ destinations: [] });
        const posted: any[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
            const body = init?.body ? JSON.parse(String(init.body)) : null;
            if (String(url).includes('/offbox-backups/settings')) {
                posted.push(body);
                current = status({ destinations: [dest({ id: 'd-aabbccddee', name: body.destination.name, source: 'settings', health: 'waiting', lastSuccessAt: null })] });
                return json({ success: true, status: current });
            }
            return json(current);
        }));
        const user = userEvent.setup();
        render(<OffboxBackupsPanel activeNode={node} />);
        await user.click(await screen.findByRole('button', { name: 'Add a destination' }));
        const form = screen.getByTestId('offbox-form');
        await user.type(within(form).getByLabelText('Name'), 'Backblaze');
        await user.type(within(form).getByLabelText(/Endpoint/), 'https://s3.eu-central-003.backblazeb2.com');
        await user.type(within(form).getByLabelText('Bucket'), 'bp-backups');
        await user.clear(within(form).getByLabelText(/Region/));
        await user.type(within(form).getByLabelText(/Region/), 'eu-central-003');
        await user.type(within(form).getByLabelText(/Access key id/), 'KEYID123');
        await user.type(within(form).getByLabelText(/Secret access key/), SECRET);
        await user.click(within(form).getByRole('button', { name: 'Add' }));
        await waitFor(() => expect(posted.length).toBe(1));
        expect(posted[0].destination).toMatchObject({ name: 'Backblaze', bucket: 'bp-backups', region: 'eu-central-003', accessKeyId: 'KEYID123', secretAccessKey: SECRET });
        expect(await screen.findByText(/Destination added/)).toBeInTheDocument();
        expect(document.body.textContent).not.toContain(SECRET);

        await user.click(screen.getByRole('button', { name: 'Change' }));
        const edit = screen.getByTestId('offbox-form');
        expect((within(edit).getByLabelText(/Secret access key/) as HTMLInputElement).value).toBe('');
        await user.clear(within(edit).getByLabelText('Name'));
        await user.type(within(edit).getByLabelText('Name'), 'Backblaze EU');
        await user.click(within(edit).getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(posted.length).toBe(2));
        expect(posted[1].destination).toMatchObject({ id: 'd-aabbccddee', name: 'Backblaze EU', accessKeyId: '', secretAccessKey: '' });
    });

    it('a Change that points a destination somewhere else says the old copies stay there, and how to have them go', async () => {
        let current = status({ destinations: [dest({ id: 'd-aabbccddee', name: 'B2', source: 'settings', prefix: 'old-folder/' })] });
        vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
            const body = init?.body ? JSON.parse(String(init.body)) : null;
            if (String(url).includes('/offbox-backups/settings')) {
                const d = body.destination;
                current = status({ destinations: [dest({ id: d.id, name: d.name, source: 'settings', prefix: d.prefix ? `${d.prefix.replace(/\/+$/, '')}/` : '' })] });
                return json({ success: true, status: current });
            }
            return json(current);
        }));
        const user = userEvent.setup();
        render(<OffboxBackupsPanel activeNode={node} />);
        // A rename only: no warning.
        await user.click(await screen.findByRole('button', { name: 'Change' }));
        await user.type(within(screen.getByTestId('offbox-form')).getByLabelText('Name'), ' EU');
        await user.click(within(screen.getByTestId('offbox-form')).getByRole('button', { name: 'Save' }));
        expect(await screen.findByText('Destination saved.')).toBeInTheDocument();
        // Another folder: the old copies stay where they are, and the card says so.
        await user.click(screen.getByRole('button', { name: 'Change' }));
        const folder = within(screen.getByTestId('offbox-form')).getByLabelText(/Folder/);
        await user.clear(folder);
        await user.type(folder, 'new-folder');
        await user.click(within(screen.getByTestId('offbox-form')).getByRole('button', { name: 'Save' }));
        const said = await screen.findByText(/stay there/);
        expect(said).toHaveTextContent('old-folder/');
        expect(said).toHaveTextContent(/no longer removes them/);
        expect(said).toHaveTextContent(/lifecycle rule/);
    });

    it('says a server older than off-box backups needs an update, rather than breaking', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Not Found' }, false, 404)));
        const { unmount } = render(<OffboxBackupsPanel activeNode={node} />);
        expect(await screen.findByText(/older than backups off the server: update it/)).toBeInTheDocument();
        unmount();
        // A 200 that is not a status (a proxy's page, an older route): the same sentence.
        vi.stubGlobal('fetch', vi.fn(async () => json({ success: true })));
        render(<OffboxBackupsPanel activeNode={node} />);
        expect(await screen.findByText(/older than backups off the server: update it/)).toBeInTheDocument();
    });

    it("shows the node's refusal in one line to someone who is not an owner", async () => {
        vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Only an owner of this node can see or change where its backups go off the box' }, false, 403)));
        render(<OffboxBackupsPanel activeNode={node} />);
        expect(await screen.findByText('Only an owner of this node can see or change where its backups go off the box')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Add a destination' })).toBeNull();
    });
});
