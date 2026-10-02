/**
 * Tests only: what another tab of this web address does to the storage both tabs share when it signs out or clears
 * (lib/device-prefs.ts `clearAccountStorage`, lib/home-cache.ts `clearHomeCache`), as this tab meets it. jsdom sends no
 * `storage` event for a change made in the same window, so it is sent here, as a browser sends it to every other tab.
 * The epoch's value is lib/account-epoch.ts's: `<count>.<sign-out token>.<clear token>`.
 */
import { ACCOUNT_EPOCH_CHANNEL, ACCOUNT_EPOCH_KEY } from './account-epoch';

let seq = 0;

function nextEpoch(end: 'signed-out' | 'cleared'): string {
    const [n = '0', signOut = '0'] = (localStorage.getItem(ACCOUNT_EPOCH_KEY) ?? '').split('.');
    const fresh = `other-tab-${++seq}`;
    return `${Number(n) + 1}.${end === 'signed-out' ? fresh : signOut || '0'}.${fresh}`;
}

/** Home's store emptied by the other tab, through a connection of its own, as clearHomeCache does first. */
async function emptyHomeStore(): Promise<void> {
    await new Promise<void>((resolve) => {
        if (typeof indexedDB === 'undefined' || !indexedDB) return resolve();
        const req = indexedDB.open('beanpool-home', 1);
        req.onupgradeneeded = () => { try { req.result.createObjectStore('answers'); } catch { /* there */ } };
        req.onsuccess = () => {
            const tx = req.result.transaction('answers', 'readwrite');
            tx.objectStore('answers').clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
        };
        req.onerror = () => resolve();
    });
}

/**
 * Only the epoch's end, as this tab hears it: for a test that times it against something of this tab's own. A sign-out
 * there wipes localStorage too (the new epoch kept).
 */
export function epochEndsInAnotherTab(end: 'signed-out' | 'cleared'): void {
    const raw = nextEpoch(end);
    if (end === 'signed-out') localStorage.clear();
    localStorage.setItem(ACCOUNT_EPOCH_KEY, raw);
    window.dispatchEvent(new StorageEvent('storage', { key: ACCOUNT_EPOCH_KEY, newValue: raw }));
}

/** Sign Out (Device Only) in another tab: localStorage wiped (the new epoch kept), the event sent, Home's store emptied. */
export async function signOutInAnotherTab(): Promise<void> {
    epochEndsInAnotherTab('signed-out');
    await emptyHomeStore();
}

/** Force Clear & Re-Sync, or leaving a community, in another tab: the account stays, Home's kept copy goes. */
export async function clearInAnotherTab(): Promise<void> {
    epochEndsInAnotherTab('cleared');
    await emptyHomeStore();
}

/**
 * A sign-out in another tab heard on the channel alone (a browser whose storage this tab can't read), as a BroadcastChannel
 * of the other tab says it: sent at once, delivered a moment later.
 */
export function signOutOnChannelOnly(): void {
    const raw = nextEpoch('signed-out');
    const ch = new BroadcastChannel(ACCOUNT_EPOCH_CHANNEL);
    ch.postMessage(raw);
    ch.close();
}
