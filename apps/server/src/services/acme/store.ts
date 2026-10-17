/**
 * One folder per identifier, /data/tls/acme/<identifier>/ (design scratch/global-node/DESIGN-https-anywhere-fable.md §6):
 * `key.pem` (0600), `cert.pem` (the chain the CA sent) and `state.json` (when it expires, when to try next, what went
 * wrong last, which ACME directory it came from). An IPv6 identifier's folder has `_` for each `:`, a character no certifiable name has.
 *
 * Nothing here travels: certificates and keys stay out of sealed backups and the take-over envelope (they are re-obtained
 * in minutes, and a leaked key is a real certificate for the community's address). The boot sweep makes every key.pem
 * here 0600 (boot-file-safety.ts).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomic } from '../../write-file-atomic.js';

export const ACME_DIR_NAME = path.join('tls', 'acme');

export interface AcmeState {
    /** The host as signatures carry it (an IPv6 one in brackets). */
    identifier: string;
    /** The served certificate's notAfter, ms; 0 for none. */
    validUntil: number;
    /** notAfter − notBefore of the served certificate, ms; 0 for none. */
    lifetimeMs: number;
    /** Not before this time, ms; 0 for the next tick. */
    nextAttemptAt: number;
    /** Attempts that failed in a row. */
    failures: number;
    /** What went wrong last, in words, or null. */
    lastError: string | null;
    lastAttemptAt: number;
    lastSuccessAt: number;
    /** The ACME directory the certificate on disk came from; null when not known (the fleet's adopted pair, a state
     *  written before this was recorded), which counts as the one configured now. */
    directoryUrl: string | null;
}

export interface CertPair {
    cert: string;
    key: string;
}

/** What a certificate on disk says about itself. */
export interface CertTimes {
    notBefore: number;
    notAfter: number;
}

export function acmeRoot(dataDir: string): string {
    return path.join(dataDir, ACME_DIR_NAME);
}

/** The folder name for a host: the host itself, an IPv6 one without brackets and with `_` for `:`. */
export function folderName(host: string): string {
    if (!/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)$/.test(host) || host.includes('..') || host.startsWith('.')) {
        throw new Error('ACME: not an identifier this server stores');
    }
    return host.startsWith('[') ? host.slice(1, -1).replace(/:/g, '_') : host;
}

/** The host a folder holds, or null for a name that is no folder of ours. */
export function hostOfFolder(name: string): string | null {
    if (/^[0-9a-f_.]+$/.test(name) && name.includes('_')) return `[${name.replace(/_/g, ':')}]`;
    return /^[a-z0-9][a-z0-9.-]*$/.test(name) && !name.includes('..') ? name : null;
}

function folder(dataDir: string, host: string): string {
    return path.join(acmeRoot(dataDir), folderName(host));
}

/** The hosts with a folder here. */
export function storedHosts(dataDir: string): string[] {
    let names: string[];
    try { names = fs.readdirSync(acmeRoot(dataDir)); } catch { return []; }
    return names.map(hostOfFolder).filter((h): h is string => !!h);
}

export function readPair(dataDir: string, host: string): CertPair | null {
    try {
        const dir = folder(dataDir, host);
        return { cert: fs.readFileSync(path.join(dir, 'cert.pem'), 'utf-8'), key: fs.readFileSync(path.join(dir, 'key.pem'), 'utf-8') };
    } catch {
        return null;
    }
}

/**
 * Put a new pair on disk: the key first, 0600, then the certificate, each written whole (writeFileAtomic). A stop between
 * the two leaves a key and certificate that do not match, which the next load refuses (tls.ts) and the next tick
 * replaces. The caller serves the pair only after this returns.
 */
export function writePair(dataDir: string, host: string, pair: CertPair): void {
    const dir = folder(dataDir, host);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(path.join(dir, 'key.pem'), pair.key, { mode: 0o600 });
    writeFileAtomic(path.join(dir, 'cert.pem'), pair.cert);
}

export function emptyState(host: string): AcmeState {
    return { identifier: host, validUntil: 0, lifetimeMs: 0, nextAttemptAt: 0, failures: 0, lastError: null, lastAttemptAt: 0, lastSuccessAt: 0, directoryUrl: null };
}

export function readState(dataDir: string, host: string): AcmeState {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(folder(dataDir, host), 'state.json'), 'utf-8'));
        const base = emptyState(host);
        for (const k of Object.keys(base) as (keyof AcmeState)[]) {
            if (k === 'identifier') continue;
            const v = raw?.[k];
            if (k === 'lastError') base.lastError = typeof v === 'string' ? v : null;
            else if (k === 'directoryUrl') base.directoryUrl = typeof v === 'string' && v ? v : null;
            else if (typeof v === 'number' && Number.isFinite(v)) (base as any)[k] = v;
        }
        return base;
    } catch {
        return emptyState(host);
    }
}

export function writeState(dataDir: string, state: AcmeState): void {
    const dir = folder(dataDir, state.identifier);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(path.join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
}

/** The leaf's validity, or null when the PEM does not parse. */
export function certTimes(certPem: string): CertTimes | null {
    try {
        const leaf = new crypto.X509Certificate(certPem);
        return { notBefore: Date.parse(leaf.validFrom), notAfter: Date.parse(leaf.validTo) };
    } catch {
        return null;
    }
}

/** Whether the leaf certifies `host` (a name by its DNS SAN, an IP literal by its IP SAN). */
export function certCovers(certPem: string, host: string): boolean {
    try {
        const leaf = new crypto.X509Certificate(certPem);
        if (host.startsWith('[')) return leaf.checkIP(host.slice(1, -1)) !== undefined;
        if (/^[\d.]+$/.test(host)) return leaf.checkIP(host) !== undefined;
        return leaf.checkHost(host, { wildcards: false }) !== undefined;
    } catch {
        return false;
    }
}
