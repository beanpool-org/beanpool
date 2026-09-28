import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildBoundRequestHeaders, ed25519Signer, vaultTicketNonce } from '@beanpool/core';
import type { SsoProvider } from '@beanpool/signin';
import {
    credential,
    deposit,
    depositBody,
    doGenesis,
    newMember,
    scan,
    signed,
    startRestore,
    startVault,
    ticketFor,
    type Genesis,
    type VaultUnderTest,
} from './harness.js';

/**
 * Deposits (key vault design §1.1, §1.4, §1.7; V2's "Deposit", "Delete" and "Replace" tests): what is stored and what
 * never is, every way a sign-in is refused (with the ticket left unspent), a replace, and a delete.
 */

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

let v: VaultUnderTest;
let g: Genesis;
beforeEach(async () => {
    v = await startVault();
    g = await doGenesis(v);
});
afterEach(async () => {
    await v.close();
});

describe('what the database holds', () => {
    it('no sub, no member key (hex, raw or base64) and no email, for any provider', async () => {
        const member = newMember();
        const subs: Record<SsoProvider, string> = { google: '109876543210987654321', apple: '001234.abcdef0123456789.0123', facebook: '10160000000000001', github: '98765432' };
        for (const provider of Object.keys(subs) as SsoProvider[]) {
            const r = await deposit(v, g, member, provider, subs[provider], { email: `m.${provider}@example.com`, pushToken: 'ExponentPushToken[device-a]' });
            expect({ provider, ...r }).toMatchObject({ provider, status: 200, body: { ok: true, replaced: false } });
        }
        await v.api.runBackup();
        const raw = Buffer.from(member.key, 'hex');
        const needles = [
            ...Object.values(subs), member.key, member.key.toUpperCase(), raw, raw.toString('base64'), raw.toString('base64url'),
            'example.com', 'm.google@', 'user98765432', 'ExponentPushToken',
        ];
        expect(scan(v.dataDir, needles)).toEqual([]);
        // The scan sees what is there: each row's day is stored in the clear.
        expect(scan(v.dataDir, [new Date(v.clock.now()).toISOString().slice(0, 10)])).not.toEqual([]);
        expect(scan(v.storeDir, needles)).toEqual([]);
        expect(scan(v.stateDir, needles)).toEqual([]);
        const status = await signed(v, '/v1/copies/status', {}, member.seed);
        expect(status.body.copies.map((c: { provider: string }) => c.provider).sort()).toEqual(['apple', 'facebook', 'github', 'google']);
        expect(JSON.stringify(status.body)).not.toMatch(/encryptedShare|clientCopy|envelope/);
    });

    it('the GitHub check tells the phone the account id and nothing else', async () => {
        const member = newMember();
        const ticket = await ticketFor(v, member.seed, 'deposit', 'github');
        v.stub.githubUserId = 4242;
        const start = await signed(v, '/v1/github/start', { ticket }, member.seed);
        v.clock.advance(6_000);
        const poll = await signed(v, '/v1/github/poll', { ticket, sessionId: start.body.sessionId }, member.seed);
        expect(poll.body).toEqual({ status: 'ok', sub: '4242' });
    });
});

describe('a refused sign-in leaves the ticket unspent', () => {
    async function depositWith(member = newMember(), over: { ticket?: string; aud?: string; nonce?: string; signer?: Uint8Array } = {}) {
        const ticket = over.ticket ?? await ticketFor(v, member.seed, 'deposit', 'google');
        const cred = await credential(v, member.seed, 'google', 'sub-refusals', ticket, { aud: over.aud, nonce: over.nonce });
        const { box } = await depositBody(g, member, 'google', 'sub-refusals');
        return { ticket, reply: await signed(v, '/v1/copies', { ticket, provider: 'google', ...cred, box }, over.signer ?? member.seed) };
    }

    it('another key\'s ticket', async () => {
        const owner = newMember();
        const thief = newMember();
        const ticket = await ticketFor(v, owner.seed, 'deposit', 'google');
        const cred = await credential(v, thief.seed, 'google', 'sub-refusals', ticket);
        const { box } = await depositBody(g, thief, 'google', 'sub-refusals');
        const refused = await signed(v, '/v1/copies', { ticket, provider: 'google', ...cred, box }, thief.seed);
        expect(refused.status).toBe(401);
        expect(refused.body.code).toBe('ticket_wrong_key');
        expect((await depositWith(owner, { ticket })).reply.status).toBe(200);
    });

    it('a reused ticket', async () => {
        const member = newMember();
        const first = await depositWith(member);
        expect(first.reply.status).toBe(200);
        const again = await depositWith(member, { ticket: first.ticket });
        expect(again.reply.status).toBe(401);
        expect(again.reply.body.code).toBe('ticket_used');
    });

    it('a wrong audience', async () => {
        const member = newMember();
        const refused = await depositWith(member, { aud: 'someone-elses-app.apps.googleusercontent.com' });
        expect(refused.reply.status).toBe(401);
        expect(refused.reply.body.code).toBe('signin_refused');
        expect((await depositWith(member, { ticket: refused.ticket })).reply.status).toBe(200);
    });

    it('a community\'s nonce', async () => {
        const member = newMember();
        const communityNonce = crypto.randomBytes(32).toString('base64url');
        const refused = await depositWith(member, { nonce: communityNonce });
        expect(refused.reply.status).toBe(401);
        expect(refused.reply.body.code).toBe('signin_refused');
        expect((await depositWith(member, { ticket: refused.ticket })).reply.status).toBe(200);
    });

    it('a restore ticket, and a request signed for a community rather than the vault', async () => {
        const member = newMember();
        const restoreTicket = await ticketFor(v, member.seed, 'restore', 'google');
        const wrongPurpose = await depositWith(member, { ticket: restoreTicket });
        expect(wrongPurpose.reply.body.code).toBe('ticket_wrong_purpose');

        const ticket = await ticketFor(v, member.seed, 'deposit', 'google');
        const cred = await credential(v, member.seed, 'google', 'sub-refusals', ticket);
        const { box } = await depositBody(g, member, 'google', 'sub-refusals');
        const text = JSON.stringify({ ticket, provider: 'google', ...cred, box });
        const headers = await buildBoundRequestHeaders({
            method: 'POST', url: 'https://mullum.beanpool.org/v1/copies', body: text, publicKeyHex: member.key,
            sign: ed25519Signer(member.seed), timestamp: v.clock.now(),
        });
        const res = await fetch(`${v.baseUrl}/v1/copies`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: text });
        expect(res.status).toBe(421);
        expect((await depositWith(member, { ticket })).reply.status).toBe(200);
    });

    it('Apple\'s hashed nonce is accepted, as today', async () => {
        const member = newMember();
        const ticket = await ticketFor(v, member.seed, 'deposit', 'apple');
        const hashed = crypto.createHash('sha256').update(vaultTicketNonce(ticket), 'utf8').digest('hex');
        const cred = await credential(v, member.seed, 'apple', 'apple-sub', ticket, { nonce: hashed });
        const { box } = await depositBody(g, member, 'apple', 'apple-sub');
        expect((await signed(v, '/v1/copies', { ticket, provider: 'apple', ...cred, box }, member.seed)).status).toBe(200);
    });
});

