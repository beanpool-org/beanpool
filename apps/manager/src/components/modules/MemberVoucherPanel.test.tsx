import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemberVoucherPanel } from './MemberVoucherPanel';
import type { VoucherCard } from '../../lib/voucher-words';

const NODE = 'https://node.test';
const ALICE_PK = 'a'.repeat(64);
const BOB_HEX = 'b'.repeat(64);

const FIXTURE_ENTRY_CARD: VoucherCard = {
    memberPubkey: ALICE_PK,
    callsign: 'alice',
    source: 'entry',
    left: 550,
    level: 1000,
    held: 100,
    vouched: 350,
    history: [
        {
            kind: 'grant',
            amount: 1000,
            actor: 'node:claim',
            actorCallsign: null,
            at: '2026-11-05T12:00:00.000Z',
        },
        {
            kind: 'top_up',
            amount: 500,
            actor: 'm'.repeat(64),
            actorCallsign: 'marty',
            at: '2026-11-05T13:00:00.000Z',
        },
        {
            kind: 'lower',
            amount: -200,
            actor: 'm'.repeat(64),
            actorCallsign: 'marty',
            at: '2026-11-05T14:00:00.000Z',
        },
        {
            kind: 'hold',
            amount: -100,
            actor: ALICE_PK,
            actorCallsign: 'alice',
            at: '2026-11-05T15:00:00.000Z',
            for: 'invite',
        },
        {
            kind: 'hold',
            amount: -50,
            actor: ALICE_PK,
            actorCallsign: 'alice',
            at: '2026-11-05T16:00:00.000Z',
            for: 'profile',
            person: { memberPubkey: 's'.repeat(64), callsign: 'sam' },
        },
        {
            kind: 'return',
            amount: 100,
            actor: 'node',
            actorCallsign: null,
            at: '2026-11-05T17:00:00.000Z',
            for: 'invite',
            why: 'expired',
        },
        {
            kind: 'return',
            amount: 100,
            actor: 'node',
            actorCallsign: null,
            at: '2026-11-05T17:30:00.000Z',
            for: 'invite',
            why: 'stopped',
        },
        {
            kind: 'return',
            amount: 100,
            actor: 'node',
            actorCallsign: null,
            at: '2026-11-05T17:45:00.000Z',
            for: 'invite',
            why: 'not_landed',
        },
        {
            kind: 'grant',
            amount: 1000,
            actor: 'migration:vouchers',
            actorCallsign: null,
            at: '2026-11-05T18:00:00.000Z',
        },
        {
            kind: 'stop',
            amount: 0,
            actor: 'server:recover',
            actorCallsign: null,
            at: '2026-11-05T19:00:00.000Z',
        },
        {
            kind: 'top_up',
            amount: 250,
            actor: BOB_HEX,
            actorCallsign: null,
            at: '2026-11-05T20:00:00.000Z',
        },
    ],
};

const FIXTURE_ROLE_CARD: VoucherCard = {
    ...FIXTURE_ENTRY_CARD,
    source: 'role',
};

describe('MemberVoucherPanel', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('renders the voucher panel line for names list voucher with 550 of 1,000 left', () => {
        const { container } = render(
            <MemberVoucherPanel
                nodeUrl={NODE}
                pubkey={ALICE_PK}
                displayName="Alice"
                initialCard={FIXTURE_ENTRY_CARD}
            />
        );

        expect(screen.getByTestId('voucher-panel-header').textContent).toBe(
            'Voucher · 550 of 1,000 left · made from the names list'
        );

        // Verify history renders in words
        expect(screen.getByText(/the community’s first owner/i)).toBeDefined();
        expect(screen.getByText(/top-up by @marty/i)).toBeDefined();
        expect(screen.getByText(/lower by @marty/i)).toBeDefined();
        expect(screen.getByText(/held for an invite/i)).toBeDefined();
        expect(screen.getByText(/held for @sam/i)).toBeDefined();
        expect(screen.getByText(/back, invite expired/i)).toBeDefined();
        expect(screen.getByText(/back, budget stopped/i)).toBeDefined();
        expect(screen.getByText(/back, vouch didn’t land/i)).toBeDefined();
        expect(screen.getByText(/BeanPool, when vouchers started/i)).toBeDefined();
        expect(screen.getByText(/the server’s shell/i)).toBeDefined();
        expect(screen.getByText(/someone who has left/i)).toBeDefined();

        const fullText = container.textContent || '';

        // NO 64-hex key in rendered text
        expect(fullText).not.toMatch(/[0-9a-f]{64}/i);

        // NO raw enum words in rendered text
        expect(fullText).not.toMatch(/\bgrant\b/i);
        expect(fullText).not.toMatch(/\btop_up\b/i);
        expect(fullText).not.toMatch(/\bnot_landed\b/i);
    });

    it('renders "by role" when source is role', () => {
        render(
            <MemberVoucherPanel
                nodeUrl={NODE}
                pubkey={ALICE_PK}
                displayName="Alice"
                initialCard={FIXTURE_ROLE_CARD}
            />
        );

        expect(screen.getByTestId('voucher-panel-header').textContent).toBe(
            'Voucher · 550 of 1,000 left · by role'
        );
    });

    it('fetches card from node and renders nothing on 404 (not a voucher)', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            new Response(JSON.stringify({ error: 'not_voucher' }), { status: 404 })
        );

        const { container } = render(
            <MemberVoucherPanel
                nodeUrl={NODE}
                pubkey={ALICE_PK}
                displayName="Alice"
            />
        );

        await waitFor(() => {
            expect(container.firstChild).toBeNull();
        });
    });

    it('fetches card from node and renders when member is a voucher', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            new Response(JSON.stringify(FIXTURE_ENTRY_CARD), { status: 200 })
        );

        render(
            <MemberVoucherPanel
                nodeUrl={NODE}
                pubkey={ALICE_PK}
                displayName="Alice"
            />
        );

        await waitFor(() => {
            expect(screen.getByTestId('voucher-panel-header')).toBeDefined();
        });
        expect(screen.getByTestId('voucher-panel-header').textContent).toBe(
            'Voucher · 550 of 1,000 left · made from the names list'
        );
    });
});
