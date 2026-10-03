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
 * Writes the page into a hidden frame, prints it, and removes the frame whatever print did, so no copy of the words is
 * left in the page. `print` is the browser's own unless a test hands in a stand-in.
 */
export async function printKitInFrame(html: string, print: (w: Window) => void = (w) => w.print()): Promise<'done' | 'failed'> {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    try {
        document.body.appendChild(frame);
        const w = frame.contentWindow;
        if (!w) return 'failed';
        w.document.open();
        w.document.write(html);
        w.document.close();
        print(w);
        return 'done';
    } catch {
        return 'failed';
    } finally {
        frame.remove();
    }
}

export async function printRecoveryKit(words: readonly string[], print?: (w: Window) => void): Promise<'done' | 'failed'> {
    let html: string;
    try {
        html = recoveryKitHtml(webKit(words));
    } catch {
        return 'failed';
    }
    return printKitInFrame(html, print);
}
