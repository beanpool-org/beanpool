import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openSeedFromSso, openVaultRelease } from '@beanpool/core';
import type { SsoProvider } from '@beanpool/signin';
import { HOLD_MS } from '../api/server.js';
import { sealKeyFile } from '../custodian/keyfile.js';
import { confirmShare, listBackups, presentShare, restoreFromBackup, sendSettings, type CallOptions, type CustodianKey } from '../custodian/lib.js';
import { snpChecker } from '../custodian/snp-checker.js';
import type { Attestor } from '../keyholder/attestor.js';
import { parseBackupFile } from '../shared/backup-format.js';
import type { CustodianShare } from '../shared/ceremony.js';
import { API_BUNDLE_ASSET, LocalDirectoryFeed, MANIFEST_ASSET, SIGNATURES_ASSET } from '../shared/release-feed.js';
import { imageHashOf, type HostPolicySevSnp, type ReleaseManifest } from '../shared/release.js';
import { doGenesis, deposit, get, newMember, signed, startRestore, startVault, type Clock, type Member, type VaultUnderTest } from './harness.js';
import { keys3, makeRelease, publish, randomImage } from './release-kit.js';
import { evidenceOf, fixedCollateral, NOW, PROBE_TCB, reportBytes, signReport, testAmd, type TestAmd } from './snp-kit.js';
import { StubS3 } from './stubs.js';

/**
 * The key vault's comeback on the SEV-SNP host with the SAME custodian keys (Marty, 27 Nov 2026: "no just use the same
 * keys"; scratch/vault-golive/RUNBOOK-servury-restore-2026-11.md, the DECIDED block, Parts 3 to 5 and Appendix B step 1),
 * rehearsed with throwaway keys G' in the in-process harness: no server, no real key, no R2, no AMD, no network.
 *
 *   1. A generation-1 vault on G' holds a member's copy and backs up to the off-box store (a stub S3).
 *   2. Image 1.1.0 pinned to the same G' keys (the custodian tool bundled with G' baked in, as build.sh does); release
 *      1.1.0 continues the G' chain after 1.0.1, with the servury host policy build.sh writes, signed by two G' keys;
 *      `release verify` passes. The chip check passes the fixture report and refuses tampered ones.
 *   3. Settings with two G' keys, restore from the backup, unlock with two G' shares: the copy reads back.
 *   4. Reshare with --new-custodians = the same three G' keys: allowed.
 *   5. Two G' confirm: the ticket key and the deposit key are new, the old shares open nothing, the next backup is
 *      generation 2, and the copy still reads back after a restart and an unlock with the new shares.
 *
 * Then the tool itself, as Marty will run it: with the same keys, the second `reshare` already confirms that custodian's
 * own new share, so ONE `fetch-share` afterwards is the switch.
 *
 * The chip check runs through the same checker the tool builds (snp-checker.ts), with a test-only AMD (snp-kit.ts) in
 * place of AMD's pinned roots and key server: the bundled tool can only reach the real ones.
 */

const VAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = mkdtempSync(path.join(os.tmpdir(), 'bv-same-keys-'));
const PASS = ['rehearsal-one', 'rehearsal-two', 'rehearsal-three'];
/** G': the three custodians, before and after. */
const G: CustodianKey[] = keys3();
const PUBS = G.map(k => k.publicKey);
const keyFiles: string[] = [];
let tool = '';
let amd: TestAmd;

/** The chip, and what it measures at launch for an image's UKI (as snp-unlock.test.ts makes them). */
const CHIP = crypto.createHash('sha512').update('the new host\'s chip').digest();
const CHIP8 = CHIP.toString('hex').slice(0, 8);
const measurementOf = (ukiSha256: string) => crypto.createHash('sha384').update(`launch of ${ukiSha256}`).digest();

const SUB = '111122223333444455556';

/** The options presentShare takes: a call's, and a reshare's purpose and new custodians. */
type ShareCall = CallOptions & { purpose?: 'unlock' | 'reshare'; newCustodians?: string[] };

