/**
 * The owner's and the recovery screens in the member's language (words S3, web sweep W4): taking over or restoring with
 * this browser, the recovery alert, sign-in recovery, an owner's 12 words check and its prompt, the recovery kit and
 * "one way back". In the pseudo-locale every word they show came through t(), the key-path lib files' sentences too
 * (components/key-lines.ts); a community's name, a server's address, a sign-in's name and the shape of a code are shown
 * as written, and the 12 words are never looked up. In English nothing is bracketed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { OwnerUnlockSessions, buildOwnerUnlockLink, readSealedHeader, sealEnvelope, toEd25519Pkcs8 } from '@beanpool/core';
import * as api from '../lib/api';
import { OwnerUnlockCard } from './OwnerUnlockCard';
import { RecoveryAlertBanner } from './RecoveryAlertBanner';
import { SignInRecoveryLine } from './SignInRecoveryLine';
import { OwnerWordsCheck } from './OwnerWordsCheck';
import { OwnerWordsPrompt } from './OwnerWordsPrompt';
import { RecoveryKitButton } from './RecoveryKitButton';
import { OneWayBackCard } from './OneWayBack';
import { lockPinKey, resetLockOpenCheckForTests } from '../lib/takeover-unlock';
import { forgetOwnerWordsStatus } from '../lib/owner-words';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { generateIdentity } from '../lib/identity';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-xx.test-support';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
    return { ...actual, request: vi.fn(), getNodeApiUrl: vi.fn(() => ''), getCommunityMe: vi.fn() };
});

const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const SEED = sha256(sha256(utf8ToBytes(WORDS.join(' '))));
const OWNER = { publicKey: bytesToHex(ed25519.getPublicKey(SEED)), privateKey: bytesToHex(toEd25519Pkcs8(SEED)) };
const WC = '/api/node/owner/words-check';

function allThroughWords(others: readonly string[] = [], atLeast = 2) {
    expect(bypassing(document.body, { others })).toEqual([]);
    expect(bracketed()).toBeGreaterThanOrEqual(atLeast);
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
    localStorage.clear();
    resetLockOpenCheckForTests();
    forgetOwnerWordsStatus();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    vi.mocked(api.request).mockReset();
    vi.mocked(api.request).mockRejectedValue(new Error('Failed to fetch'));
});
afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    backToEnglish();
});

describe('taking over or restoring with this browser (OwnerUnlockCard)', () => {
    /** A standby's take-over session for OWNER, as OwnerUnlockCard.test.tsx makes one, and the code its Settings shows. */
    async function standby() {
        const nodeSeed = randomBytes(32);
        const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        let n = BigInt('0x' + bytesToHex(new Uint8Array([0x00, 0x24, 0x08, 0x01, 0x12, 0x20, ...ed25519.getPublicKey(nodeSeed)])));
        let peer = '';
        while (n > 0n) { peer = B58[Number(n % 58n)] + peer; n /= 58n; }
        peer = '1' + peer;
        const env = await sealEnvelope(new TextEncoder().encode('{}'), {
            kind: 'takeover', communityId: 'c0ffee0000000003', nodePeerId: peer, signingKey: nodeSeed,
            recipients: { owners: [{ pubkey: OWNER.publicKey, callsign: 'me' }] },
        });
        const header = readSealedHeader(env);
        localStorage.setItem(lockPinKey(OWNER.publicKey), JSON.stringify({ communityId: 'c0ffee0000000003', nodePeerId: peer, lastEnvelopeId: null, owner: true }));
        const sessions = new OwnerUnlockSessions<null>();
        const session = sessions.create('takeover', header, null);
        globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => (init?.method === 'POST'
            ? { ok: true, status: 200, json: async () => ({ success: true, purpose: 'takeover' }) }
            : { ok: true, status: 200, json: async () => ({ purpose: 'takeover', header, expiresAt: session.expiresAt, takeover: { sealedAt: header.createdAt, mainServerAnswers: true, lastCopyAt: null, missing: [] } }) }) as Response) as typeof fetch;
        return buildOwnerUnlockLink(sessions.qrFor(session, 'https://standby.example.org'));
    }

    it('the card, a code that is not a take-over code, what will happen, and the end', async () => {
        await showIn('xx');
        const link = await standby();
        render(<OwnerUnlockCard identity={OWNER} communityName="Anna Town" />);
        allThroughWords();
        fireEvent.click(screen.getByRole('button', { name: xx('Paste a code') }));
        allThroughWords(['beanpool://unlock-keys?…']);
        fireEvent.change(screen.getByLabelText(xx("The code from the server's screen")), { target: { value: 'hello' } });
        fireEvent.click(screen.getByRole('button', { name: xx('Check the code') }));
        expect(screen.getByRole('alert').textContent).toBe(xx("That isn't a take-over code. On the standby's Settings, choose “Take over with an owner's phone” and copy the code it shows."));
        allThroughWords(['beanpool://unlock-keys?…', 'hello']);

        fireEvent.change(screen.getByLabelText(xx("The code from the server's screen")), { target: { value: link } });
        fireEvent.click(screen.getByRole('button', { name: xx('Check the code') }));
        await screen.findByText(xx('Take over {name} on {host}?').replace('{name}', 'Anna Town').replace('{host}', 'standby.example.org'));
        allThroughWords(['Anna Town', 'standby.example.org']);
        fireEvent.click(screen.getByRole('button', { name: xx('Unlock for the take-over') }));
        await waitFor(() => expect(screen.getByRole('status').querySelector('p')?.textContent).toBe(
            xx("Unlocked. Now finish on {host}'s screen: it shows what will happen, then “Take over now”.").replace('{host}', 'standby.example.org')));
        allThroughWords(['standby.example.org']);
    });

    it('in English: when the keys were locked, as the phone says it', async () => {
        const link = await standby();
        render(<OwnerUnlockCard identity={OWNER} communityName="Anna Town" />);
        fireEvent.click(screen.getByRole('button', { name: 'Paste a code' }));
        fireEvent.change(screen.getByLabelText(/code from the server/i), { target: { value: link } });
        fireEvent.click(screen.getByRole('button', { name: 'Check the code' }));
        await screen.findByText('Take over Anna Town on standby.example.org?');
        expect(bracketed()).toBe(0);
        expect(screen.getByText('Community: Anna Town')).toBeInTheDocument();
        expect(screen.getByText('Server: standby.example.org')).toBeInTheDocument();
        expect(screen.getByText(/^Keys locked: \d{1,2} [A-Z][a-z]{2} \d{4}, \d{1,2}:\d{2}$/)).toBeInTheDocument();
    });
});

