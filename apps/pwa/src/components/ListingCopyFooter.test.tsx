/**
 * What stands under a copy on the web, door off and door on (slice GD), as the phone's (apps/native utils/__tests__/
 * show-on-global-render.test.ts): no name and nothing to write to until its member takes questions, then their name and one way
 * to write, which opens a chat for no post. Its author can stop from here, and has nothing to ask.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { setLanguage } from '@beanpool/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ListingCopyFooter } from './ListingCopyFooter';
import * as api from '../lib/api';

vi.mock('../lib/api', async () => ({ ...(await vi.importActual('../lib/api')), createConversationApi: vi.fn(), stopTakingQuestions: vi.fn() }));
vi.mock('./ReportModal', () => ({ ReportModal: () => null }));

const KEY = 'ef'.repeat(32);
const ME = 'ab'.repeat(32);
const FROM = { host: 'h', postId: null, name: 'Mullumbimby', url: 'https://h', door: 'ask' as const };
const open = { from: FROM, price: { price_c: 2000, per: 'fixed' as const }, takesQuestions: true };
const shut = { from: FROM, price: { price_c: 2000, per: 'fixed' as const } };
const post = { id: 'c1', title: 'Loaves', authorPublicKey: KEY, authorCallsign: 'Robin' };

beforeEach(() => {
    vi.clearAllMocks();
});
afterEach(cleanup);

describe('a reader', () => {
    it('door off: no name and nothing to write to, whatever the row holds', () => {
        render(<ListingCopyFooter post={post} copy={shut} reader={ME} />);
        expect(screen.queryByTestId('listing-copy-ask')).toBeNull();
        expect(document.body.textContent).not.toContain('Robin');
    });

    it('door on, a row that names nobody: no door, as a visitor\'s read or a stale row', () => {
        render(<ListingCopyFooter post={{ ...post, authorPublicKey: 'hidden', authorCallsign: '' }} copy={open} reader={ME} />);
        expect(screen.queryByTestId('listing-copy-ask')).toBeNull();
    });

    it('door on, nobody signed in: no door', () => {
        render(<ListingCopyFooter post={post} copy={open} />);
        expect(screen.queryByTestId('listing-copy-ask')).toBeNull();
    });

    it('door on: their name, the door still the community\'s, and no deal', () => {
        render(<ListingCopyFooter post={post} copy={open} reader={ME} />);
        expect(screen.getByTestId('listing-copy-ask').textContent).toContain('Robin takes questions about this');
        expect(document.body.textContent).toContain('20 Beans in Mullumbimby');
        expect(document.body.textContent).not.toMatch(/Accept|Pay/);
    });

    it('the button opens a chat with the key, for no post', async () => {
        vi.mocked(api.createConversationApi).mockResolvedValue({ success: true, conversation: { id: 'conv-1' } } as never);
        const opened = vi.fn();
        render(<ListingCopyFooter post={post} copy={open} reader={ME} onOpenChat={opened} />);
        fireEvent.click(screen.getByTestId('listing-copy-ask-button'));
        await waitFor(() => expect(opened).toHaveBeenCalledWith('conv-1'));
        expect(api.createConversationApi).toHaveBeenCalledWith('dm', [ME, KEY], ME);
    });

    it('a chat that can\'t be opened says so', async () => {
        vi.mocked(api.createConversationApi).mockRejectedValue(new Error('Not now'));
        render(<ListingCopyFooter post={post} copy={open} reader={ME} />);
        fireEvent.click(screen.getByTestId('listing-copy-ask-button'));
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toBe('Not now');
        expect(alert.className).toContain('text-bp-ink-danger');
    });
});

describe("a chat the node refuses to open because reports cleared the member's message requests (R1)", () => {
    const LIMITED = "People you wrote to reported your message requests, so they were cleared and you can't send new ones until 2026-11-08. You can still answer people who wrote to you, and post.";

    it("says it in the member's language, dated, not in the node's English", async () => {
        const es = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../packages/beanpool-core/words/es.json'), 'utf8'));
        setLanguage('es', [es]);
        try {
            vi.mocked(api.createConversationApi).mockRejectedValue(Object.assign(new Error(LIMITED), { status: 403, code: 'dm_requests_limited' }));
            render(<ListingCopyFooter post={post} copy={open} reader={ME} />);
            fireEvent.click(screen.getByTestId('listing-copy-ask-button'));
            const alert = await screen.findByRole('alert');
            expect(alert.textContent).toBe('Personas a las que escribiste denunciaron tus solicitudes de mensaje, así que se borraron y no puedes enviar nuevas hasta el 2026-11-08. Todavía puedes responder a quienes te escribieron y publicar.');
        } finally { setLanguage('en'); }
    });
});

describe('its author', () => {
    it('has nothing to ask, and can stop from here', async () => {
        vi.mocked(api.stopTakingQuestions).mockResolvedValue({ success: true });
        render(<ListingCopyFooter post={post} copy={open} reader={KEY} />);
        expect(screen.queryByTestId('listing-copy-ask')).toBeNull();
        fireEvent.click(screen.getByTestId('listing-copy-stop-questions'));
        await waitFor(() => expect(screen.queryByTestId('listing-copy-stop-questions')).toBeNull());
        expect(api.stopTakingQuestions).toHaveBeenCalledWith('c1');
    });

    it('a shut copy offers nothing to stop', () => {
        render(<ListingCopyFooter post={post} copy={shut} reader={KEY} />);
        expect(screen.queryByTestId('listing-copy-stop-questions')).toBeNull();
    });
});
