import AsyncStorage from '@react-native-async-storage/async-storage';

export interface SavedNode {
    url: string;
    alias?: string;
    lastConnected?: string;
    currencyType?: 'text' | 'image';
    currencyValue?: string;
}

export async function getSavedNodes(): Promise<SavedNode[]> {
    try {
        const data = await AsyncStorage.getItem('beanpool_saved_nodes');
        const nodes: SavedNode[] = data ? JSON.parse(data) : [];
        
        // Auto-migrate standard legacy active node if it exists
        const currentActiveUrl = await AsyncStorage.getItem('beanpool_anchor_url');
        if (currentActiveUrl && !nodes.find(n => n.url === currentActiveUrl)) {
            nodes.push({ url: currentActiveUrl, lastConnected: new Date().toISOString() });
            await AsyncStorage.setItem('beanpool_saved_nodes', JSON.stringify(nodes));
        }
        return nodes;
    } catch (e) {
        console.error("Failed parsing saved nodes:", e);
        return [];
    }
}

export async function addSavedNode(url: string, alias?: string, currencyType?: 'text'|'image', currencyValue?: string) {
    const nodes = await getSavedNodes();
    const existing = nodes.find(n => n.url === url);
    if (!existing) {
        nodes.push({ url, alias, lastConnected: new Date().toISOString(), currencyType, currencyValue });
    } else {
        existing.lastConnected = new Date().toISOString();
        if (alias) existing.alias = alias;
        if (currencyType) existing.currencyType = currencyType;
        if (currencyValue) existing.currencyValue = currencyValue;
    }
    await AsyncStorage.setItem('beanpool_saved_nodes', JSON.stringify(nodes));
}

export async function removeSavedNode(url: string) {
    let nodes = await getSavedNodes();
    nodes = nodes.filter(n => n.url !== url);
    await AsyncStorage.setItem('beanpool_saved_nodes', JSON.stringify(nodes));
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
