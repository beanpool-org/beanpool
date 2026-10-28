/**
 * Where the full-screen "Update required" (components/ForceUpdateBlock.tsx) sends the member to get the new build: the
 * way this app came onto the phone.
 *
 * On Android the same app, signed by the same key, comes two ways: Google Play, and the direct download on
 * beanpool.org/android (front doors S5, DESIGN-entry-points-fable.md §4.4). An install from the download never updates
 * from Google Play, so its Update goes to that page; an install from Google Play goes to Google Play.
 *
 * Telling them apart needs the phone's installer of record (PackageManager.getInstallSourceInfo, or
 * getInstallerPackageName before Android 11). expo-application 55 does not expose it: its Android module has the app's
 * ids, versions, install times and Google Play's install referrer, nothing else. Until a native module reads it, the app
 * passes none, and Update opens Google Play as before; but a phone with no app that opens a Google Play link (no Google
 * Play: GrapheneOS without it, a phone with no Google account) now lands on beanpool.org/android, where it can get the
 * build, instead of Google Play's web page, where it cannot.
 */

/** beanpool.org/android: the direct download, in the visitor's language. */
export const ANDROID_DOWNLOAD_PAGE = 'https://beanpool.org/android';

/** The stores: the store's app first, then its web page. */
export const STORE_URLS = {
    ios: { app: 'itms-apps://itunes.apple.com/app/id6761870086', web: 'https://apps.apple.com/us/app/bean-pool/id6761870086' },
    android: { app: 'market://details?id=org.beanpool.pillar', web: 'https://play.google.com/store/apps/details?id=org.beanpool.pillar' },
} as const;

/** Installers of record that are Google Play. */
const GOOGLE_PLAY = new Set(['com.android.vending', 'com.google.android.feedback']);

export interface UpdateLinks {
    /** Opened first. */
    app: string;
    /** Opened when nothing on the phone opens `app`. */
    web: string;
}

/**
 * Where Update goes on `platform`. `installer` is the installer of record as Android names it: a package name, or null
 * for none (adb, some sideloads); omitted when the app cannot read it, as today (see above).
 */
export function updateLinks(platform: string, installer?: string | null): UpdateLinks {
    if (platform === 'ios') return STORE_URLS.ios;
    if (installer === undefined) return { app: STORE_URLS.android.app, web: ANDROID_DOWNLOAD_PAGE };
    if (installer !== null && GOOGLE_PLAY.has(installer)) return STORE_URLS.android;
    return { app: ANDROID_DOWNLOAD_PAGE, web: ANDROID_DOWNLOAD_PAGE };
}

/** Opens Update's destination with `open` (Linking.openURL): its first address, else its second; never throws. */
export async function openUpdate(platform: string, open: (url: string) => Promise<unknown>, installer?: string | null): Promise<void> {
    const links = updateLinks(platform, installer);
    try {
        await open(links.app);
    } catch {
        if (links.web === links.app) return;
        try { await open(links.web); } catch { /* nothing on the phone opens a web page either */ }
    }
}
