import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { OwnerUnlockSessions, readSealedHeader, sealEnvelope, toEd25519Pkcs8 } from '@beanpool/core';
import { OwnerUnlockCard } from './OwnerUnlockCard';
import { request } from '../lib/api';
import { lockPinKey, resetLockOpenCheckForTests } from '../lib/takeover-unlock';

vi.mock('../lib/api', () => ({ request: vi.fn(), getNodeApiUrl: vi.fn(() => '') }));

const seed = randomBytes(32);
const me = { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(toEd25519Pkcs8(seed)) };

function renderAt320(ui: React.ReactElement) {
    Object.defineProperty(window, 'innerWidth', { value: 320, configurable: true, writable: true });
    document.documentElement.style.fontSize = '130%';
    return render(ui);
}

beforeEach(() => {
    vi.clearAllMocks();
    resetLockOpenCheckForTests();
    localStorage.clear();
    // The main server is gone: every call to it fails.
    vi.mocked(request).mockRejectedValue(new Error('Failed to fetch'));
});

describe('OwnerUnlockCard', () => {
    it('is not shown to someone this browser does not know as an owner', () => {
        const { container } = renderAt320(<OwnerUnlockCard identity={me} />);
        expect(container.innerHTML).toBe('');
    });

    it('with the main server gone, a remembered owner pastes the code, sees what will happen, and unlocks', async () => {
        const nodeSeed = randomBytes(32);
        // A PeerId for the node key (identity multihash), as the server names itself in the header.
        const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        const bytes = [0x00, 0x24, 0x08, 0x01, 0x12, 0x20, ...ed25519.getPublicKey(nodeSeed)];
        let n = BigInt('0x' + bytesToHex(new Uint8Array(bytes)));
        let peer = '';
        while (n > 0n) { peer = B58[Number(n % 58n)] + peer; n /= 58n; }
        peer = '1' + peer;
        const env = await sealEnvelope(new TextEncoder().encode('{}'), {
            kind: 'takeover', communityId: 'c0ffee0000000003', nodePeerId: peer, signingKey: nodeSeed,
            recipients: { owners: [{ pubkey: me.publicKey, callsign: 'me' }] },
        });
        const header = readSealedHeader(env);
        localStorage.setItem(lockPinKey(me.publicKey), JSON.stringify({ communityId: 'c0ffee0000000003', nodePeerId: peer, lastEnvelopeId: null, owner: true }));
        const sessions = new OwnerUnlockSessions<null>();
        const session = sessions.create('takeover', header, null);
        const link = (await import('@beanpool/core')).buildOwnerUnlockLink(sessions.qrFor(session, 'https://standby.example.org'));

        const posted: unknown[] = [];
        globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method === 'POST') {
                posted.push(JSON.parse(String(init.body)));
                return { ok: true, status: 200, json: async () => ({ success: true, purpose: 'takeover' }) } as Response;
            }
            return { ok: true, status: 200, json: async () => ({ purpose: 'takeover', header, expiresAt: session.expiresAt, takeover: { sealedAt: header.createdAt, mainServerAnswers: true, lastCopyAt: null, missing: [] } }) } as Response;
        }) as typeof fetch;

        renderAt320(<OwnerUnlockCard identity={me} communityName="Anna Town" />);
        fireEvent.click(screen.getByRole('button', { name: 'Paste a code' }));
        fireEvent.change(screen.getByLabelText(/code from the server/i), { target: { value: link } });
        fireEvent.click(screen.getByRole('button', { name: 'Check the code' }));
        await screen.findByText('Take over Anna Town on standby.example.org?');
        expect(screen.getByRole('alert').textContent).toMatch(/still answers/);
        expect(screen.getByText(/the phone app is safer/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Unlock for the take-over' }));
        await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Now finish on standby\.example\.org's screen/));
        expect(posted).toHaveLength(1);
        expect(sessions.redeem(session.keys.sessionId, posted[0]).signer).toBe(me.publicKey);

        // 48px targets throughout.
        for (const b of screen.getAllByRole('button')) expect(b.className).toMatch(/min-h-\[48px\]/);
    });
});
