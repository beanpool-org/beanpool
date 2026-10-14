import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vaultTicketNonce } from '@beanpool/core';
import { VAULT_PROVIDERS, isVaultProvider } from '../shared/providers.js';
import { doGenesis, newMember, signed, startVault, ticketFor, type Genesis, type VaultUnderTest } from './harness.js';

/**
 * The sign-ins the vault keeps copies for: Google, Apple and Facebook. GitHub is not one (Marty, 2026-09-29): its `sub`
 * is the account's public user id, so a copy locked to it is locked to nothing its owner controls. It is refused at
 * every route that names a provider, before anything else runs, and its device-flow routes are gone.
 */

let v: VaultUnderTest;
let g: Genesis;
beforeEach(async () => {
    v = await startVault();
    g = await doGenesis(v);
});
afterEach(async () => {
    await v.close();
});

describe('the providers the vault keeps copies for', () => {
    it('Google, Apple and Facebook, and no GitHub', () => {
        expect([...VAULT_PROVIDERS]).toEqual(['google', 'apple', 'facebook']);
        expect(isVaultProvider('github')).toBe(false);
    });

    it('a GitHub ticket, deposit or restore is refused as no provider the vault keeps', async () => {
        const member = newMember();
        const ticket = await signed(v, '/v1/ticket', { purpose: 'deposit', provider: 'github' }, member.seed);
        expect(ticket).toMatchObject({ status: 400, body: { code: 'bad_provider' } });

        // With a ticket for another sign-in, as a client that asked for one would hold.
        const google = await ticketFor(v, member.seed, 'deposit', 'google');
        const deposit = await signed(v, '/v1/copies', { ticket: google, provider: 'github', proof: { sessionId: 'x' }, box: {} }, member.seed);
        expect(deposit).toMatchObject({ status: 400, body: { code: 'bad_provider' } });
        const restoreTicket = await ticketFor(v, member.seed, 'restore', 'google');
        const restore = await signed(v, '/v1/restore', { ticket: restoreTicket, provider: 'github', idToken: 'x', nonce: vaultTicketNonce(restoreTicket) }, member.seed);
        expect(restore).toMatchObject({ status: 400, body: { code: 'bad_provider' } });
        expect(g.ticketKey).toBeTruthy();
    });

    it('the GitHub device-flow routes are gone', async () => {
        const member = newMember();
        const ticket = await ticketFor(v, member.seed, 'deposit', 'google');
        for (const route of ['/v1/github/start', '/v1/github/poll']) {
            const r = await signed(v, route, { ticket, sessionId: 'x' }, member.seed);
            expect({ route, ...r }).toMatchObject({ route, status: 404, body: { code: 'not_found' } });
        }
        expect(v.stub.calls.filter(u => /github/.test(u))).toEqual([]);
    });
});
