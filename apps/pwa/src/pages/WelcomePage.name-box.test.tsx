/**
 * The web join's name box refuses an invite or a web address (Marty, 14 Nov 2026, card callsign-link-guard: a member's
 * invite link pasted into the name box became her name on her community). A pasted invite goes to the invite box, the name box is
 * left empty and one line says why; a web address is refused on Join with that line; nothing is sent to the node.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NAME_BOX_WORDS } from '@beanpool/core';
import { WelcomePage } from './WelcomePage';
import { resetCapturedAuthReturn } from '../lib/web-join';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { knockFormProblem } from '../lib/knock';

type Call = { path: string; body: any };

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const LOCAL = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance_c: 0, profile: 'local', features: { openJoin: false } };
const HER_LINK = 'https://riverside.example.org/?invite=INV-K7Q2-BSXA';

function stubNode() {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const call: Call = { path: String(input), body: init.body ? JSON.parse(String(init.body)) : undefined };
        calls.push(call);
        if (call.path === '/api/community/info') return json(200, LOCAL);
        if (call.path.startsWith('/api/invite/check')) return json(200, { valid: true });
        return json(200, {});
    }));
    return { sent: () => calls.filter((c) => c.path.startsWith('/api/invite/')) };
}

const nameBox = () => screen.getByLabelText('Your Callsign (Name)') as HTMLInputElement;
const inviteBox = () => screen.getByLabelText('Invite Code') as HTMLInputElement;
const join = () => fireEvent.click(screen.getByRole('button', { name: 'Create Identity & Join →' }));

beforeEach(() => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetCapturedAuthReturn();
    window.history.replaceState(null, '', '/app');
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('the web join\'s name box takes a name, never an invite or a link', () => {
    it('her invite link pasted into the name box goes to the invite box, whole, and the name box stays empty with one line', async () => {
        const node = stubNode();
        render(<WelcomePage onComplete={vi.fn()} />);
        await screen.findByText(/Join with Invite Code/);
        // The box keeps 20 characters: the paste is read as it came, before the box cuts it.
        expect(nameBox()).toHaveAttribute('maxlength', '20');
        fireEvent.paste(nameBox(), { clipboardData: { getData: () => HER_LINK } });

        expect(inviteBox().value).toBe('INV-K7Q2-BSXA');
        expect(nameBox().value).toBe('');
        expect(screen.getByText(NAME_BOX_WORDS.inviteLink)).toBeInTheDocument();
        expect(node.sent().filter((c) => c.path === '/api/invite/redeem')).toHaveLength(0);
    });

    it('an invite code typed or dropped into the name box moves too', async () => {
        stubNode();
        render(<WelcomePage onComplete={vi.fn()} />);
        await screen.findByText(/Join with Invite Code/);
        fireEvent.change(nameBox(), { target: { value: 'INV-K7Q2-BSXA' } });
        expect(inviteBox().value).toBe('INV-K7Q2-BSXA');
        expect(nameBox().value).toBe('');
        expect(screen.getByText(NAME_BOX_WORDS.inviteCode)).toBeInTheDocument();
    });

    it('a web address as the name is refused on Join with its line, and nothing is sent', async () => {
        const node = stubNode();
        render(<WelcomePage onComplete={vi.fn()} />);
        await screen.findByText(/Join with Invite Code/);
        fireEvent.change(inviteBox(), { target: { value: 'BP-7K3X-9M2W' } });
        fireEvent.change(nameBox(), { target: { value: 'riverside.org' } });
        join();
        expect(await screen.findByText(NAME_BOX_WORDS.webLink)).toBeInTheDocument();
        expect(nameBox().value).toBe('riverside.org');
        expect(node.sent()).toHaveLength(0);
    });

    it('a name with dots in it joins as before (the redeem is sent)', async () => {
        const node = stubNode();
        render(<WelcomePage onComplete={vi.fn()} />);
        await screen.findByText(/Join with Invite Code/);
        fireEvent.change(inviteBox(), { target: { value: 'BP-7K3X-9M2W' } });
        fireEvent.change(nameBox(), { target: { value: 'J.R. St.Kilda' } });
        join();
        await vi.waitFor(() => expect(node.sent().some((c) => c.path === '/api/invite/redeem' && c.body?.callsign === 'J.R. St.Kilda')).toBe(true));
        expect(screen.queryByText(NAME_BOX_WORDS.webLink)).toBeNull();
    });
});

describe('asking to join (lib/knock.ts knockFormProblem)', () => {
    it('refuses an invite or a link as the name with its line, and takes a name', () => {
        expect(knockFormProblem({ callsign: HER_LINK.slice(0, 20), message: 'Hello' })).toBe(NAME_BOX_WORDS.webLink);
        expect(knockFormProblem({ callsign: 'INV-K7Q2-BSXA', message: 'Hello' })).toBe(NAME_BOX_WORDS.inviteCode);
        expect(knockFormProblem({ callsign: 'Dee Dee', message: 'Hello' })).toBeNull();
    });
});
