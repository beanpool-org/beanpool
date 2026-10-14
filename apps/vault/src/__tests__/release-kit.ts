import crypto from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { custodianKey, type CustodianKey } from '../custodian/lib.js';
import { API_BUNDLE_ASSET, MANIFEST_ASSET, SIGNATURES_ASSET } from '../shared/release-feed.js';
import {
    addSignature,
    formatManifest,
    formatSignatures,
    imageHashOf,
    manifestHash,
    signRelease,
    type HostPolicy,
    type HostPolicyUnknown,
    type ReleaseFiles,
    type ReleaseImage,
    type ReleaseManifest,
    type ReleaseSignatures,
} from '../shared/release.js';

/** Releases for tests: made and signed here, with keys made here. */

export function keys3(): CustodianKey[] {
    return [0, 1, 2].map(() => custodianKey(crypto.randomBytes(32)));
}

export function randomImage(): ReleaseImage {
    return { ukiSha256: crypto.randomBytes(32).toString('hex'), roothash: crypto.randomBytes(32).toString('hex') };
}

export interface MadeRelease extends ReleaseFiles {
    manifest: ReleaseManifest;
    hash: string;
}

export function makeRelease(args: {
    version: string;
    previous: MadeRelease | null;
    custodianKeys: CustodianKey[];
    signers: CustodianKey[];
    image?: ReleaseImage;
    apiBundleHash?: string;
    hostPolicy?: HostPolicy | HostPolicyUnknown;
    label?: string;
    /** Changes the text after signing (the signatures then cover another manifest). */
    tamper?: (text: string) => string;
}): MadeRelease {
    const image = args.image ?? args.previous?.manifest.image ?? randomImage();
    const manifest: ReleaseManifest = {
        v: 1, version: args.version, previous: args.previous?.hash ?? null, imageHash: imageHashOf(image), image,
        apiBundleHash: args.apiBundleHash ?? crypto.randomBytes(32).toString('hex'),
        custodianKeys: args.custodianKeys.map(k => k.publicKey), hostPolicy: args.hostPolicy ?? { platform: 'none' },
    };
    const text = formatManifest(manifest);
    let sigs: ReleaseSignatures | null = null;
    for (const s of args.signers) sigs = addSignature(text, sigs, signRelease(text, s.seed, s.publicKey));
    const manifestText = args.tamper ? args.tamper(text) : text;
    return {
        manifest, manifestText, hash: manifestHash(manifestText), label: args.label ?? `vault-v${args.version}`,
        signaturesText: formatSignatures(sigs ?? { v: 1, manifest: manifestHash(text), signatures: [] }),
    };
}

/** Writes a release into a LocalDirectoryFeed directory, with its API bundle when given. */
export function publish(feedDir: string, r: MadeRelease, bundle?: Uint8Array): string {
    const d = path.join(feedDir, r.label as string);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, MANIFEST_ASSET), r.manifestText);
    writeFileSync(path.join(d, SIGNATURES_ASSET), r.signaturesText);
    if (bundle) writeFileSync(path.join(d, API_BUNDLE_ASSET), bundle);
    return d;
}
