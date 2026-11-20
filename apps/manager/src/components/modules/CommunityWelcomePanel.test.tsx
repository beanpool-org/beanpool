import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { COMMUNITY_WELCOME_WORDS } from '@beanpool/core';
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

    // #3313 review: single-node Settings (the phone's Manage path) makes a new activeNode on every App render, and the
    // 5-second diagnostics poll re-renders App. An equal new object is the same node: no second read, and what the owner is
    // typing stays, in the same box, with the focus.
    const singleNode = (): NodeProfile => ({ id: 'local-node', name: 'Local Sovereign Node', url: 'http://localhost:8080', isPrimary: true });
    const owner = { kind: 'key', memberPubkey: 'a'.repeat(64), role: 'owner' } as const;

    it("a re-render with an equal new activeNode keeps the owner's half-typed welcome, the box and its focus, and reads nothing again", async () => {
        const sent: Sent[] = [];
        mockNode(json(200, { welcome: 'Saved words' }), sent);
        const view = render(<CommunityWelcomePanel activeNode={singleNode()} viewer={owner} />);
        const box = await screen.findByTestId('community-welcome-text') as HTMLTextAreaElement;
        box.focus();
        fireEvent.change(box, { target: { value: 'Half-typed welcome' } });
        for (let tick = 0; tick < 3; tick++) view.rerender(<CommunityWelcomePanel activeNode={singleNode()} viewer={{ ...owner }} />);
        await new Promise((r) => setTimeout(r, 0));
        const after = screen.getByTestId('community-welcome-text') as HTMLTextAreaElement;
        expect(after).toBe(box);
        expect(after.value).toBe('Half-typed welcome');
        expect(document.activeElement).toBe(box);
        expect(sent.filter((s) => s.method === 'GET')).toHaveLength(1);
    });

    it('a save that a re-render lands in keeps the words just saved, never the old ones', async () => {
        const sent: Sent[] = [];
        let answer: (r: Response) => void = () => {};
        mockNode(json(200, { welcome: 'Old words' }), sent);
        vi.mocked(global.fetch).mockImplementation(async (url, opts) => {
            const method = opts?.method ?? 'GET';
            sent.push({ method, path: String(url), body: opts?.body ? JSON.parse(String(opts.body)) : {} });
            return method === 'POST' ? new Promise<Response>((r) => { answer = r; }) : json(200, { welcome: 'Old words' });
        });
        const view = render(<CommunityWelcomePanel activeNode={singleNode()} viewer={owner} />);
        fireEvent.change(await screen.findByTestId('community-welcome-text'), { target: { value: 'New words' } });
        fireEvent.click(screen.getByTestId('community-welcome-save'));
        view.rerender(<CommunityWelcomePanel activeNode={singleNode()} viewer={owner} />);
        answer(json(200, { welcome: 'New words' }));
        await waitFor(() => expect(screen.getByTestId('community-welcome-message').textContent).toBe('Saved. Members see it on Home.'));
        view.rerender(<CommunityWelcomePanel activeNode={singleNode()} viewer={owner} />);
        await new Promise((r) => setTimeout(r, 0));
        expect((screen.getByTestId('community-welcome-text') as HTMLTextAreaElement).value).toBe('New words');
        expect(sent.filter((s) => s.method === 'GET')).toHaveLength(1);
    });

    it('another node, or another token for it, is read again', async () => {
        const sent: Sent[] = [];
        mockNode(json(200, { welcome: 'Saved words' }), sent);
        const view = render(<CommunityWelcomePanel activeNode={node} viewer={owner} />);
        await screen.findByTestId('community-welcome-text');
        view.rerender(<CommunityWelcomePanel activeNode={{ ...node, automationToken: 'pw2' }} viewer={owner} />);
        await waitFor(() => expect(sent.filter((s) => s.method === 'GET')).toHaveLength(2));
        view.rerender(<CommunityWelcomePanel activeNode={{ ...node, automationToken: 'pw2', url: 'http://localhost:8081' }} viewer={owner} />);
        await waitFor(() => expect(sent.filter((s) => s.method === 'GET')).toHaveLength(3));
    });

    // #3313 review: Save is grey for a reason the owner can't see (a pasted control character, a line separator). The count is
    // taken from core's own cleaning, so it and Save always agree, and the reason is said beside it in core's words: the same
    // sentence the server refuses with. One table: what the owner has in the box, what the count says, and why Save won't take it.
    const refusals: Array<[string, string, string, keyof typeof COMMUNITY_WELCOME_WORDS | null, string | null]> = [
        ['a form feed pasted from a PDF', 'Welcome\fto the hall', '19 of 280 characters, 1 of 4 lines', 'control_character',
            "The welcome holds a hidden control character that can't be shown. Type it again rather than pasting it."],
        ['a C1 next-line from a word processor', 'Welcome\u0085friends', '15 of 280 characters, 1 of 4 lines', 'control_character',
            "The welcome holds a hidden control character that can't be shown. Type it again rather than pasting it."],
        ['a vertical tab', 'one\u000btwo', '7 of 280 characters, 1 of 4 lines', 'control_character',
            "The welcome holds a hidden control character that can't be shown. Type it again rather than pasting it."],
        ['four lines and a pasted line separator are five lines', 'one\ntwo\nthree\nfour\u2028five', '23 of 280 characters, 5 of 4 lines', 'too_many_lines',
            'A welcome can be at most 4 lines.'],
        ['paragraph separators are line breaks too', 'one\u2029two\u2029three\u2029four\u2029five', '23 of 280 characters, 5 of 4 lines', 'too_many_lines',
            'A welcome can be at most 4 lines.'],
        ['old Mac line ends count, one break each', 'a\rb\rc\rd\re', '9 of 280 characters, 5 of 4 lines', 'too_many_lines',
            'A welcome can be at most 4 lines.'],
        ["281 characters (a paste the box didn't cut)", 'a'.repeat(281), '281 of 280 characters, 1 of 4 lines', 'too_long',
            'A welcome can be at most 280 characters.'],
        ['Windows line ends are one break each: four lines are kept', 'a\r\nb\r\nc\r\nd', '7 of 280 characters, 4 of 4 lines', null, null],
        ['spaces at the ends are not kept, so not counted', '   Hello   ', '5 of 280 characters, 1 of 4 lines', null, null],
        ["Android's bidi marks are dropped, so not counted", '\u2068Hi\u2069', '2 of 280 characters, 1 of 4 lines', null, null],
    ];
    it.each(refusals)('%s', async (_name, value, count, problem, sentence) => {
        mockNode(json(200, { welcome: null }), []);
        render(<CommunityWelcomePanel activeNode={node} viewer={owner} />);
        fireEvent.change(await screen.findByTestId('community-welcome-text'), { target: { value } });
        const counted = screen.getByTestId('community-welcome-count');
        const save = screen.getByTestId('community-welcome-save') as HTMLButtonElement;
        expect(counted.textContent).toBe(count);
        if (problem) {
            expect(screen.getByTestId('community-welcome-problem').textContent).toBe(sentence);
            expect(sentence).toBe(COMMUNITY_WELCOME_WORDS[problem]); // one source of words: core's, as the server refuses with
            expect(save.disabled).toBe(true);
            if (problem !== 'control_character') expect(counted.className).toContain('text-bp-ink-warning');
        } else {
            expect(screen.queryByTestId('community-welcome-problem')).toBeNull();
            expect(counted.className).not.toContain('text-bp-ink-warning');
            expect(save.disabled).toBe(false);
        }
    });

    it("a read that fails says so and offers no box (a server from before the welcome answers 404)", async () => {
        mockNode(json(404, { error: 'Not found' }), []);
        render(<CommunityWelcomePanel activeNode={node} />);
        expect(await screen.findByTestId('community-welcome-failed')).toBeTruthy();
        expect(screen.queryByTestId('community-welcome-text')).toBeNull();
    });
});
