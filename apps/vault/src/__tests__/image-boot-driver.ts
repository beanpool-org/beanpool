#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { confirmShare, custodianKey, genesis, type CallOptions, type CustodianKey } from '../custodian/lib.js';
import type { CustodianShare } from '../shared/ceremony.js';
import { LocalDirectoryFeed, MANIFEST_ASSET, SIGNATURES_ASSET } from '../shared/release-feed.js';
import { addSignature, formatManifest, formatSignatures, imageHashOf, sha256Hex, signRelease, type ReleaseManifest, type ReleaseSignatures } from '../shared/release.js';
import { unixFetch } from './unix-fetch.js';

/**
 * The boot test's driver, inside a TEST build of the vault's image (image/test-image/make.mjs; never in a release
 * image), booted under QEMU by image/boot-test.sh. It runs as root once the vault is up, with the three throwaway
 * custodian keys the test image was built with (made at run time, their seeds in the test image alone), talks to the
 * API through its Unix socket as Caddy does, and prints each check on the serial port; the last line is
 * `vault-test: ALL PASS` or `vault-test: <n> FAILED`.
 *
 * What the programs' own tests can't see, because it is the image's units and files that decide it:
 *
 *   - a genesis, and the vault then opens: the data partition is mounted where the API sees it (#1314 BLOCKING 1).
 */

const SERIAL = '/dev/ttyS0';
const API_SOCKET = '/run/beanpool-vault/api/api.sock';
const IDENTITY_FILE = '/run/beanpool-vault-image.json';
const SEEDS_FILE = '/etc/beanpool-vault-test/custodians.json';
const API_BUNDLE = '/usr/lib/beanpool-vault/vault-api.mjs';
const DATA_MOUNT = '/var/lib/beanpool-vault/data';
const WORK = '/run/beanpool-vault-test';
const BASE = 'http://vault.beanpool.org';

let failed = 0;

function say(line: string): void {
    const text = `vault-test: ${line}`;
    console.log(text);
    try {
        appendFileSync(SERIAL, `${text}\n`);
    } catch {
        // No serial port: the journal has it.
    }
}

function check(what: string, ok: boolean, detail = ''): boolean {
    say(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`);
    if (!ok) failed++;
    return ok;
}

/** A command's status and output (stdout and stderr together). */
function sh(cmd: string, args: string[]): { status: number | null; out: string } {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

async function until<T>(fn: () => Promise<T | null | undefined | false>, seconds: number): Promise<{ value: T | null; after: number }> {
    const start = Date.now();
    for (;;) {
        const value = await fn().catch(() => null);
        if (value) return { value, after: Math.round((Date.now() - start) / 1000) };
        if (Date.now() - start > seconds * 1000) return { value: null, after: seconds };
        await new Promise(r => setTimeout(r, 2000));
    }
}

const fetchApi = unixFetch(API_SOCKET);

async function getJson(p: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetchApi(`${BASE}${p}`);
    return { status: res.status, body: await res.json() as Record<string, unknown> };
}

/** Release 0.0.1 naming the image that booted and its API bundle, signed by two of the test custodians. */
function publishRelease(feedDir: string, custodians: CustodianKey[], image: { ukiSha256: string; roothash: string }): ReleaseManifest {
    const manifest: ReleaseManifest = {
        v: 1, version: '0.0.1', previous: null, imageHash: imageHashOf(image), image,
        apiBundleHash: sha256Hex(readFileSync(API_BUNDLE)), custodianKeys: custodians.map(c => c.publicKey), hostPolicy: { platform: 'none' },
    };
    const text = formatManifest(manifest);
    let sigs: ReleaseSignatures | null = null;
    for (const c of custodians.slice(0, 2)) sigs = addSignature(text, sigs, signRelease(text, c.seed, c.publicKey));
    const dir = path.join(feedDir, 'vault-v0.0.1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, MANIFEST_ASSET), text);
    writeFileSync(path.join(dir, SIGNATURES_ASSET), formatSignatures(sigs as ReleaseSignatures));
    return manifest;
}

async function main(): Promise<void> {
    const seeds = (JSON.parse(readFileSync(SEEDS_FILE, 'utf8')) as { seeds: string[] }).seeds;
    const custodians = seeds.map(s => custodianKey(Buffer.from(s, 'hex')));
    const up = await until(async () => (await getJson('/v1/health')).body, 180);
    if (!check('the API answers /v1/health', !!up.value, `after ${up.after} s`)) return;
    const identity = JSON.parse(readFileSync(IDENTITY_FILE, 'utf8')) as { ok: boolean; image?: { ukiSha256: string; roothash: string; imageHash: string } };
    if (!check('root identified the booted image', identity.ok && !!identity.image, identity.image?.imageHash ?? JSON.stringify(identity))) return;
    const image = identity.image as { ukiSha256: string; roothash: string; imageHash: string };

    const feedDir = path.join(WORK, 'feed');
    publishRelease(feedDir, custodians, image);
    const opts: CallOptions = { fetch: fetchApi, acceptNoHardwareProof: true, trust: { feed: new LocalDirectoryFeed(feedDir), rootKeys: custodians.map(c => c.publicKey) } };

    // A genesis, and two custodians confirm their shares: the keyholder is open.
    const g = await genesis(BASE, custodians[0], opts);
    if (!check('genesis', g.status === 200, `${g.status}${g.status === 200 ? '' : ` ${JSON.stringify(g.body).slice(0, 200)}`}`)) return;
    const shares = g.body.custodianShares as CustodianShare[];
    const share = (c: CustodianKey) => shares.find(s => s.custodian === c.publicKey) as CustodianShare;
    await confirmShare(BASE, custodians[0], share(custodians[0]), opts);
    const confirmed = await confirmShare(BASE, custodians[1], share(custodians[1]), opts);
    if (!check('two custodians confirm: the keyholder is open', confirmed.body.state === 'open', JSON.stringify(confirmed.body).slice(0, 200))) return;

    // BLOCKING 1: the data partition is mounted where the API sees it, and the vault opens.
    const open = await until(async () => (await getJson('/v1/health')).body.state === 'open', 300);
    check('the vault opens: /v1/health says open', !!open.value, `after ${open.after} s`);
    const source = sh('findmnt', ['-n', '-o', 'SOURCE', DATA_MOUNT]).out;
    check('the data partition is mounted in the machine\'s namespace', source === '/dev/mapper/vault-data', source || 'not mounted');
    const report = await getJson('/v1/report');
    check('the database opens on it: /v1/report answers', report.status === 200, `${report.status}`);
}

main().catch(e => {
    check('the driver ran to the end', false, (e as Error).message);
}).finally(() => {
    say(failed ? `${failed} FAILED` : 'ALL PASS');
    process.exit(failed ? 1 : 0);
});