describe('someone is recovering your account (RecoveryAlertBanner)', () => {
    it('the banner, its count and when it started, the question before Stop, and what came of it', async () => {
        await showIn('xx');
        const said: string[] = [];
        vi.spyOn(window, 'confirm').mockImplementation((m?: string) => { said.push(String(m)); return true; });
        vi.spyOn(window, 'alert').mockImplementation((m?: unknown) => { said.push(String(m)); });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
            const path = new URL(String(input), 'https://mullum.test').pathname;
            if (path === '/api/recovery/collect/mine') return new Response(JSON.stringify({ count: 3, collections: [{ collectionId: 'c-1', generation: 1, startedAt: new Date().toISOString() }] }), { status: 200 });
            return new Response(JSON.stringify({ stopped: 1, left: 2 }), { status: 200 });
        }) as typeof fetch;
        render(<RecoveryAlertBanner />);
        expect(await screen.findByText(xx('Someone is recovering your account'))).toBeInTheDocument();
        allThroughWords();
        fireEvent.click(screen.getByRole('button', { name: xx('Stop It Now') }));
        await waitFor(() => expect(said.length).toBe(2));
        expect(bypassing(document.body, { said })).toEqual([]);
    });
});

describe('sign-in recovery (SignInRecoveryLine)', () => {
    it('connected, not connected, with and without the 12 words in this browser', async () => {
        await showIn('xx');
        for (const [enrolled, hasWords] of [[['google', 'apple'], true], [['google'], false], [[], true], [[], false]] as const) {
            render(<SignInRecoveryLine enrolled={[...enrolled]} hasWords={hasWords} />);
            allThroughWords(['Google', 'Apple', 'Google, Apple'], 1);
            cleanup();
        }
    });

    it('in English, as it was: "Sign-in recovery: connected (Google and Apple)"', () => {
        render(<SignInRecoveryLine enrolled={['google', 'apple']} hasWords={false} />);
        expect(screen.getByText('Sign-in recovery: connected (Google and Apple)')).toBeInTheDocument();
        expect(screen.getByTestId('signin-recovery-way-back').textContent).toBe("Signing in with Google and Apple brings this account back. Your 12 words aren't saved in this browser. If you have them written down, they do too.");
        expect(bracketed()).toBe(0);
    });
});

