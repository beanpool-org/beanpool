import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { vaultB64, vaultUnb64 } from '@beanpool/core';
import { VaultDb } from '../api/db.js';
import { deposit, depositBody, doGenesis, newMember, signed, startVault, type Genesis, type Member, type VaultUnderTest } from './harness.js';

/**
 * A copy for a sign-in the vault no longer keeps goes when the database opens (api/server.ts dropRetiredCopies): GitHub,
 * since 2026-09-29, whose `sub` is the account's public user id. With its deletion record, so a restore from an older
 * backup drops it again (§1.7), and its holds with it; every other copy, the same member's included, stays as it was.
 *
 * The provider list is this file's own (shared/providers.ts, mocked), so a GitHub copy can be put in the database as a
 * vault that still kept them stored one, through the keyholder itself, and then GitHub retired as it was.
 */

const kept = vi.hoisted(() => ({ providers: ['google', 'apple', 'facebook', 'github'] as string[] }));
vi.mock('../shared/providers.js', () => ({
    get VAULT_PROVIDERS() {
        return kept.providers;
    },
    isVaultProvider: (value: unknown) => typeof value === 'string' && kept.providers.includes(value),
}));

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

let v: VaultUnderTest;
let g: Genesis;
beforeEach(async () => {
    kept.providers = ['google', 'apple', 'facebook', 'github'];
    v = await startVault();
    g = await doGenesis(v);
});
afterEach(async () => {
    await v.close();
});

/** A GitHub copy as a vault that kept them stored one: wrapped by the keyholder, the row written as the deposit route writes it. */
async function plantGithubCopy(member: Member, sub: string): Promise<string> {
    const { box } = await depositBody(g, member, 'github' as never, sub);
    const id = vaultB64(Buffer.from(sub.padEnd(16, '0')));
    const wrapped = v.keyholder().depositWrap({ id, provider: 'github', sub, memberKey: member.key, box, carry: null });
    const bytes = (s: string) => Buffer.from(vaultUnb64(s, 64 * 1024) ?? []);
    const db = VaultDb.open(v.dataDir);
    db.insertCopy({ id, sub_index: bytes(wrapped.subIndex), pk_index: bytes(wrapped.pkIndex), envelope: bytes(wrapped.envelope), updated_day: '2026-09-28' });
    db.close();
    return id;
}

const providersOf = async (member: Member) =>
    ((await signed(v, '/v1/copies/status', {}, member.seed)).body.copies as { provider: string }[]).map(c => c.provider).sort();

describe('a sign-in the vault no longer keeps', () => {
    it('its copies go when the database opens, with deletion records; every other copy stays', async () => {
        const both = newMember();
        const githubOnly = newMember();
        const googleOnly = newMember();
        expect((await deposit(v, g, both, 'google', '109876543210987654321')).status).toBe(200);
        expect((await deposit(v, g, googleOnly, 'apple', '001234.abcdef0123456789.0123')).status).toBe(200);
        const bothGithub = await plantGithubCopy(both, '24680');
        const onlyGithub = await plantGithubCopy(githubOnly, '13579');
        expect(await providersOf(both)).toEqual(['github', 'google']);
        expect(await providersOf(githubOnly)).toEqual(['github']);

        const before = new DatabaseSync(path.join(v.dataDir, 'vault.db'), { readOnly: true });
        const others = (before.prepare("SELECT id, envelope FROM copies WHERE id NOT IN (?, ?) ORDER BY id").all(bothGithub, onlyGithub) as { id: string; envelope: Uint8Array }[])
            .map(r => ({ id: r.id, envelope: Buffer.from(r.envelope).toString('base64') }));
        before.close();
        expect(others).toHaveLength(2);

        // GitHub stops being a sign-in the vault keeps, as the release that dropped it did; the API starts again.
        retire('github');
        const log = vi.spyOn(console, 'log');
        await v.restartApi();
        await providersOf(googleOnly); // the first request opens the database
        await v.api.idle();

        expect(await providersOf(both)).toEqual(['google']);
        expect(await providersOf(githubOnly)).toEqual([]);
        expect(await providersOf(googleOnly)).toEqual(['apple']);
        const after = new DatabaseSync(path.join(v.dataDir, 'vault.db'), { readOnly: true });
        const left = (after.prepare('SELECT id, envelope FROM copies ORDER BY id').all() as { id: string; envelope: Uint8Array }[])
            .map(r => ({ id: r.id, envelope: Buffer.from(r.envelope).toString('base64') }));
        const deletions = (after.prepare('SELECT copy_id FROM deletions ORDER BY copy_id').all() as { copy_id: string }[]).map(r => r.copy_id);
        after.close();
        expect(left).toEqual(others);
        expect(deletions).toEqual([bothGithub, onlyGithub].sort());

        const lines = log.mock.calls.map(c => c.join(' ')).filter(l => /no longer keeps/.test(l));
        log.mockRestore();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/removed 2 copies/);
        for (const m of [both, githubOnly, googleOnly]) expect(lines[0]).not.toContain(m.key);

        // A second start finds nothing more.
        const again = vi.spyOn(console, 'log');
        await v.restartApi();
        await providersOf(googleOnly);
        await v.api.idle();
        const second = again.mock.calls.map(c => c.join(' ')).filter(l => /no longer keeps/.test(l));
        again.mockRestore();
        expect(second).toEqual([]);
    });
});

function retire(provider: string): void {
    kept.providers = kept.providers.filter(p => p !== provider);
}
