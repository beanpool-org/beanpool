import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { parseInviteTicketText, signedRequestBytes, toEd25519Pkcs8 } from '@beanpool/core';

/**
 * An offline invite ticket made in the web app (Invite → Generate, when the node can't be reached) names the
 * community it was made for, in @beanpool/core's format 2, so a ticket made for community A can't be used to join B
 * (the server refuses it there). Before, it was `{i, t, f}` JSON that named no community, valid for 30 days anywhere
 * the inviter was a member.
 */

vi.mock('../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/api')>();
    return {
        ...actual,
        // The node can't be reached, so the page makes a ticket itself.
        generateInvite: vi.fn(async () => { throw new Error('Failed to fetch'); }),
        getMyInvites: vi.fn(async () => ({ invites: [] })),
        getInviteTree: vi.fn(async () => []),
    };
});

// The QR code isn't what is under test, and qrcode.react brings its own copy of React.
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => null }));

import { InvitePage } from './InvitePage';

const SEED = Uint8Array.from({ length: 32 }, (_, i) => 7 * i + 3);
const PUB = bytesToHex(ed25519.getPublicKey(SEED));
const IDENTITY = { publicKey: PUB, privateKey: bytesToHex(toEd25519Pkcs8(SEED)), callsign: 'Ana', createdAt: '2026-09-27T00:00:00.000Z' };

/** The `{p, s}` a `BP-` code carries (URL-safe base64, no padding). */
function ticketOf(code: string): { p: string; s: string } {
    expect(code.startsWith('BP-')).toBe(true);
    const b64 = code.slice(3).replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
}

async function generate(forWhom: string): Promise<string> {
    render(<InvitePage identity={IDENTITY} />);
    fireEvent.change(screen.getByPlaceholderText('Who is this invite for? (For your records)'), { target: { value: forWhom } });
    fireEvent.click(screen.getByRole('button', { name: /Generate New Invite/ }));
    const shown = await waitFor(() => {
        const el = document.querySelector('p[title^="BP-"]');
        expect(el).not.toBeNull();
        return el as HTMLElement;
    });
    return shown.getAttribute('title')!;
}

beforeEach(() => {
    localStorage.clear();
});

describe('an offline ticket from the web app names this community', () => {
    it('on the page\'s own node: format 2 for this host, the inviter, and who it is for, signed as 0xFF then that text', async () => {
        const before = Date.now();
        const code = await generate('  Robin  ');
        const { p, s } = ticketOf(code);

        const parsed = parseInviteTicketText(p);
        expect(parsed).not.toBeNull();
        expect(parsed!.host).toBe(window.location.hostname.toLowerCase());
        expect(parsed!.inviter).toBe(PUB);
        expect(parsed!.intendedFor).toBe('Robin');
        expect(parsed!.timestamp).toBeGreaterThanOrEqual(before);
        expect(parsed!.timestamp).toBeLessThanOrEqual(Date.now());

        const sig = Uint8Array.from(atob(s), c => c.charCodeAt(0));
        expect(ed25519.verify(sig, signedRequestBytes(p), hexToBytes(PUB))).toBe(true);
        // Not over the text alone: nothing an app ever signed as plain text can pass for it.
        expect(ed25519.verify(sig, new TextEncoder().encode(p), hexToBytes(PUB))).toBe(false);

        // Kept for the inviter's list, with who it is for.
        const kept = JSON.parse(localStorage.getItem(`bp_offline_invites_${PUB}`)!);
        expect(kept[0]).toMatchObject({ code, createdBy: PUB, intendedFor: 'Robin' });
    });

    it('with a detached bp_node_url, for that node\'s host', async () => {
        localStorage.setItem('bp_node_url', 'https://Castle.Example:8443');
        const { p } = ticketOf(await generate(''));

        const parsed = parseInviteTicketText(p);
        expect(parsed?.host).toBe('castle.example');
        expect(parsed?.intendedFor).toBeUndefined();
    });
});
