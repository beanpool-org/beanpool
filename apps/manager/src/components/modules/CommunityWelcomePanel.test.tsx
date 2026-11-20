import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CommunityWelcomePanel, readWelcome } from './CommunityWelcomePanel';
import type { NodeProfile } from '../../lib/profiles';

/**
 * Onboarding S6: Settings → Node Identity → "Welcome for new members". The node is a fetch stub (GET and POST
 * /api/local/admin/community-welcome); nothing here reaches a node. An owner writes it; anyone else reads it with the box
 * closed; core's limits (280 characters, four lines) hold the Save button.
 */
const node: NodeProfile = { id: 'n1', name: 'Riverside', url: 'http://localhost:8080', automationToken: 'pw' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
type Sent = { method: string; path: string; body: Record<string, unknown> };

function mockNode(read: Response, sent: Sent[], post: (body: Record<string, unknown>) => Response = (b) => json(200, { welcome: (b.welcome as string)?.trim() || null })) {
    vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
        const method = opts?.method ?? 'GET';
        const body = opts?.body ? JSON.parse(String(opts.body)) : {};
        sent.push({ method, path: String(url).replace('http://localhost:8080', ''), body });
        return method === 'POST' ? post(body) : read;
    });
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('readWelcome: the node\'s answer, checked', () => {
    it('a text or null is an answer; an odd shape is not', () => {
        expect(readWelcome({ welcome: 'Hi' })).toEqual({ ok: true, welcome: 'Hi' });
        expect(readWelcome({ welcome: null })).toEqual({ ok: true, welcome: null });
        expect(readWelcome({ welcome: '' })).toEqual({ ok: true, welcome: null });
        for (const bad of [null, {}, { welcome: 7 }, { welcome: ['Hi'] }, 'Hi']) expect(readWelcome(bad)).toEqual({ ok: false });
    });
});

describe('the welcome for new members in Settings', () => {
    it('an owner reads it, changes it and saves it to the welcome route', async () => {
        const sent: Sent[] = [];
        mockNode(json(200, { welcome: 'Welcome!' }), sent);
        render(<CommunityWelcomePanel activeNode={node} viewer={{ kind: 'key', memberPubkey: 'a'.repeat(64), role: 'owner' }} />);
        const box = await screen.findByTestId('community-welcome-text') as HTMLTextAreaElement;
        expect(box.value).toBe('Welcome!');
        expect(box.maxLength).toBe(280);
        const save = screen.getByTestId('community-welcome-save') as HTMLButtonElement;
        expect(save.disabled).toBe(true); // nothing changed yet
        fireEvent.change(box, { target: { value: 'Welcome!\nMarket day is Saturday.' } });
        expect(screen.getByTestId('community-welcome-count').textContent).toBe('32 of 280 characters, 2 of 4 lines');
        expect(save.disabled).toBe(false);
        fireEvent.click(save);
        await waitFor(() => expect(screen.getByTestId('community-welcome-message').textContent).toBe('Saved. Members see it on Home.'));
        const post = sent.find((s) => s.method === 'POST');
        // The node's address goes through the manager's proxy in a test (resolveNodeApiUrl): the route is the path's end.
        expect(post?.path).toMatch(/\/api\/local\/admin\/community-welcome$/);
        expect(post?.body).toEqual({ welcome: 'Welcome!\nMarket day is Saturday.' });
        expect(sent[0].method).toBe('GET');
        expect(sent[0].path).toMatch(/\/api\/local\/admin\/community-welcome$/);
    });

    it('five lines hold the Save button, and the count says so', async () => {
        mockNode(json(200, { welcome: null }), []);
        render(<CommunityWelcomePanel activeNode={node} viewer={{ kind: 'key', memberPubkey: 'a'.repeat(64), role: 'owner' }} />);
        const box = await screen.findByTestId('community-welcome-text');
        fireEvent.change(box, { target: { value: 'a\nb\nc\nd\ne' } });
        expect(screen.getByTestId('community-welcome-count').textContent).toBe('9 of 280 characters, 5 of 4 lines');
        expect(screen.getByTestId('community-welcome-count').className).toContain('text-bp-ink-warning');
        expect((screen.getByTestId('community-welcome-save') as HTMLButtonElement).disabled).toBe(true);
    });

    it('emptying it removes it', async () => {
        const sent: Sent[] = [];
        mockNode(json(200, { welcome: 'Welcome!' }), sent);
        render(<CommunityWelcomePanel activeNode={node} viewer={{ kind: 'key', memberPubkey: 'a'.repeat(64), role: 'owner' }} />);
        fireEvent.change(await screen.findByTestId('community-welcome-text'), { target: { value: '' } });
        fireEvent.click(screen.getByTestId('community-welcome-save'));
        await waitFor(() => expect(screen.getByTestId('community-welcome-message').textContent).toBe('Removed. Members see no welcome from you.'));
        expect(sent.find((s) => s.method === 'POST')?.body).toEqual({ welcome: '' });
    });

    it("the node's refusal is shown in its own words", async () => {
        mockNode(json(200, { welcome: null }), [], () => json(400, { error: 'A welcome can be at most 280 characters.', code: 'too_long' }));
        render(<CommunityWelcomePanel activeNode={node} viewer={{ kind: 'key', memberPubkey: 'a'.repeat(64), role: 'owner' }} />);
        fireEvent.change(await screen.findByTestId('community-welcome-text'), { target: { value: 'Hello' } });
        fireEvent.click(screen.getByTestId('community-welcome-save'));
        await waitFor(() => expect(screen.getByTestId('community-welcome-message').textContent).toBe('A welcome can be at most 280 characters.'));
    });

    it('an admin reads it with the box closed and no Save', async () => {
        mockNode(json(200, { welcome: 'Welcome!' }), []);
        render(<CommunityWelcomePanel activeNode={node} viewer={{ kind: 'key', memberPubkey: 'b'.repeat(64), role: 'admin' }} />);
        const box = await screen.findByTestId('community-welcome-text') as HTMLTextAreaElement;
        expect(box.value).toBe('Welcome!');
        expect(box.disabled).toBe(true);
        expect(screen.queryByTestId('community-welcome-save')).toBeNull();
        expect(screen.getByTestId('community-welcome-owner-only').textContent).toBe('Only an owner can change the welcome.');
    });

    it("a read that fails says so and offers no box (a server from before the welcome answers 404)", async () => {
        mockNode(json(404, { error: 'Not found' }), []);
        render(<CommunityWelcomePanel activeNode={node} />);
        expect(await screen.findByTestId('community-welcome-failed')).toBeTruthy();
        expect(screen.queryByTestId('community-welcome-text')).toBeNull();
    });
});
