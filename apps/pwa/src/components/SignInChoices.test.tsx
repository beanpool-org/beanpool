/**
 * The sign-ins this web app offers are Google, Apple and Facebook, and nothing else (owner, 2026-09-29: GitHub is not a
 * BeanPool sign-in; its `sub` is a public, sequential user id, so a copy sealed to it is protected by nothing a member
 * controls). Every place a member chooses or reads a sign-in draws only those three, whatever a node's answer or this
 * browser's storage names: the join's "Sign in with", the restore's sign-ins, and Settings' sign-in recovery line.
 * The node is a stubbed fetch; nothing leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WebJoin } from './WebJoin';
import { WebRestore } from './WebRestore';
import { SettingsPage } from '../pages/SettingsPage';
import * as api from '../lib/api';
import {
    generateIdentity,
    loadPendingJoin,
    loadPendingRestore,
    savePendingJoin,
    savePendingRestore,
    PENDING_JOIN_TTL_MS,
    PENDING_RESTORE_TTL_MS,
    type BeanPoolIdentity,
    type JoinProvider,
    type PendingRestore,
} from '../lib/identity';
import { resetCapturedAuthReturn } from '../lib/web-join';
import { makeEphemeralKey } from '../lib/web-restore';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        getNotificationPreferences: vi.fn(async () => ({})),
        getMemberPreferences: vi.fn(async () => ({})),
        getMemberProfile: vi.fn(async () => ({})),
        getNodeStats: vi.fn(async () => null),
        getCommunityHealth: vi.fn(async () => ({})),
        getSignInRecovery: vi.fn(async () => null),
    };
});

const ORIGIN = 'https://global.beanpool.org';
const OFFERED = ['google', 'apple', 'facebook'];
/** A value no sign-in list here may carry, as an older node or an older build of this app might still send or keep it. */
const NOT_OFFERED = 'github' as unknown as JoinProvider;

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubNode(handlers: Record<string, () => Response>) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        const key = Object.keys(handlers).find((k) => path === k || path.startsWith(k));
        return key ? handlers[key]() : json(404, { error: 'Not Found' });
    }));
}

/** The sign-in buttons on screen, by the provider their test id names, in the order drawn. */
function buttonsNamed(prefix: string): string[] {
    return screen.getAllByRole('button')
        .map((b) => b.getAttribute('data-testid') ?? '')
        .filter((id) => id.startsWith(prefix))
        .map((id) => id.slice(prefix.length));
}

function expectNoGithubAnywhere() {
    expect(document.body.textContent ?? '').not.toMatch(/git\s*hub/i);
    expect(document.body.innerHTML).not.toMatch(/github/i);
}

let identity: BeanPoolIdentity;
beforeEach(async () => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetCapturedAuthReturn();
    identity = await generateIdentity('Alice');
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.mocked(api.getSignInRecovery).mockReset();
});

describe('the join: "Sign in with" offers Google, Apple and Facebook only', () => {
    it('a node that names more (with an id for it, and the old device-flow flag) still gets only the three', async () => {
        const now = Date.now();
        await savePendingJoin({ identity, provider: null, nonce: null, startedAt: now, expiresAt: now + PENDING_JOIN_TTL_MS, restored: false });
        stubNode({
            '/api/join/sso-nonce': () => json(200, {
                nonce: 'n-1', expiresInSeconds: 600, providers: ['google', 'github', 'apple', 'facebook'], githubFlow: 'node',
                clientIds: { google: 'web-client', apple: 'org.beanpool.web', facebook: '818892721251369', github: 'Iv1.fixture' },
            }),
        });
        render(<WebJoin onJoined={vi.fn()} onRestore={vi.fn()} navigate={vi.fn()} origin={ORIGIN} authReturn={null} />);
        await screen.findByTestId('join-provider-facebook');
        expect(buttonsNamed('join-provider-')).toEqual(OFFERED);
        expectNoGithubAnywhere();
    });

    it("a pending join an older build left naming GitHub keeps its key and its sent mark, and asks for one of the three", async () => {
        const now = Date.now();
        await savePendingJoin({ identity, provider: NOT_OFFERED, nonce: null, startedAt: now, expiresAt: now + PENDING_JOIN_TTL_MS, restored: false, sentAt: now });
        // Read back: the key and the mark as they were; the sign-in, none.
        expect(await loadPendingJoin()).toMatchObject({ identity: { publicKey: identity.publicKey, mnemonic: identity.mnemonic }, provider: null, sentAt: now });

        stubNode({
            '/api/community/membership/': () => json(200, { isMember: false, callsign: null }),
            '/api/join/sso-nonce': () => json(200, {
                nonce: 'n-1', expiresInSeconds: 600, providers: OFFERED,
                clientIds: { google: 'web-client', apple: 'org.beanpool.web', facebook: '818892721251369' },
            }),
        });
        render(<WebJoin onJoined={vi.fn()} onRestore={vi.fn()} navigate={vi.fn()} origin={ORIGIN} authReturn={null} />);
        await screen.findByTestId('join-provider-facebook');
        expect(buttonsNamed('join-provider-')).toEqual(OFFERED);
        expectNoGithubAnywhere();
        expect(await loadPendingJoin()).toMatchObject({ identity: { publicKey: identity.publicKey }, sentAt: now });
    });
});

