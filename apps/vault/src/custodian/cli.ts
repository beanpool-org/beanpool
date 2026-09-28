#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CustodianShare } from '../shared/ceremony.js';
import { custodianKey, genesis, newCustodianKey, presentShare, restoreFromBackup, type CustodianCall } from './lib.js';

/**
 * `vault-custodian`: the stub custodian tool (V3 makes the real one). A key file is `{"seed": "<64 hex>"}` and is
 * NOT protected here; the real tool keeps it under a passphrase.
 *
 *   vault-custodian new-key --out <keyfile>
 *   vault-custodian genesis --url <vault> --key <keyfile> --out <dir> [--no-hardware-proof]
 *   vault-custodian unlock  --url <vault> --key <keyfile> --share <file> [--no-hardware-proof]
 *   vault-custodian reshare --url <vault> --key <keyfile> --share <file> --new-custodians <a,b,c> --out <dir> [--no-hardware-proof]
 *   vault-custodian restore --url <vault> --key <keyfile> --backup <name> [--no-hardware-proof]
 */

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
}

function need(name: string): string {
    const v = arg(name);
    if (!v) {
        console.error(`missing ${name}`);
        process.exit(2);
    }
    return v;
}

function loadKey(file: string) {
    const seed = Buffer.from((JSON.parse(readFileSync(file, 'utf8')) as { seed: string }).seed, 'hex');
    if (seed.length !== 32) throw new Error(`${file} does not hold a 32-byte seed.`);
    return custodianKey(seed);
}

function writeShares(dir: string, result: CustodianCall): void {
    const shares = (result.body.custodianShares ?? []) as CustodianShare[];
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const s of shares) {
        const file = path.join(dir, `share-${s.generation}-${s.index}-${s.custodian.slice(0, 8)}.json`);
        writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
        console.log(`share ${s.index} for ${s.custodian.slice(0, 8)}…: ${file}`);
    }
}

async function main(): Promise<void> {
    const command = process.argv[2];
    const accept = process.argv.includes('--no-hardware-proof');
    if (command === 'new-key') {
        const key = newCustodianKey();
        writeFileSync(need('--out'), `${JSON.stringify({ seed: Buffer.from(key.seed).toString('hex') })}\n`, { mode: 0o600 });
        console.log(key.publicKey);
        return;
    }
    const url = need('--url');
    const key = loadKey(need('--key'));
    let result: CustodianCall;
    if (command === 'genesis') {
        result = await genesis(url, key, { acceptNoHardwareProof: accept });
        if (result.status === 200) writeShares(need('--out'), result);
    } else if (command === 'unlock') {
        const share = JSON.parse(readFileSync(need('--share'), 'utf8')) as CustodianShare;
        result = await presentShare(url, key, share, { acceptNoHardwareProof: accept });
    } else if (command === 'reshare') {
        const share = JSON.parse(readFileSync(need('--share'), 'utf8')) as CustodianShare;
        const newCustodians = need('--new-custodians').split(',').map(s => s.trim());
        result = await presentShare(url, key, share, { purpose: 'reshare', newCustodians, acceptNoHardwareProof: accept });
        if (result.status === 200 && result.body.custodianShares) writeShares(need('--out'), result);
    } else if (command === 'restore') {
        result = await restoreFromBackup(url, key, need('--backup'), { acceptNoHardwareProof: accept });
    } else {
        console.error('usage: vault-custodian new-key|genesis|unlock|reshare|restore ...');
        process.exit(2);
    }
    const { custodianShares: _shares, ...rest } = result.body;
    console.log(result.status, JSON.stringify(rest));
    if (result.status !== 200) process.exit(1);
}

main().catch(e => {
    console.error((e as Error).message);
    process.exit(1);
});