describe("an owner's 12 words (OwnerWordsCheck, OwnerWordsPrompt)", () => {
    function nodeSays(status: { owner: boolean; wordsCheckedAt: number | null }) {
        vi.mocked(api.request).mockImplementation((async (method: string, path: string) => {
            if (path !== WC) throw new Error(`unexpected ${method} ${path}`);
            return method === 'GET' ? status : { success: true, wordsCheckedAt: 1_790_000_000_000 };
        }) as typeof api.request);
    }

    it('the card, the words box, too few words, the wrong words, the right ones', async () => {
        await showIn('xx');
        nodeSays({ owner: true, wordsCheckedAt: null });
        render(<OwnerWordsCheck identity={OWNER} />);
        fireEvent.click(await screen.findByRole('button', { name: xx('Check now') }));
        allThroughWords(['word word word …']);
        const box = screen.getByLabelText(xx('Your 12 words, in order'));
        fireEvent.change(box, { target: { value: 'abandon ability able' } });
        fireEvent.click(screen.getByRole('button', { name: xx('Check my words') }));
        expect(await screen.findByText(xx("That's {n} words. Type all 12, in order.").replace('{n}', '3'))).toBeInTheDocument();
        allThroughWords(['word word word …']);
        fireEvent.change(box, { target: { value: [...WORDS].reverse().join(' ') } });
        fireEvent.click(screen.getByRole('button', { name: xx('Check my words') }));
        expect(await screen.findByText(xx("These aren't the words for this account."))).toBeInTheDocument();
        fireEvent.change(box, { target: { value: WORDS.join(' ') } });
        fireEvent.click(screen.getByRole('button', { name: xx('Check my words') }));
        expect(await screen.findByText(xx('These are the right words. Your community can see you checked them today.'))).toBeInTheDocument();
        allThroughWords(['word word word …']);
    });

    it('the prompt on the home screen', async () => {
        await showIn('xx');
        nodeSays({ owner: true, wordsCheckedAt: null });
        render(<OwnerWordsPrompt publicKey={OWNER.publicKey} onCheckNow={vi.fn()} />);
        expect(await screen.findByText(xx("Your 12 words aren't checked"))).toBeInTheDocument();
        allThroughWords();
    });

    it('in English: when they were checked, as the phone says it', async () => {
        nodeSays({ owner: true, wordsCheckedAt: new Date(2026, 9, 3, 12).getTime() });
        render(<OwnerWordsCheck identity={OWNER} />);
        expect(await screen.findByText('12 words checked 3 Oct 2026')).toBeInTheDocument();
        expect(bracketed()).toBe(0);
    });
});

describe('the recovery kit (RecoveryKitButton) and "one way back" (OneWayBackCard)', () => {
    it('the kit\'s button, its warning, Cancel and Continue; the 12 words are not shown here', async () => {
        await showIn('xx');
        render(<RecoveryKitButton words={WORDS} print={() => {}} />);
        allThroughWords([], 1);
        fireEvent.click(screen.getByRole('button', { name: xx('Print or save your recovery kit') }));
        allThroughWords([], 3);
        for (const w of WORDS) expect(document.body.textContent).not.toContain(w);
    });

    it('the card on the landing screen, with a sign-in that came back added', async () => {
        await showIn('xx');
        const identity = await generateIdentity('Bea');
        vi.mocked(api.getCommunityMe).mockResolvedValue({
            publicKey: 'x', probation: { onProbation: true, keptPosts: 0, ageEndsAt: new Date(Date.now() + 86_400_000).toISOString(), rules: 'words' },
            mute: { muted: false, until: null },
        } as unknown as api.CommunityStanding);
        render(<OneWayBackCard identity={identity} placement="landing" onSeeWords={() => {}} result={{ kind: 'linked', provider: 'google', recoveryStored: true }} />);
        expect(await screen.findByTestId('one-way-back-text')).toHaveTextContent(xx('Your account has one way back: your 12 words. Check you still have them, or add a sign-in.'));
        expect(screen.getByTestId('link-result').textContent).toBe(xx('{provider} is added. Signing in with it also brings this account back, and your new-account limits are now the usual ones.').replace('{provider}', 'Google'));
        allThroughWords(['Google']);
    });
});