function run(args: string[], o: { pass?: string } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise(resolve => {
        const child = spawn(process.execPath, args, {
            cwd: VAULT_ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, VAULT_CUSTODIAN_PASSPHRASE: o.pass ?? '' },
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.stdin.end('');
        child.once('exit', code => resolve({ code, stdout, stderr }));
    });
}
const cli = (args: string[], o: { pass?: string } = {}) => run([tool, ...args], o);

const realClock: Clock = { now: () => Date.now(), advance: () => undefined };
const shareOf = (shares: CustodianShare[], k: CustodianKey) => shares.find(s => s.custodian === k.publicKey) as CustodianShare;

async function expectCopy(v: VaultUnderTest, provider: SsoProvider, sub: string, member: Member): Promise<void> {
    const { e, reply } = await startRestore(v, provider, sub);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    v.clock.advance(HOLD_MS);
    const released = await signed(v, '/v1/restore/collect', { holdId: reply.body.holdId }, e);
    expect(released.body.status).toBe('released');
    const { seed } = await openSeedFromSso(openVaultRelease(released.body.release, e).clientCopy, provider, sub);
    expect(Buffer.from(seed).equals(Buffer.from(member.seed))).toBe(true);
}

beforeAll(async () => {
    amd = testAmd();
    G.forEach((k, i) => {
        const f = path.join(dir, `custodian-${i + 1}.json`);
        writeFileSync(f, sealKeyFile(k.seed, PASS[i], 2 ** 14), { mode: 0o600 });
        keyFiles.push(f);
    });
    // The bundles build.sh makes, with G' baked in: the image pins the SAME keys as generation 1.
    const keysJson = path.join(dir, 'genesis-custodians.json');
    writeFileSync(keysJson, JSON.stringify({ genesisCustodians: PUBS }));
    const b = await run(['scripts/bundle.mjs', '--custodian-keys', keysJson, '--out', path.join(dir, 'bundles')]);
    expect(b.code, b.stdout + b.stderr).toBe(0);
    tool = path.join(dir, 'bundles', 'vault-custodian.mjs');
}, 180_000);

const open: VaultUnderTest[] = [];
const stubs: StubS3[] = [];
afterEach(async () => {
    while (open.length) await open.pop()!.close();
    while (stubs.length) await stubs.pop()!.stop();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the comeback with the same custodian keys (runbook DECIDED 27 Nov)', () => {
    it('gen-1 backup → image 1.1.0 on the G\' chain with the servury policy → settings, restore, unlock with G\' → reshare to the same G\' → confirm', async () => {
        const times: string[] = [];
        let t = Date.now();
        const lap = (step: string) => { times.push(`${step} ${Date.now() - t} ms`); t = Date.now(); };

        // ─── 1. Generation 1 on G': a copy, a backup in both stores ───────────────────────────────
        const a = await startVault({ custodians: G });
        open.push(a);
        const g = await doGenesis(a);
        const s3 = await new StubS3().start();
        stubs.push(s3);
        const settings = { v: 1, offsite: s3.settings() };
        for (const i of [0, 1]) expect((await sendSettings(a.baseUrl, G[i], settings, a.call())).status).toBe(200);
        const member = newMember();
        expect((await deposit(a, g, member, 'google', SUB)).status).toBe(200);
        const backupName = await a.api.runBackup();
        expect(parseBackupFile(readFileSync(path.join(a.storeDir, backupName))).header.generation).toBe(1);
        // The machine is gone (1984): only the off-box store and the G' shares are left.
        const { stub: providers, clock } = a;
        await open.splice(open.indexOf(a), 1)[0].close();
        lap('1 gen-1 vault, copy, backup');

        // ─── 2. Release 1.1.0 continues the G' chain (previous = 1.0.1) with the servury host policy ─────
        // The published G' chain as on GitHub today: 1.0.0 and 1.0.1, both host policy none.
        const feedDir = path.join(dir, 'feed');
        publish(feedDir, a.release);
        const r101 = makeRelease({ version: '1.0.1', previous: a.release, custodianKeys: G, signers: [G[1], G[2]], image: randomImage() });
        publish(feedDir, r101);
        const feed = ['--feed-dir', feedDir];
        let r = await cli(['release', 'status', ...feed]);
        expect(r.stdout).toContain('newest: 1.0.1');

        // image.json and host-policy.json as build.sh --host servury writes them (image/image-settings.mjs).
        const image = randomImage();
        const imageHash = imageHashOf(image);
        const measurement = measurementOf(image.ukiSha256).toString('hex');
        const settingsTool = path.join(VAULT_ROOT, 'image', 'image-settings.mjs');
        const imageJson = await run([settingsTool, 'image-json', '1.1.0', image.ukiSha256, image.roothash, imageHash, 'static:192.0.2.10/24,192.0.2.1', 'ra', 'vault.example', 'servury', measurement, 'acpi']);
        expect(imageJson.code, imageJson.stderr).toBe(0);
        const hostPolicy = await run([settingsTool, 'host-policy', 'servury', measurement, image.ukiSha256]);
        expect(hostPolicy.code, hostPolicy.stderr).toBe(0);
        const build = path.join(dir, 'build-1.1.0');
        mkdirSync(build);
        writeFileSync(path.join(build, 'image.json'), imageJson.stdout);
        writeFileSync(path.join(build, 'host-policy.json'), hostPolicy.stdout);
        const policyFile = JSON.parse(hostPolicy.stdout) as HostPolicySevSnp;
        expect(policyFile.hosts[0]).toMatchObject({ profile: 'servury', product: 'Milan', minTcb: { snp: 29 }, chipIds: [] });

        const prop = path.join(dir, 'proposal');
        r = await cli(['release', 'propose', '--version', '1.1.0', '--image', path.join(build, 'image.json'), '--api-bundle', path.join(dir, 'bundles', 'vault-api.mjs'),
            '--same-custodians', '--host-policy', path.join(build, 'host-policy.json'), '--notes', 'host servury (rehearsal)', '--out', prop, ...feed]);
        expect(r.code, r.stdout + r.stderr).toBe(0);
        expect(r.stdout).toMatch(/previous\s+[0-9a-f]{64}\s+= 1\.0\.1/);
        for (const [i, n] of [[0, 1], [2, 2]] as const) {
            r = await cli(['release', 'sign', '--dir', prop, '--key', keyFiles[i], '--yes', ...feed], { pass: PASS[i] });
            expect(r.code, r.stdout + r.stderr).toBe(0);
            expect(r.stdout).toContain(`signed: ${n} of 2`);
        }
        r = await cli(['release', 'verify', '--dir', prop, ...feed]);
        expect(r.code, r.stdout + r.stderr).toBe(0);
        expect(r.stdout).toContain('Published as it is, the vault would take it.');
        const manifest = JSON.parse(readFileSync(path.join(prop, MANIFEST_ASSET), 'utf8')) as ReleaseManifest;
        expect(manifest).toMatchObject({ version: '1.1.0', previous: r101.hash, imageHash, custodianKeys: PUBS });
        expect(manifest.hostPolicy).toEqual(policyFile);
        // Published (here: into the directory feed); the tool now names 1.1.0 the release in force.
        const tagDir = path.join(feedDir, 'vault-v1.1.0');
        mkdirSync(tagDir);
        for (const f of [MANIFEST_ASSET, SIGNATURES_ASSET, API_BUNDLE_ASSET]) cpSync(path.join(prop, f), path.join(tagDir, f));
        r = await cli(['release', 'status', ...feed]);
        expect(r.code, r.stdout + r.stderr).toBe(0);
        expect(r.stdout).toContain('newest: 1.1.0');
        lap('2 release 1.1.0 propose, sign x2, verify, publish');

        // The new host: image 1.1.0 pinned to G', whose keyholder's hello carries the chip's report over its bind.
        let tamper: 'none' | 'signature' | 'measurement' = 'none';
        const attestor: Attestor = {
            platform: 'sev-snp',
            async evidence(bind) {
                const launched = tamper === 'measurement' ? measurementOf(randomImage().ukiSha256) : measurementOf(image.ukiSha256);
                const report = signReport(reportBytes({ reportData: Buffer.from(bind), measurement: launched, chipId: CHIP }));
                // One byte only the signature covers changed after the chip signed (not the measurement at 0x90, which is
                // refused first as 'measurement' and would never reach the signature check; review of #3394).
                if (tamper === 'signature') report[0x140] ^= 0xff;
                return evidenceOf(report);
            },
        };
        const b = await startVault({ stub: providers, clock, custodians: G, attestor, releaseHash: imageHash });
        open.push(b);
        const lines: string[] = [];
        const snpCall = (extra: Partial<ShareCall> = {}): ShareCall => ({
            now: b.clock.now,
            trust: { feed: new LocalDirectoryFeed(feedDir), rootKeys: PUBS },
            checkers: { 'sev-snp': snpChecker({ collateral: fixedCollateral({ vcek: amd.vcek(CHIP, PROBE_TCB), crl: amd.crl() }), now: () => NOW, roots: amd.roots }) },
            onHostCheck: l => lines.push(...l),
            acceptNewMachine: CHIP8,
            ...extra,
        });
        // Health says only open or locked (api/server.ts): a fresh vault reads "locked", with the release it booted.
        expect((await get(b, '/v1/health')).body).toMatchObject({ state: 'locked', release: imageHash });
        expect(b.keyholder().status().state).toBe('fresh');

        // First sight of this chip (runbook step 13): refused, nothing sent, naming its first 8 characters.
        const firstSight = snpCall({ acceptNewMachine: undefined, outbox: [] });
        await expect(sendSettings(b.baseUrl, G[0], settings, firstSight)).rejects.toThrow(`--accept-new-machine ${CHIP8}`);
        expect(firstSight.outbox).toEqual([]);
        // Tampered reports: refused, nothing sent, even with the chip accepted.
        for (const [kind, why] of [['signature', /signature does not verify/], ['measurement', /not one the release lists/]] as const) {
            tamper = kind;
            const o = snpCall({ outbox: [] });
            const sent = sendSettings(b.baseUrl, G[0], settings, o);
            await expect(sent).rejects.toMatchObject({ code: 'evidence_refused' });
            await expect(sent).rejects.toThrow(why);
            expect(o.outbox).toEqual([]);
        }
        tamper = 'none';
        lap('2 chip check: first sight, two tampered reports refused');

        // ─── 3. Settings with two G' keys, restore, unlock with two G' shares ─────────────────────
        const sent = [];
        for (const i of [0, 1]) sent.push((await sendSettings(b.baseUrl, G[i], settings, snpCall())).body.state);
        expect(sent).toEqual(['waiting', 'in_force']);
        expect(lines.join('\n')).toMatch(/chip check passed: AMD SEV-SNP, host servury/);
        expect(lines.join('\n')).toMatch(/NEW: accepted by you/);
        const listed = await listBackups(b.baseUrl, G[0], snpCall());
        expect(listed.body).toMatchObject({ local: [], offsite: [backupName] });
        expect((await restoreFromBackup(b.baseUrl, G[0], backupName, snpCall())).body).toMatchObject({ state: 'locked' });
        const named: (string | null)[] = [];
        const confirmRestore = async (rp: { backup: string | null }) => { named.push(rp.backup); return true; };
        expect((await presentShare(b.baseUrl, G[0], shareOf(g.shares, G[0]), snpCall({ confirmRestore }))).body).toMatchObject({ sharesPresent: 1 });
        expect((await presentShare(b.baseUrl, G[1], shareOf(g.shares, G[1]), snpCall({ confirmRestore }))).body).toMatchObject({ state: 'open' });
        expect(named).toEqual([backupName, backupName]);
        expect((await get(b, '/v1/health')).body.state).toBe('open');
        await expectCopy(b, 'google', SUB, member);
        // A restore keeps the keys: the ticket key is generation 1's.
        expect((await get(b, '/v1/report')).body.ticketKey).toBe(g.ticketKey);
        lap('3 settings x2, restore, unlock x2 (G\'), copy reads back');

        // ─── 4. Reshare with --new-custodians = the same three G' keys ────────────────────────────
        const reshare = { purpose: 'reshare' as const, newCustodians: PUBS };
        const first = await presentShare(b.baseUrl, G[0], shareOf(g.shares, G[0]), snpCall(reshare));
        expect(first.status, JSON.stringify(first.body)).toBe(200);
        expect(first.body).toMatchObject({ state: 'open', sharesPresent: 1 });
        const second = await presentShare(b.baseUrl, G[2], shareOf(g.shares, G[2]), snpCall(reshare));
        expect(second.status, JSON.stringify(second.body)).toBe(200);
        expect(second.body).toMatchObject({ state: 'open', generation: 2, pending: { purpose: 'reshare', generation: 2, custodians: PUBS, confirmed: [] } });
        const fresh = second.body.custodianShares as CustodianShare[];
        expect(fresh.map(s => s.custodian)).toEqual(PUBS);
        const waiting = (second.body.pending as { publicKeys: { ticket: string[]; deposit: { key: string }[] } }).publicKeys;
        const newTicket = waiting.ticket[0];
        const depositKeys = waiting.deposit.map(d => d.key);
        expect(waiting.ticket).toHaveLength(1);
        expect(newTicket).not.toBe(g.ticketKey);
        // The new deposit key first; the old one stays (accepted 26 Nov: it works until a later retire release).
        expect(depositKeys).toEqual([expect.any(String), g.depositKey]);
        expect(depositKeys[0]).not.toBe(g.depositKey);
        // Nothing switched yet: the old ticket key still signs.
        expect((await get(b, '/v1/report')).body.ticketKey).toBe(g.ticketKey);
        lap('4 reshare x2 to the same G\' keys');

        // ─── 5. Two G' confirm their new shares: the switch ────────────────────────────────────────
        const c1 = await confirmShare(b.baseUrl, G[0], shareOf(fresh, G[0]), snpCall());
        expect(c1.body).toMatchObject({ state: 'open', switched: false });
        const c2 = await confirmShare(b.baseUrl, G[1], shareOf(fresh, G[1]), snpCall());
        expect(c2.body).toMatchObject({ state: 'open', switched: true, generation: 2 });
        expect(b.keyholder().status()).toMatchObject({ generation: 2, pending: null });
        expect((await get(b, '/v1/report')).body.ticketKey).toBe(newTicket);
        // A copy sealed to the new deposit key goes in; one sealed to the old key still does (until the retire release).
        const second1 = newMember();
        expect((await deposit(b, { shares: [], ticketKey: newTicket, depositKey: depositKeys[0] }, second1, 'apple', 'same-keys-apple')).status).toBe(200);
        const oldBuild = newMember();
        expect((await deposit(b, { shares: [], ticketKey: newTicket, depositKey: g.depositKey }, oldBuild, 'facebook', '10150000000002727')).status).toBe(200);
        // The next backup is generation 2, in both stores.
        await b.api.idle();
        const after = await b.api.runBackup();
        expect(parseBackupFile(readFileSync(path.join(b.storeDir, after))).header.generation).toBe(2);
        expect((await listBackups(b.baseUrl, G[0], snpCall())).body.offsite).toEqual([backupName, after]);
        // A restart: the old shares (same keys, generation 1) open nothing; the new ones do, and every copy is there.
        await b.restartKeyholder();
        expect((await get(b, '/v1/health')).body.state).toBe('locked');
        await presentShare(b.baseUrl, G[0], shareOf(g.shares, G[0]), snpCall());
        const old = await presentShare(b.baseUrl, G[1], shareOf(g.shares, G[1]), snpCall());
        expect(old.body).toMatchObject({ state: 'locked', error: 'wrong_m' });
        await presentShare(b.baseUrl, G[0], shareOf(fresh, G[0]), snpCall());
        expect((await presentShare(b.baseUrl, G[2], shareOf(fresh, G[2]), snpCall())).body).toMatchObject({ state: 'open' });
        expect((await get(b, '/v1/report')).body.ticketKey).toBe(newTicket);
        await expectCopy(b, 'google', SUB, member);
        await expectCopy(b, 'apple', 'same-keys-apple', second1);
        lap('5 confirm x2, new keys, gen-2 backup, restart, old shares refused, new shares open');
        console.log(`same-keys rehearsal timings:\n  ${times.join('\n  ')}`);
    }, 240_000);

    it('the tool: with the same keys the second `reshare` already confirms that custodian\'s new share, so one `fetch-share` is the switch', async () => {
        // A vault on the harness's own G'-signed release (host policy none: the reshare's confirm logic is the same).
        const v = await startVault({ custodians: G, clock: realClock });
        open.push(v);
        const g = await doGenesis(v);
        const shareFiles = G.map((k, i) => {
            const f = path.join(dir, `old-share-${i + 1}.json`);
            writeFileSync(f, JSON.stringify(shareOf(g.shares, k)), { mode: 0o600 });
            return f;
        });
        const checks = ['--feed-dir', v.feedDir, '--no-hardware-proof'];
        const outs = [1, 2, 3].map(i => path.join(dir, `new-shares-${i}`));

        const a = await cli(['reshare', '--url', v.baseUrl, '--key', keyFiles[0], '--share', shareFiles[0], '--new-custodians', PUBS.join(','), '--out', outs[0], ...checks], { pass: PASS[0] });
        expect(a.code, a.stdout + a.stderr).toBe(0);
        expect(a.stdout).toContain('"sharesPresent":1');
        expect(readdirSync(outs[0])).toEqual([]);

        const b = await cli(['reshare', '--url', v.baseUrl, '--key', keyFiles[1], '--share', shareFiles[1], '--new-custodians', PUBS.join(','), '--out', outs[1], ...checks], { pass: PASS[1] });
        expect(b.code, b.stdout + b.stderr).toBe(0);
        // All three new shares saved, the pin lines printed (new ticket key first, the old one second) ...
        expect(readdirSync(outs[1])).toHaveLength(3);
        expect(b.stdout).toMatch(new RegExp(`BEANPOOL_VAULT_TICKET_KEYS=[0-9a-f]{64},${g.ticketKey}`));
        // ... and this custodian's own new share confirmed at once: one of the two the switch needs.
        expect(b.stdout).toContain('confirmed: ');
        expect(v.keyholder().status()).toMatchObject({ generation: 1, pending: { purpose: 'reshare', confirmed: [PUBS[1]] } });

        // The same custodian again changes nothing (a confirmation counts once) ...
        const again = await cli(['fetch-share', '--url', v.baseUrl, '--key', keyFiles[1], '--out', path.join(dir, 'again')], { pass: PASS[1] });
        expect(again.code, again.stdout + again.stderr).toBe(0);
        expect(v.keyholder().status()).toMatchObject({ generation: 1, pending: { confirmed: [PUBS[1]] } });
        // ... and ONE other custodian's fetch-share is the switch.
        const c = await cli(['fetch-share', '--url', v.baseUrl, '--key', keyFiles[2], '--out', outs[2]], { pass: PASS[2] });
        expect(c.code, c.stdout + c.stderr).toBe(0);
        expect(c.stdout).toContain('"switched":true');
        expect(v.keyholder().status()).toMatchObject({ generation: 2, pending: null });
        expect((await get(v, '/v1/report')).body.ticketKey).not.toBe(g.ticketKey);
    }, 120_000);
});
