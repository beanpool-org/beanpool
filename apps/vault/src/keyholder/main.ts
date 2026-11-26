#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { identifyImage, imageFromIdentityFile } from '../shared/image-identity.js';
import type { Attestor } from './attestor.js';
import { checkMemoryHygiene, hygieneRefusal } from './hygiene.js';
import { Keyholder } from './keyholder.js';
import { listenDiskKey, listenKeyholder } from './server.js';
import { attestorFrom, describeSnpReport, listenAttest, readSnpReport, tsmReport } from './snp.js';

/**
 * `vault-keyholder --config <file>`. The config (on the image's read-only system partition, beside the pinned keys):
 *
 *   {"stateDir": "...", "socketPath": "...", "socketMode": 432, "diskKeySocket": "...",
 *    "genesisCustodians": ["<hex>", "<hex>", "<hex>"]}
 *
 * `socketMode` (0660 on the image) lets the API's user in through the keyholder's group; `diskKeySocket` serves the
 * data partition's key to root (server.ts listenDiskKey).
 * The hello's `releaseHash` is the image this machine booted (image-identity.ts: the UKI and its dm-verity root hash),
 * which the custodian's tool checks against the newest two-signed release. On the image, root works it out before the
 * keyholder starts (`vault-keyholder --identify <file>`, beanpool-vault-identity.service: the ESP is root's alone) and
 * the config names that file (`imageIdentityFile`). `releaseHash` in the config overrides it (tests and rehearsals,
 * which boot no image); without either the keyholder looks itself, and failing that it is `unreleased`.
 *
 * `attestor` names what proves this machine's code to a custodian (vault comeback design §2.2): absent or `none` (no
 * hardware proof, as on 1984), or `sev-snp` (an image built for an SEV-SNP host profile: build.sh --host), whose
 * reports come from root's helper on `attestSocket` (default /run/beanpool-vault/attest/attest.sock). Any other value
 * refuses to start: an SNP image never falls back to `none`.
 *
 * Root's two other modes on the image (the same bundle, as `--identify` is):
 *   `vault-keyholder --attest-socket <path>`   the SEV-SNP helper (beanpool-vault-attest.service, snp.ts)
 *   `vault-keyholder --snp-check`              one report at boot, its public values printed (check-hygiene)
 *
 * It starts locked (or fresh, before a genesis) and stays so until two custodians unlock it. On SIGTERM or SIGINT it
 * wipes what it holds and exits; an uncaught error does the same, with no core file (hygiene.ts).
 */

function argValue(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
}

/** The image this machine booted, or why not, from a file root wrote (`--identify`) or from the machine itself. */
function releaseFrom(config: { releaseHash?: string; imageIdentityFile?: string }): { hash?: string; why: string } {
    if (config.releaseHash) return { hash: config.releaseHash, why: 'from the config' };
    const r = config.imageIdentityFile ? imageFromIdentityFile(config.imageIdentityFile) : identifyImage();
    return r.ok ? { hash: r.image.imageHash, why: 'booted' } : { why: r.reason };
}

async function main(): Promise<void> {
    // Root: the SEV-SNP helper, serving reports to the keyholder (snp.ts).
    const attestSocket = argValue('--attest-socket');
    if (attestSocket) {
        const server = await listenAttest(attestSocket);
        process.on('SIGTERM', () => void server.close().finally(() => process.exit(0)));
        console.log(`vault-keyholder: SEV-SNP helper listening on ${attestSocket}`);
        return;
    }
    // Root, at boot (check-hygiene): one report over random data, its public values on the console.
    if (process.argv.includes('--snp-check')) {
        try {
            const { report } = tsmReport(crypto.randomBytes(64));
            for (const line of describeSnpReport(readSnpReport(report))) console.log(`snp: ${line}`);
        } catch (err) {
            console.log(`snp: no report: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }
        return;
    }
    // Root, before the keyholder starts: which image booted (reads the ESP, which only root may), into a file.
    const identifyTo = argValue('--identify');
    if (identifyTo) {
        const r = identifyImage();
        writeFileSync(identifyTo, `${JSON.stringify(r)}\n`, { mode: 0o644 });
        console.log(`vault-keyholder: image ${r.ok ? r.image.imageHash : `unknown (${r.reason})`}`);
        return;
    }
    const configPath = argValue('--config');
    if (!configPath) {
        console.error('usage: vault-keyholder --config <file>');
        process.exit(2);
    }
    const hygiene = checkMemoryHygiene();
    const refusal = hygieneRefusal(hygiene);
    if (refusal) {
        console.error(`vault-keyholder: not starting: ${refusal}`);
        process.exit(1);
    }
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
        stateDir: string; socketPath: string; genesisCustodians: string[]; releaseHash?: string; socketMode?: number; diskKeySocket?: string;
        imageIdentityFile?: string; attestor?: string; attestSocket?: string;
    };
    let attestor: Attestor;
    try {
        attestor = attestorFrom(config);
    } catch (err) {
        console.error(`vault-keyholder: not starting: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
    const release = releaseFrom(config);
    const releaseHash = release.hash;
    console.log(`vault-keyholder: release ${releaseHash ?? `unreleased (${release.why})`}`);
    const kh = new Keyholder({ stateDir: config.stateDir, genesisCustodians: config.genesisCustodians, releaseHash, hygiene, attestor });
    const server = await listenKeyholder(kh, config.socketPath, config.socketMode ?? 0o600);
    const disk = config.diskKeySocket ? await listenDiskKey(kh, config.diskKeySocket) : null;
    const stop = (code: number) => {
        kh.lock();
        void Promise.allSettled([server.close(), disk?.close()]).finally(() => process.exit(code));
    };
    process.on('SIGTERM', () => stop(0));
    process.on('SIGINT', () => stop(0));
    process.on('uncaughtException', () => {
        kh.lock();
        process.exit(1);
    });
    console.log(`vault-keyholder: ${kh.status().state}, listening on ${config.socketPath}; attestor ${attestor.platform}; memory: ${JSON.stringify(hygiene)}`);
}

void main();
