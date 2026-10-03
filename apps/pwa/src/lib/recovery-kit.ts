/**
 * The recovery kit on the web: the same page the phone prints (@beanpool/core's recoveryKitHtml), printed from a frame
 * that exists only while the browser's print runs. The browser's print dialog already offers "Save as PDF", so the web
 * has one action. Optional: nothing here gates joining.
 */
import { recoveryKitHtml, type RecoveryKit } from '@beanpool/core';
import { getNodeApiUrl } from './api';

export const KIT_WEB_LABEL = 'Print or save your recovery kit';
export const KIT_WEB_WARNING = 'Keep this page or file off cloud backups and chats. Anyone who has it can sign in as you.';
export const KIT_WEB_FAILED_LINE = 'The recovery kit couldn’t be made in this browser. Write the 12 words down instead.';

/**
 * The kit for the community this web app talks to: the detached `bp_node_url` when one is set (Settings → Sovereign
 * Node Connection), else the address the page was opened at, as lib/api.ts's nodeAddress and webAppHost do (review
 * 4170915988). Whatever domain or IP that is; the name is its host.
 */
export function webKit(
    words: readonly string[],
    loc: Pick<Location, 'origin' | 'host'> = window.location,
    nodeUrl: string = getNodeApiUrl(),
): RecoveryKit {
    if (!nodeUrl) return { words, communityName: loc.host, communityAddress: loc.origin, date: new Date() };
    let host: string;
    try {
        host = new URL(nodeUrl).host || nodeUrl;
    } catch {
        host = nodeUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '') || nodeUrl;
    }
    return { words, communityName: host, communityAddress: nodeUrl, date: new Date() };
}

/**
 * How long a kit's frame may stay when the browser never says its print is over ('afterprint'): long enough for a
 * print preview that renders after print() has returned (Chrome on Android, iOS Safari; review 4170916062).
 */
export const KIT_FRAME_FALLBACK_MS = 60_000;

/** The one kit frame in the page, if any, and how to remove it. */
let kitFrame: { remove: () => void } | null = null;

/** Removes the kit's frame now, if there is one. The next kit request does this first, so there is never a second. */
export function removeKitFrame(): void {
    kitFrame?.remove();
}

/**
 * Writes the page into a hidden frame and prints it. The frame stays while the browser's print may still read it, and
 * is removed on its first of: the frame's 'afterprint', {@link KIT_FRAME_FALLBACK_MS}, the next kit request, or print
 * throwing; so no copy of the words is left in the page for long. `print` is the browser's own unless a test hands in
 * a stand-in.
 */
export async function printKitInFrame(
    html: string,
    print: (w: Window) => void = (w) => w.print(),
    fallbackMs: number = KIT_FRAME_FALLBACK_MS,
): Promise<'done' | 'failed'> {
    removeKitFrame();
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const entry = {
        remove: () => {
            if (timer !== undefined) clearTimeout(timer);
            frame.remove();
            if (kitFrame === entry) kitFrame = null;
        },
    };
    kitFrame = entry;
    try {
        document.body.appendChild(frame);
        const w = frame.contentWindow;
        if (!w) {
            entry.remove();
            return 'failed';
        }
        w.document.open();
        w.document.write(html);
        w.document.close();
        // Set before print(): a browser whose print blocks may say 'afterprint' before print() returns.
        w.addEventListener('afterprint', entry.remove, { once: true });
        timer = setTimeout(entry.remove, fallbackMs);
        print(w);
        return 'done';
    } catch {
        entry.remove();
        return 'failed';
    }
}

export async function printRecoveryKit(words: readonly string[], print?: (w: Window) => void): Promise<'done' | 'failed'> {
    removeKitFrame();
    let html: string;
    try {
        html = recoveryKitHtml(webKit(words));
    } catch {
        return 'failed';
    }
    return printKitInFrame(html, print);
}
