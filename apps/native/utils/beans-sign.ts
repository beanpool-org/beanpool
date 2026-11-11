/**
 * The "Beans accepted here" sign on the phone (@beanpool/core beansSignHtml, the page the web app prints too): an A4 window sign or
 * an A6 stall card, made as a PDF on this phone and handed to the share sheet (Save to Files, AirDrop, a printer, a chat). The phone
 * holds no copy afterwards: the PDF is deleted whatever the share sheet did, and any a killed app left behind is swept first
 * (utils/recovery-kit.ts sweepPrintedPdfs). Nothing here is a hard gate or a success message of its own: the share sheet is the answer.
 *
 * The code opens the community's own page at the address this phone already uses for it (never beanpool.org). It is made on the
 * phone (core's qr-matrix, loaded when the button is pressed, so the app's start-up never loads it). The community's name is the one
 * the community publishes on its public card, else the phone's saved name for it, else its address. The mark is the logo the
 * community's own address serves at /logo.png, read once into the page; with no answer the page says "BeanPool" in words and is
 * still whole.
 */
import {
    BEANS_SIGN_SIZES, BEANS_SIGN_WORDS, beansSignAddress, beansSignHtml, beansSignUrl, currentWords, readCommunityCard,
    type BeansSignSize, type QrMatrix,
} from '@beanpool/core';
import { sweepPrintedPdfs, type KitFileSystem } from './recovery-kit';

export type SignResult = 'done' | 'failed';

/** The expo-file-system/legacy calls the sign adds to the kit's: fetch the mark and read it as base64. */
export interface SignFileSystem extends KitFileSystem {
    downloadAsync?(uri: string, fileUri: string): Promise<{ status: number; uri: string }>;
    readAsStringAsync?(uri: string, options: { encoding: 'base64' }): Promise<string>;
}

/** The phone modules the sign uses (expo-print, expo-sharing, expo-file-system/legacy, core's qr-matrix). */
export interface SignModules {
    Print: { printToFileAsync(options: { html: string; width: number; height: number }): Promise<{ uri: string }> };
    Sharing: { shareAsync(uri: string, options?: { mimeType?: string; UTI?: string; dialogTitle?: string }): Promise<unknown> };
    FileSystem: SignFileSystem;
    qrMatrix(text: string): QrMatrix;
}

type ModulesOrLoader = SignModules | (() => SignModules);

/** Required when pressed, not at the top: a phone built before expo-print fails the sign alone, and says so. */
function loadSignModules(): SignModules {
    return {
        Print: require('expo-print') as SignModules['Print'],
        Sharing: require('expo-sharing') as SignModules['Sharing'],
        FileSystem: require('expo-file-system/legacy') as SignModules['FileSystem'],
        qrMatrix: (require('@beanpool/core/qr-matrix') as { qrMatrix: SignModules['qrMatrix'] }).qrMatrix,
    };
}

function modulesFrom(source: ModulesOrLoader | undefined): SignModules {
    if (!source) return loadSignModules();
    return typeof source === 'function' ? source() : source;
}

/** How long the phone waits for the community's card and mark before it makes the sign without them. */
export const SIGN_READ_TIMEOUT_MS = 4000;

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/**
 * The name the community publishes about itself (GET /api/community/card, public), or null. Only a card that is about this very
 * address is believed: a card that claims another host says nothing here (as app/community-card.tsx reads it).
 */
export async function communityPublishedName(origin: string, fetchFn: FetchLike = fetch as unknown as FetchLike, timeoutMs = SIGN_READ_TIMEOUT_MS): Promise<string | null> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const res = await fetchFn(`${origin}/api/community/card`, { signal: ctl.signal, headers: { Accept: 'application/json' } });
        if (!res.ok) return null;
        const card = readCommunityCard(await res.json());
        if (!card?.name) return null;
        const host = new URL(origin).host;
        const claimed = card.host?.replace(/:443$/, '') ?? null;
        return claimed && claimed !== host ? null : card.name;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * BeanPool's mark as the community's own address serves it (/logo.png), as a PNG data URI, or undefined. Downloaded to the phone's
 * cache, read, and deleted at once. Never throws: no mark is a sign with the word.
 */
export async function communityLogoDataUri(origin: string, fileSystem: SignFileSystem): Promise<string | undefined> {
    const cache = fileSystem.cacheDirectory;
    if (!cache || !fileSystem.downloadAsync || !fileSystem.readAsStringAsync) return undefined;
    const target = `${cache.endsWith('/') ? cache : `${cache}/`}beans-sign-logo.png`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const got = await Promise.race([
            fileSystem.downloadAsync(`${origin}/logo.png`, target),
            new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), SIGN_READ_TIMEOUT_MS); }),
        ]);
        if (!got || got.status !== 200) return undefined;
        const base64 = await fileSystem.readAsStringAsync(got.uri, { encoding: 'base64' });
        return base64 ? `data:image/png;base64,${base64}` : undefined;
    } catch {
        return undefined;
    } finally {
        clearTimeout(timer);
        await fileSystem.deleteAsync(target, { idempotent: true }).catch(() => {});
    }
}

/**
 * Makes the sign as a PDF of its own paper (A4 or A6, portrait) and opens the share sheet on it; the phone's copy is deleted
 * whatever the share sheet did. `community` is what utils/recovery-kit.ts kitCommunityFrom gives: the name the phone holds for
 * the community and its address; null (no community on this phone) makes no sign.
 */
export async function shareBeansSign(
    size: BeansSignSize,
    community: { communityName: string; communityAddress: string } | null,
    modules?: ModulesOrLoader,
): Promise<SignResult> {
    if (!community) return 'failed';
    let uri: string | null = null;
    let fileSystem: SignFileSystem | null = null;
    try {
        const m = modulesFrom(modules);
        fileSystem = m.FileSystem;
        const url = beansSignUrl(community.communityAddress);
        const origin = url.replace(/\/$/, '');
        const [publishedName, logoDataUri] = await Promise.all([communityPublishedName(origin), communityLogoDataUri(origin, m.FileSystem)]);
        const words = currentWords();
        const html = beansSignHtml(words, {
            size,
            communityName: publishedName ?? community.communityName,
            address: beansSignAddress(community.communityAddress),
            qr: m.qrMatrix(url),
            logoDataUri,
        });
        await sweepPrintedPdfs(m.FileSystem);
        const paper = BEANS_SIGN_SIZES[size];
        ({ uri } = await m.Print.printToFileAsync({ html, width: paper.widthPt, height: paper.heightPt }));
        await m.Sharing.shareAsync(uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: words.t(BEANS_SIGN_WORDS.title) });
        return 'done';
    } catch {
        return 'failed';
    } finally {
        if (uri && fileSystem) await fileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    }
}