describe('replace and delete', () => {
    it('a deposit for the same Google account under another key replaces the copy and tells the old key\'s devices', async () => {
        const old = newMember();
        const next = newMember();
        expect((await deposit(v, g, old, 'google', 'shared-google-sub', { pushToken: 'ExponentPushToken[old-phone]' })).status).toBe(200);
        const r = await deposit(v, g, next, 'google', 'shared-google-sub', { pushToken: 'ExponentPushToken[new-phone]' });
        expect(r.body).toMatchObject({ ok: true, replaced: true });
        await v.api.idle();
        expect(v.stub.pushes).toHaveLength(1);
        const [msg] = v.stub.pushes[0].messages;
        expect(msg.to).toBe('ExponentPushToken[old-phone]');
        expect(msg.body).toContain('now protects a different BeanPool account. This one has only its 12 words.');
        expect(msg.data).toEqual({ type: 'vault-replaced' });
        expect((await signed(v, '/v1/copies/status', {}, old.seed)).body.copies).toEqual([]);
        expect((await signed(v, '/v1/copies/status', {}, next.seed)).body.copies).toHaveLength(1);
    });

    it('delete removes the row and its bytes (after VACUUM), and a later restore finds no copy', async () => {
        const member = newMember();
        await deposit(v, g, member, 'google', 'to-delete');
        await deposit(v, g, member, 'github', '777');
        const dbFile = path.join(v.dataDir, 'vault.db');
        const reader = new DatabaseSync(dbFile, { readOnly: true });
        const rows = reader.prepare('SELECT id, envelope FROM copies').all() as { id: string; envelope: Uint8Array }[];
        reader.close();
        expect(rows).toHaveLength(2);

        const del = await signed(v, '/v1/copies/delete', { provider: 'google' }, member.seed);
        expect(del.body).toEqual({ deleted: 1 });
        const status = await signed(v, '/v1/copies/status', {}, member.seed);
        expect(status.body.copies.map((c: { provider: string }) => c.provider)).toEqual(['github']);

        const vac = new DatabaseSync(dbFile);
        vac.exec('VACUUM');
        const left = vac.prepare('SELECT id FROM copies').all() as { id: string }[];
        const deletions = (vac.prepare('SELECT COUNT(*) AS n FROM deletions').get() as { n: number }).n;
        vac.close();
        expect(left).toHaveLength(1);
        expect(deletions).toBe(1);
        const gone = rows.find(r => !left.some(l => l.id === r.id))!;
        const kept = rows.find(r => left.some(l => l.id === r.id))!;
        const envelope = Buffer.from(gone.envelope);
        // The envelope's bytes are gone. Its random id stays in the deletion record (§1.7), which is how an older backup
        // restored later knows to drop this copy; it says nothing about anyone.
        expect(scan(v.dataDir, [envelope.subarray(5, 37), envelope.subarray(40, 72), envelope.subarray(envelope.length - 32)])).toEqual([]);
        // The scan can see a row: the one still kept is found.
        expect(scan(v.dataDir, [Buffer.from(kept.envelope).subarray(5, 37)])).toHaveLength(1);

        const { reply } = await startRestore(v, 'google', 'to-delete');
        expect(reply.status).toBe(404);
        expect(reply.body.code).toBe('no_copy');
    });

    it('delete all, and a push token set on every copy of the key', async () => {
        const member = newMember();
        await deposit(v, g, member, 'google', 'g-1');
        await deposit(v, g, member, 'apple', 'a-1');
        const set = await signed(v, '/v1/push-token', { token: 'ExponentPushToken[later]' }, member.seed);
        expect(set.body).toEqual({ updated: 2 });
        const bad = await signed(v, '/v1/push-token', { token: 'not-a-token' }, member.seed);
        expect(bad.status).toBe(400);
        const del = await signed(v, '/v1/copies/delete', { all: true }, member.seed);
        expect(del.body).toEqual({ deleted: 2 });
    });
});
