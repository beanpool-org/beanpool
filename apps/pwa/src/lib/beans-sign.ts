/**
 * The "Beans accepted here" sign on the web (@beanpool/core beansSignHtml, the page the phone makes a PDF of): an A4 window sign or an
 * A6 stall card, printed from the same hidden frame as the recovery kit (lib/recovery-kit.ts printKitInFrame). The browser's print
 * dialog already offers "Save as PDF", and the page sets its own paper, so it comes out A4 or A6 portrait; the web has one action,
 * no PDF library of its own. Optional: nothing here gates anything.
 *
 * The code opens the community's own page at the address this browser is already using for it (the detached `bp_node_url` when one is
 * set, else the page's own origin), whatever domain or IP that is: never beanpool.org. The code is made in the browser (core's
 * qr-matrix, loaded when the button is pressed, so the page's first load never carries it). The name is the one the community
 * publishes on its public card, else its address. The mark is this web app's own /logo.png, read into the page; with no answer the page
 * says "BeanPool" in words and is still whole.
 */
import { beansSignAddress, beansSignHtml, beansSignUrl, communityCardName, currentWords, t, type BeansSignSize, type QrMatrix } from '@beanpool/core';
import { getCommunityCard, getNodeApiUrl } from './api';
import { printKitInFrame } from './recovery-kit';

/** The community this browser talks to: the detached node's address when one is set, else the address the page was opened at. */
export function signCommunityAddress(loc: Pick<Location, 'origin'> = window.location, nodeUrl: string = getNodeApiUrl()): string {
    return nodeUrl || loc.origin;
}

/** How long the page waits for the community's card and the mark before it makes the sign without them. */
export const SIGN_READ_TIMEOUT_MS = 4000;

function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(undefined), ms);
        work.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(undefined); });
    });
}

/** This web app's own mark as a PNG data URI, or undefined (offline, not found, not a PNG). Never throws. */
export async function pageLogoDataUri(fetchFn: typeof fetch = fetch, url = '/logo.png'): Promise<string | undefined> {
    return within((async () => {
        const res = await fetchFn(url, { cache: 'force-cache' });
        if (!res.ok) return undefined;
        const blob = await res.blob();
        if (blob.type !== 'image/png') return undefined;
        return await new Promise<string | undefined>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined);
            reader.onerror = () => resolve(undefined);
            reader.readAsDataURL(blob);
        });
    })(), SIGN_READ_TIMEOUT_MS);
}

/** What a test can stand in for: the browser's print, the code, the card, the mark. */
export interface SignDeps {
    print?: (w: Window) => void;
    qrMatrix?: (text: string) => QrMatrix | Promise<QrMatrix>;
    communityName?: () => Promise<string | undefined>;
    logo?: () => Promise<string | undefined>;
    address?: string;
}

/** The community's own name from its public card (null from an old node), else undefined: the page then says the address. */
async function publishedName(): Promise<string | undefined> {
    const card = await within(getCommunityCard(), SIGN_READ_TIMEOUT_MS);
    return card?.name ? communityCardName(card, { t }) : undefined;
}

export async function printBeansSign(size: BeansSignSize, deps: SignDeps = {}): Promise<'done' | 'failed'> {
    try {
        const communityAddress = deps.address ?? signCommunityAddress();
        const url = beansSignUrl(communityAddress);
        const address = beansSignAddress(communityAddress);
        const [name, logoDataUri, qr] = await Promise.all([
            (deps.communityName ?? publishedName)(),
            (deps.logo ?? (() => pageLogoDataUri()))(),
            (deps.qrMatrix ?? (async (text: string) => (await import('@beanpool/core/qr-matrix')).qrMatrix(text)))(url),
        ]);
        const html = beansSignHtml(currentWords(), { size, communityName: name ?? address, address, qr, logoDataUri });
        return await printKitInFrame(html, deps.print);
    } catch {
        return 'failed';
    }
}
