/**
 * The receiving half of the account handoff (pages/HandoffPage.tsx, DESIGN-global-yes-join-fable.md §2.1, slice Y1), at
 * Byron's page (bp_node_url https://byron.example.org, a stubbed fetch), opened by global's page (a stand-in opener):
 *   - ready goes to the opener at `from` only; an account from another source, another origin or with another nonce is
 *     dropped, and nothing is read or kept;
 *   - a key with no yes here: "This account has no yes here.", `refused`, nothing kept;
 *   - a browser with another account here: "This browser already has an account here.", `held`, that account untouched;
 *   - a yes: "Join Byron Shire BeanPool as {name}?", the name the account came with (editable), global's photo a tickbox,
 *     off; nothing kept until Join; Join keeps the key as the waiting key, established; Not mine: `declined`, nothing kept.
 * Real browsers between two origins: e2e/global-yes-y1-check.mjs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HandoffPage } from './HandoffPage';
import { accountMessage, answerMessage, readyMessage } from '../lib/handoff';
import { generateIdentity, importIdentity, loadIdentity, type BeanPoolIdentity } from '../lib/identity';
import { isEstablishedKey, isKnockKey } from '../lib/knock-key';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

const NODE = 'https://byron.example.org';
const GLOBAL = 'https://global.example.org';
const NONCE = 'a1'.repeat(16);
const PHOTO = 'data:image/png;base64,iVBORw0KGgo=';

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let yes: boolean;
let statusReads: string[];
let account: BeanPoolIdentity;
let opener: { postMessage: ReturnType<typeof vi.fn> };

beforeEach(async () => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    localStorage.clear();
    localStorage.setItem('bp_node_url', NODE);
    yes = true;
    statusReads = [];
    account = await generateIdentity('CJ Global');
    opener = { postMessage: vi.fn() };
    Object.defineProperty(window, 'opener', { value: opener, configurable: true, writable: true });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input).replace(NODE, '');
        if (path === '/api/community/card') return json(200, { name: 'Byron Shire BeanPool', host: 'byron.example.org', members: 3, joining: 'requests' });
        if (path === '/api/join/knock/status') {
            statusReads.push(((init.headers ?? {}) as Record<string, string>)['X-Public-Key']);
            return json(200, yes ? { status: 'approved', invite: 'INV-KN0C-K1NV', expiresAt: null } : { status: 'none' });
        }
        return json(200, {});
    }));
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    Object.defineProperty(window, 'opener', { value: null, configurable: true, writable: true });
});

const handed = (callsign = 'CJ Asked') => ({ publicKey: account.publicKey, privateKey: account.privateKey, mnemonic: account.mnemonic, callsign });
function send(data: unknown, { origin = GLOBAL, source = opener as unknown }: { origin?: string; source?: unknown } = {}) {
    window.dispatchEvent(new MessageEvent('message', { data, origin, source: source as Window }));
}
function renderPage() {
    const onJoin = vi.fn();
    const onOpen = vi.fn();
    const onMember = vi.fn();
    render(<HandoffPage handoff={{ nonce: NONCE, from: GLOBAL }} onOpen={onOpen} onJoin={onJoin} onMember={onMember} />);
    return { onJoin, onOpen, onMember };
}
const answers = () => opener.postMessage.mock.calls.filter(([d]) => (d as { type: string }).type !== 'ready');

describe('the handoff door at the community', () => {
    it('says ready to its opener, at the address it names only, and takes nothing from anyone else', async () => {
        renderPage();
        await waitFor(() => expect(opener.postMessage).toHaveBeenCalledWith(readyMessage(NONCE), GLOBAL));
        send(accountMessage(NONCE, handed(), null), { source: window });
        send(accountMessage(NONCE, handed(), null), { origin: 'https://spy.example.org' });
        send(accountMessage('b2'.repeat(16), handed(), null));
        await new Promise((r) => setTimeout(r, 50));
        expect(screen.getByTestId('handoff-waiting')).toBeInTheDocument();
        expect(statusReads).toEqual([]);
        expect(await loadIdentity()).toBeNull();
        expect(answers()).toEqual([]);
    });

    it("a key nobody here said yes to: says so, answers refused, keeps nothing", async () => {
        yes = false;
        renderPage();
        send(accountMessage(NONCE, handed(), null));
        expect(await screen.findByTestId('handoff-refused')).toHaveTextContent('This account has no yes here.');
        expect(statusReads).toEqual([account.publicKey]);
        expect(answers()).toEqual([[answerMessage(NONCE, 'refused'), GLOBAL]]);
        expect(await loadIdentity()).toBeNull();
    });

    it('a browser with another account here: says so, answers held, and that account is untouched', async () => {
        const other = await generateIdentity('Someone');
        await importIdentity(other);
        renderPage();
        send(accountMessage(NONCE, handed(), null));
        expect(await screen.findByTestId('handoff-held')).toHaveTextContent('This browser already has an account here.');
        expect(answers()).toEqual([[answerMessage(NONCE, 'held'), GLOBAL]]);
        expect((await loadIdentity())?.publicKey).toBe(other.publicKey);
    });

    it('a yes: asks, naming where it came from, with the name it came with and the photo off; Join keeps it as the waiting key', async () => {
        const { onJoin } = renderPage();
        send(accountMessage(NONCE, handed(), PHOTO));
        const form = await screen.findByTestId('handoff-confirm');
        expect(form).toHaveTextContent('Join Byron Shire BeanPool as CJ Asked?');
        expect(screen.getByTestId('handoff-from')).toHaveTextContent('Your account from global.example.org comes with you. Your 12 words stay the same.');
        expect(screen.getByTestId('handoff-callsign')).toHaveValue('CJ Asked');
        expect(screen.getByTestId('handoff-photo-box')).not.toBeChecked();
        expect(await loadIdentity()).toBeNull();

        fireEvent.change(screen.getByTestId('handoff-callsign'), { target: { value: 'CJ Byron' } });
        expect(form).toHaveTextContent('Join Byron Shire BeanPool as CJ Byron?');
        fireEvent.click(screen.getByTestId('handoff-join'));
        await waitFor(() => expect(onJoin).toHaveBeenCalledTimes(1));
        const [{ account: kept, invite, name }] = onJoin.mock.calls[0];
        expect(kept.publicKey).toBe(account.publicKey);
        expect(kept.callsign).toBe('CJ Byron');
        expect(invite).toBe('INV-KN0C-K1NV');
        expect(name).toBe('Byron Shire BeanPool');
        const stored = await loadIdentity();
        expect(stored?.publicKey).toBe(account.publicKey);
        expect(stored?.mnemonic).toEqual(account.mnemonic);
        expect(isKnockKey(stored)).toBe(true);
        expect(isEstablishedKey(account.publicKey)).toBe(true);
        // `joined` waits for the yes to make the key a member (WelcomePage enterAsInvited → handoffJoined).
        expect(answers()).toEqual([]);
    });

    it('a name under 2 characters is asked again, and nothing is kept', async () => {
        const { onJoin } = renderPage();
        send(accountMessage(NONCE, handed(), null));
        await screen.findByTestId('handoff-confirm');
        fireEvent.change(screen.getByTestId('handoff-callsign'), { target: { value: ' C ' } });
        fireEvent.click(screen.getByTestId('handoff-join'));
        expect(await screen.findByTestId('handoff-error')).toHaveTextContent('Please give a name of at least 2 characters.');
        expect(onJoin).not.toHaveBeenCalled();
        expect(await loadIdentity()).toBeNull();
    });

    it('Not mine: answers declined, keeps nothing', async () => {
        renderPage();
        send(accountMessage(NONCE, handed(), null));
        fireEvent.click(await screen.findByTestId('handoff-not-mine'));
        expect(await screen.findByTestId('handoff-declined')).toHaveTextContent('Nothing was kept here. You can close this tab.');
        expect(answers()).toEqual([[answerMessage(NONCE, 'declined'), GLOBAL]]);
        expect(await loadIdentity()).toBeNull();
    });

    it('opened by nothing (no opener): says to go back and tap Join again', async () => {
        Object.defineProperty(window, 'opener', { value: null, configurable: true, writable: true });
        renderPage();
        expect(await screen.findByTestId('handoff-nothing')).toHaveTextContent('Nothing came from the page that opened this one. Go back there and tap Join again.');
    });
});
