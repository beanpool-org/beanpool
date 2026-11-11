import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ListingPromisePanel, dayBounds, dayText, readPromise, type PromiseStatus } from './ListingPromisePanel';
import type { NodeProfile } from '../../lib/profiles';

/**
 * Mothership A3: Settings → Node Identity → "The listing promise". The node is a fetch stub (GET and POST
 * /api/local/admin/directory/promise); nothing here reaches a node. The headline is the node's own word (`kept`), the two
 * measured lines are shown and never ticked, the two ticked lines and the closing day are an owner's.
 */
const node: NodeProfile = { id: 'n1', name: 'Cairns', url: 'http://localhost:8080', credential: 'pw' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function status(over: Partial<PromiseStatus> = {}): PromiseStatus {
    return { kept: false, owners: 2, backupsLocked: true, backupsRunning: true, reports: false, notice: false, closingOn: null, ...over };
}

type Sent = { method: string; path: string; body: Record<string, unknown> };

/** GET answers `read` (a Response goes as it is); a POST answers `after` (or an error) and records its body. */
function mockNode(read: unknown, sent: Sent[], post: Response | ((body: Record<string, unknown>) => Response) = () => json(200, { promise: status() })) {
    vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
        const method = opts?.method ?? 'GET';
        const path = String(url).replace('http://localhost:8080', '');
        const body = opts?.body ? JSON.parse(String(opts.body)) : {};
        sent.push({ method, path, body });
        if (method === 'POST') return typeof post === 'function' ? post(body) : post;
        return read instanceof Response ? read : json(200, { promise: read });
    });
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('readPromise: the node\'s answer, checked', () => {
    it('null is "nothing is pushed" (a standby, Listed off); an odd shape is not an answer', () => {
        expect(readPromise({ promise: null })).toEqual({ ok: true, promise: null });
        expect(readPromise({ promise: status(), listing: {} })).toMatchObject({ ok: true, promise: { kept: false, owners: 2 } });
        for (const bad of [null, {}, { promise: 'yes' }, { promise: { kept: 'true' } }, { promise: { ...status(), owners: '2' } }]) {
            expect(readPromise(bad)).toEqual({ ok: false });
        }
    });

    it('the date box offers the node\'s own (UTC) day: 17:00 on 3 Nov in UTC-8 is already 4 Nov at the node', () => {
        const at = Date.UTC(2026, 10, 4, 1, 0, 0);
        expect(dayBounds(at)).toEqual({ min: '2026-11-04', max: '2027-12-08' });
    });

    it('dayText writes the day itself in any zone', () => {
        expect(dayText('2026-12-03')).toContain('2026');
        expect(dayText('2026-12-03')).toMatch(/3/);
        expect(dayText(null)).toBe('');
        expect(dayText('soon')).toBe('');
    });
});