describe("the restore: the sign-ins offered are Google, Apple and Facebook only", () => {
    it('a node that gives an id for more still gets only the three, in their own order', async () => {
        stubNode({
            '/api/recovery/lookup/': () => json(200, [{ publicKey: identity.publicKey, callsign: 'Alice', canRecoverBySso: true }]),
            '/api/recovery/collect/sso-nonce': () => json(200, {
                nonce: 'rn-1', expiresInSeconds: 600, githubFlow: 'node',
                clientIds: { github: 'Iv1.fixture', facebook: '818892721251369', google: 'web-client', apple: 'org.beanpool.web' },
            }),
            '/api/recovery/collect': () => json(200, { collectionId: 'col-1', threshold: 1 }),
        });
        render(<WebRestore onRestored={vi.fn(async () => true)} onHeld={vi.fn()} onExisting={vi.fn()} onBack={vi.fn()} onOtherWay={vi.fn()}
            navigate={vi.fn()} origin={ORIGIN} authReturn={null} />);
        fireEvent.change(await screen.findByTestId('restore-callsign'), { target: { value: 'Alice' } });
        fireEvent.click(await screen.findByRole('button', { name: 'Alice' }));
        await screen.findByTestId('restore-provider-facebook');
        expect(buttonsNamed('restore-provider-')).toEqual(OFFERED);
        expectNoGithubAnywhere();
    });

    it('a pending restore an older build left naming GitHub is dropped, as anything else in that slot that is not one', async () => {
        const now = Date.now();
        const restore: PendingRestore = {
            kind: 'restore', ephemeral: makeEphemeralKey(), account: { publicKey: identity.publicKey, callsign: 'Alice' },
            collectionId: 'col-1', provider: NOT_OFFERED, nonce: 'rn-9', startedAt: now, expiresAt: now + PENDING_RESTORE_TTL_MS,
        };
        await savePendingRestore(restore);
        expect(await loadPendingRestore()).toBeNull();
        // One naming a sign-in this app offers is kept, as before.
        await savePendingRestore({ ...restore, provider: 'apple' });
        expect(await loadPendingRestore()).toMatchObject({ provider: 'apple', nonce: 'rn-9' });
    });
});

describe("Settings: the sign-in recovery line names Google, Apple and Facebook only", () => {
    function renderSettings() {
        const me = { ...identity, callsign: 'Me' };
        render(<SettingsPage identity={me} onIdentityUpdated={() => {}} onBack={() => {}} themePreference="system" onThemePreferenceChange={() => {}} />);
    }

    it('a node that lists more names the three it may, and nothing else', async () => {
        vi.mocked(api.getSignInRecovery).mockResolvedValue(['google', 'github', 'apple', 'facebook']);
        renderSettings();
        expect(await screen.findByTestId('signin-recovery')).toHaveTextContent('Sign-in recovery: connected (Google, Apple and Facebook)');
        expect(screen.getByTestId('signin-recovery')).not.toHaveTextContent(/git\s*hub/i);
    });

    it('a node that lists only GitHub: not connected, and the 12 words are the way back', async () => {
        vi.mocked(api.getSignInRecovery).mockResolvedValue(['github']);
        renderSettings();
        const line = await screen.findByTestId('signin-recovery');
        expect(line).toHaveTextContent('Sign-in recovery: not connected');
        expect(line).toHaveTextContent('Your 12 words are the way back to this account.');
        expect(line).not.toHaveTextContent(/git\s*hub/i);
    });
});
