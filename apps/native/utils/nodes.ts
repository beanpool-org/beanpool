import AsyncStorage from '@react-native-async-storage/async-storage';
import { audienceOf } from '@beanpool/core';
import { SAVED_NODES_STORE_KEY } from './storage-keys';
import { assertPlainNodeAddress, isPlainNodeAddress } from './node-url';
import {
    hydrateRequestSigning, knownRequestSigning, rememberRequestSigning, requestSigningOf,
} from './request-signing-version';

export interface SavedNode {
    url: string;
    alias?: string;
    lastConnected?: string;
    currencyType?: 'text' | 'image';
    currencyValue?: string;
    /**
     * What the node's /api/community/info said about request signing (request-signing-version.ts): 2 or more for
     * a server that reads format 2, 1 when it answered without saying. Absent: not asked yet (format 2 is used).
     */
    requestSigning?: number;
}

export async function getSavedNodes(): Promise<SavedNode[]> {
    try {
        const data = await AsyncStorage.getItem(SAVED_NODES_STORE_KEY);
        const nodes: SavedNode[] = data ? JSON.parse(data) : [];
        
        // Auto-migrate standard legacy active node if it exists. Never an address that isn't plain (node-url.ts):
        // nothing is saved from one.
        const currentActiveUrl = await AsyncStorage.getItem('beanpool_anchor_url');
        if (currentActiveUrl && isPlainNodeAddress(currentActiveUrl) && !nodes.find(n => n.url === currentActiveUrl)) {
            nodes.push({ url: currentActiveUrl, lastConnected: new Date().toISOString() });
            await AsyncStorage.setItem(SAVED_NODES_STORE_KEY, JSON.stringify(nodes));
        }
        return nodes;
    } catch (e) {
        console.error("Failed parsing saved nodes:", e);
        return [];
    }
}

/**
 * Save `url` to the phone's list of communities, or refresh its entry. Throws, saving nothing, for an address whose
 * authority isn't exactly `host[:port]` (node-url.ts `assertPlainNodeAddress`).
 */
export async function addSavedNode(url: string, alias?: string, currencyType?: 'text'|'image', currencyValue?: string) {
    assertPlainNodeAddress(url);
    const nodes = await getSavedNodes();
    const existing = nodes.find(n => n.url === url);
    if (!existing) {
        const requestSigning = knownRequestSigning(url);
        nodes.push({
            url, alias, lastConnected: new Date().toISOString(), currencyType, currencyValue,
            ...(requestSigning !== undefined ? { requestSigning } : {}),
        });
    } else {
        existing.lastConnected = new Date().toISOString();
        if (alias) existing.alias = alias;
        if (currencyType) existing.currencyType = currencyType;
        if (currencyValue) existing.currencyValue = currencyValue;
    }
    await AsyncStorage.setItem(SAVED_NODES_STORE_KEY, JSON.stringify(nodes));
}

/**
 * Record what `url`'s `GET /api/community/info` answered about request signing: for this run at once, and on every
 * saved node with the same host for the next. `infoBody` is the parsed answer; anything that isn't an info answer
 * records nothing. Never throws.
 */
export async function recordRequestSigning(url: string, infoBody: unknown): Promise<void> {
    const version = requestSigningOf(infoBody);
    if (version === null) return;
    const host = rememberRequestSigning(url, version);
    if (!host) return;
    try {
        const nodes = await getSavedNodes();
        let changed = false;
        for (const n of nodes) {
            if (isPlainNodeAddress(n.url) && audienceOf(n.url) === host && n.requestSigning !== version) {
                n.requestSigning = version;
                changed = true;
            }
        }
        if (changed) await AsyncStorage.setItem(SAVED_NODES_STORE_KEY, JSON.stringify(nodes));
    } catch {
        // Kept in memory for this run; asked again on the next.
    }
}

/** Load each saved node's recorded request-signing answer into memory (app start, utils/node-request-signing.ts). */
export function loadSavedRequestSigning(): Promise<void> {
    return hydrateRequestSigning(getSavedNodes);
}

export async function removeSavedNode(url: string) {
    let nodes = await getSavedNodes();
    nodes = nodes.filter(n => n.url !== url);
    await AsyncStorage.setItem(SAVED_NODES_STORE_KEY, JSON.stringify(nodes));
}

/**
 * Returns a sanitized alphanumeric string to safely use as a SQLite filename.
 * e.g., "http://192.168.1.100:3000" -> "beanpool_http_192_168_1_100_3000.db"
 */
export function getDatabaseFilenameForNode(url: string | null): string {
    if (!url) return 'beanpool.db'; // Fallback
    if (url === 'https://review.beanpool.org:8443' || url === 'https://beanpool.org:8443') {
        return 'beanpool.db';
    }
    const sanitized = url.replace(/[^a-zA-Z0-9]/g, '_');
    return `beanpool_${sanitized}.db`;
}

// ── Deliberate guest visits ───────────────────────────────────────────────────
//
// Browsing a community you are not a member of is a legitimate state (read-only
// guest), but it is indistinguishable from the error the root layout watches for —
// "this node doesn't recognise you", i.e. a mistyped address. Without a record of
// intent the watcher ejects deliberate guests to /node-mismatch, which is how a
// member gets thrown out of the very Register screen that would fix it (2026-09-02).
//
// So intent is recorded explicitly: only set when the member is told they are not a
// member and chooses to continue anyway. Cleared the moment they register, so a real
// member is never treated as a guest.
const GUEST_KEY = 'beanpool_guest_nodes';

async function readGuestNodes(): Promise<string[]> {
    try {
        const raw = await AsyncStorage.getItem(GUEST_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : [];
    } catch {
        return [];
    }
}

export async function markGuestNode(url: string): Promise<void> {
    if (!url) return;
    try {
        const urls = await readGuestNodes();
        if (!urls.includes(url)) {
            urls.push(url);
            await AsyncStorage.setItem(GUEST_KEY, JSON.stringify(urls));
        }
    } catch {
        // Non-fatal: worst case the watcher diverts to node-mismatch, which is now
        // escapable via the saved-node picker rather than being a dead end.
    }
}

export async function clearGuestNode(url: string): Promise<void> {
    if (!url) return;
    try {
        const urls = await readGuestNodes();
        const next = urls.filter((u) => u !== url);
        if (next.length !== urls.length) {
            await AsyncStorage.setItem(GUEST_KEY, JSON.stringify(next));
        }
    } catch {}
}

export async function isGuestNode(url: string): Promise<boolean> {
    if (!url) return false;
    return (await readGuestNodes()).includes(url);
}