describe('the listing promise in Settings', () => {
    it('a community that keeps it: the headline, both measured lines ticked, and the owner\'s words', async () => {
        mockNode(status({ kept: true, owners: 3, reports: true, notice: true }), []);
        render(<ListingPromisePanel activeNode={node} />);
        expect(await screen.findByTestId('listing-promise-headline')).toHaveTextContent('Keeps the listing promise');
        expect(screen.getByTestId('listing-promise-owners')).toHaveTextContent('Two owners');
        expect(screen.getByTestId('listing-promise-owners')).toHaveTextContent('3 owners act for this community.');
        expect(screen.getByTestId('listing-promise-backups')).toHaveTextContent('A recovery code and backups');
        expect((screen.getByTestId('listing-promise-reports') as HTMLInputElement).checked).toBe(true);
        expect((screen.getByTestId('listing-promise-notice') as HTMLInputElement).checked).toBe(true);
        expect(screen.getByText('Your community is listed either way. The promise only moves you up the list for people nearby.')).toBeTruthy();
    });

    it('a new listing says what is missing, in the owner\'s words: one owner, no recovery code', async () => {
        mockNode(status({ owners: 1, backupsLocked: false, backupsRunning: false }), []);
        render(<ListingPromisePanel activeNode={node} />);
        expect(await screen.findByTestId('listing-promise-headline')).toHaveTextContent('New listing');
        expect(screen.getByTestId('listing-promise-owners')).toHaveTextContent('Make a second person an owner under Owners & admins.');
        expect(screen.getByTestId('listing-promise-backups')).toHaveTextContent('Make a recovery code first, under Backups & Restore.');
    });

    it('backups locked but not running says to turn them on', async () => {
        mockNode(status({ backupsLocked: true, backupsRunning: false }), []);
        render(<ListingPromisePanel activeNode={node} />);
        expect(await screen.findByTestId('listing-promise-backups')).toHaveTextContent('Turn scheduled snapshots on, or add an off-box destination');
    });

    it('an owner ticks the two lines and sets the closing day: one POST, the day only because it changed', async () => {
        const sent: Sent[] = [];
        mockNode(status(), sent, () => json(200, { promise: status({ reports: true, notice: true, closingOn: '2026-12-03' }) }));
        render(<ListingPromisePanel activeNode={node} />);
        const save = await screen.findByTestId('listing-promise-save');
        expect(save).toBeDisabled();
        fireEvent.click(screen.getByTestId('listing-promise-reports'));
        fireEvent.click(screen.getByTestId('listing-promise-notice'));
        fireEvent.change(screen.getByTestId('listing-promise-closing'), { target: { value: '2026-12-03' } });
        expect(screen.getByText(/Your card says "Closing on /)).toBeTruthy();
        fireEvent.click(save);
        await waitFor(() => expect(screen.getByTestId('listing-promise-message')).toHaveTextContent('Saved.'));
        const posts = sent.filter((s) => s.method === 'POST');
        expect(posts).toHaveLength(1);
        expect(posts[0].path).toMatch(/\/api\/local\/admin\/directory\/promise$/);
        expect(posts[0].body).toMatchObject({ reports: true, notice: true, closingOn: '2026-12-03' });
        expect(screen.getByTestId('listing-promise-save')).toBeDisabled();
    });

    it('the day kept as it was is not sent again (the node refuses a day already past); Clear the day sends null', async () => {
        const sent: Sent[] = [];
        mockNode(status({ closingOn: '2026-12-03' }), sent, () => json(200, { promise: status() }));
        render(<ListingPromisePanel activeNode={node} />);
        fireEvent.click(await screen.findByTestId('listing-promise-reports'));
        fireEvent.click(screen.getByTestId('listing-promise-save'));
        await waitFor(() => expect(sent.filter((s) => s.method === 'POST')).toHaveLength(1));
        expect(sent.find((s) => s.method === 'POST')!.body).not.toHaveProperty('closingOn');

        cleanup();
        const sent2: Sent[] = [];
        mockNode(status({ closingOn: '2026-12-03' }), sent2, () => json(200, { promise: status() }));
        render(<ListingPromisePanel activeNode={node} />);
        fireEvent.click(await screen.findByTestId('listing-promise-clear-day'));
        fireEvent.click(screen.getByTestId('listing-promise-save'));
        await waitFor(() => expect(sent2.filter((s) => s.method === 'POST')).toHaveLength(1));
        expect(sent2.find((s) => s.method === 'POST')!.body).toMatchObject({ closingOn: null });
    });

    it('a refusal is said in the node\'s words and never "Saved"', async () => {
        mockNode(status(), [], () => json(400, { error: 'closingOn must be a day from today to 400 days ahead, written YYYY-MM-DD, or null to clear it.' }));
        render(<ListingPromisePanel activeNode={node} />);
        fireEvent.click(await screen.findByTestId('listing-promise-reports'));
        fireEvent.click(screen.getByTestId('listing-promise-save'));
        expect(await screen.findByTestId('listing-promise-message')).toHaveTextContent('closingOn must be a day from today');
        expect(screen.getByTestId('listing-promise-message')).not.toHaveTextContent('Saved');
    });

    it('anyone but an owner reads it with the boxes closed and no Save', async () => {
        mockNode(status({ reports: true }), []);
        render(<ListingPromisePanel activeNode={node} viewer={{ kind: 'key', memberPubkey: 'a'.repeat(64), role: 'admin' }} />);
        await screen.findByTestId('listing-promise-headline');
        expect(screen.getByTestId('listing-promise-reports')).toBeDisabled();
        expect(screen.getByTestId('listing-promise-notice')).toBeDisabled();
        expect(screen.getByTestId('listing-promise-closing')).toBeDisabled();
        expect(screen.queryByTestId('listing-promise-save')).toBeNull();
        expect(screen.getByTestId('listing-promise-owner-only')).toHaveTextContent('Only an owner can make or change the promise.');
    });

    it('a node that publishes nothing (standby, Listed off) says so and draws no boxes', async () => {
        mockNode(null, []);
        render(<ListingPromisePanel activeNode={node} />);
        expect(await screen.findByTestId('listing-promise-unpublished')).toBeTruthy();
        expect(screen.queryByTestId('listing-promise-reports')).toBeNull();
    });

    it('a read that fails says so and offers nothing to change', async () => {
        mockNode(json(500, { error: 'boom' }), []);
        render(<ListingPromisePanel activeNode={node} />);
        expect(await screen.findByTestId('listing-promise-failed')).toBeTruthy();
        expect(screen.queryByTestId('listing-promise-save')).toBeNull();
    });
});
