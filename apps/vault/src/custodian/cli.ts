#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isVaultKeyHex } from '@beanpool/core';
import type { CustodianShare } from '../shared/ceremony.js';
import {
    cancelPending,
    confirmShare,
    custodianKey,
    fetchPendingShare,
    genesis,
    newCustodianKey,
    presentShare,
    restoreFromBackup,
    type CustodianCall,
    type CustodianKey,
} from './lib.js';

/**
 * `vault-custodian`: the stub custodian tool (V3 makes the real one). A key file is `{"seed": "<64 hex>"}` and is
 * NOT protected here; the real tool keeps it under a passphrase.
 *
 *   vault-custodian new-key     --out <keyfile>
 *   vault-custodian genesis     --url <vault> --key <keyfile> --out <dir> [--no-hardware-proof]
 *   vault-custodian unlock      --url <vault> --key <keyfile> --share <file> [--no-hardware-proof]
 *   vault-custodian reshare     --url <vault> --key <keyfile> --share <file> --new-custodians <a,b,c> --out <dir> [--no-hardware-proof]
 *   vault-custodian fetch-share --url <vault> --key <keyfile> --out <dir>
 *   vault-custodian confirm     --url <vault> --key <keyfile> --share <file>
 *   vault-custodian cancel      --url <vault> --key <keyfile> --pending <id>
 *   vault-custodian restore     --url <vault> --key <keyfile> --backup <name> [--no-hardware-proof]
 *
 * Every flag a command needs is checked, and every file it reads is read, before anything is sent. New shares (from
 * `genesis`, `reshare` or `fetch-share`) are written under --out first, and only then is this custodian's own share
 * confirmed: the vault switches to the new shares once two of their custodians have confirmed.
 */

const REQUIRED: Record<string, string[]> = {
    'new-key': ['--out'],
    genesis: ['--url', '--key', '--out'],
    unlock: ['--url', '--key', '--share'],
    reshare: ['--url', '--key', '--share', '--new-custodians', '--out'],
    'fetch-share': ['--url', '--key', '--out'],
    confirm: ['--url', '--key', '--share'],
    cancel: ['--url', '--key', '--pending'],
    restore: ['--url', '--key', '--backup'],
};

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    const v = i === -1 ? undefined : process.argv[i + 1];
    return v === undefined || v.startsWith('--') ? undefined : v;
}

function stop(message: string): never {
    console.error(message);
    process.exit(2);
}

function loadKey(file: string): CustodianKey {
    const seed = Buffer.from((JSON.parse(readFileSync(file, 'utf8')) as { seed: string }).seed, 'hex');
    if (seed.length !== 32) throw new Error(`${file} does not hold a 32-byte seed.`);
    return custodianKey(seed);
}

function loadShare(file: string): CustodianShare {
    const share = JSON.parse(readFileSync(file, 'utf8')) as CustodianShare;
    if (!share || share.v !== 1 || typeof share.custodian !== 'string' || !share.box) throw new Error(`${file} is not a custodian share.`);
    return share;
}

function writeShares(dir: string, shares: CustodianShare[]): void {
    for (const s of shares) {
        const file = path.join(dir, `share-${s.generation}-${s.index}-${s.custodian.slice(0, 8)}.json`);
        writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
        console.log(`share ${s.index} for ${s.custodian.slice(0, 8)}…: ${file}`);
    }
}

function print(result: CustodianCall): void {
    const rest: Record<string, unknown> = { ...result.body };
    delete rest.custodianShares;
    delete rest.share;
    console.log(result.status, JSON.stringify(rest));
}

async function main(): Promise<void> {
    const command = process.argv[2];
    const required = REQUIRED[command];
    if (!required) stop(`usage: vault-custodian ${Object.keys(REQUIRED).join('|')} ...`);
    const missing = required.filter(f => !arg(f));
    if (missing.length) stop(`missing ${missing.join(', ')}`);
    const accept = process.argv.includes('--no-hardware-proof');
    if (command === 'new-key') {
        const key = newCustodianKey();
        writeFileSync(arg('--out') as string, `${JSON.stringify({ seed: Buffer.from(key.seed).toString('hex') })}\n`, { mode: 0o600 });
        console.log(key.publicKey);
        return;
    }

    // Everything read and checked here, before the first request.
    const url = arg('--url') as string;
    const key = loadKey(arg('--key') as string);
    const share = required.includes('--share') ? loadShare(arg('--share') as string) : null;
    const newCustodians = required.includes('--new-custodians') ? (arg('--new-custodians') as string).split(',').map(s => s.trim()) : [];
    if (required.includes('--new-custodians') && (newCustodians.length !== 3 || !newCustodians.every(isVaultKeyHex))) {
        stop('--new-custodians is three custodian keys (64 hex characters each), comma-separated');
    }
    const out = required.includes('--out') ? arg('--out') as string : null;
    if (out) mkdirSync(out, { recursive: true, mode: 0o700 });

    /** Saves new shares, then confirms this custodian's own, if one is among them. */
    const keep = async (shares: CustodianShare[]): Promise<CustodianCall | null> => {
        writeShares(out as string, shares);
        const own = shares.find(s => s.custodian === key.publicKey);
        return own ? confirmShare(url, key, own) : null;
    };

    let result: CustodianCall;
    let confirmed: CustodianCall | null = null;
    if (command === 'genesis') {
        result = await genesis(url, key, { acceptNoHardwareProof: accept });
        if (result.status === 200) confirmed = await keep(result.body.custodianShares as CustodianShare[]);
    } else if (command === 'unlock') {
        result = await presentShare(url, key, share as CustodianShare, { acceptNoHardwareProof: accept });
    } else if (command === 'reshare') {
        result = await presentShare(url, key, share as CustodianShare, { purpose: 'reshare', newCustodians, acceptNoHardwareProof: accept });
        if (result.status === 200 && result.body.custodianShares) confirmed = await keep(result.body.custodianShares as CustodianShare[]);
    } else if (command === 'fetch-share') {
        const fetched = await fetchPendingShare(url, key);
        result = fetched.call;
        if (result.status === 200 && !fetched.share) {
            console.error('The vault no longer has the new shares (it restarted). Use the copy you saved, or two current custodians cancel and start again.');
            process.exit(1);
        }
        if (fetched.share) confirmed = await keep([fetched.share]);
    } else if (command === 'confirm') {
        result = await confirmShare(url, key, share as CustodianShare);
    } else if (command === 'cancel') {
        result = await cancelPending(url, key, arg('--pending') as string);
    } else {
        result = await restoreFromBackup(url, key, arg('--backup') as string, { acceptNoHardwareProof: accept });
    }
    print(result);
    if (confirmed) {
        process.stdout.write('confirmed: ');
        print(confirmed);
    }
    if (result.status !== 200 || (confirmed && confirmed.status !== 200)) process.exit(1);
}

main().catch(e => {
    console.error((e as Error).message);
    process.exit(1);
});
