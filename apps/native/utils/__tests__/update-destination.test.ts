/**
 * Where "Update required"'s Update goes (utils/update-destination.ts), by the way the app came onto the phone: Google
 * Play's installs to Google Play, the direct download's (beanpool.org/android, front doors S5) back to that page, and,
 * while the app cannot read its installer, Google Play first and the download page when the phone has no Google Play.
 *
 * Nothing here opens anything: `open` is the test's, and rejects as Linking.openURL does when nothing on the phone
 * takes the address.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ANDROID_DOWNLOAD_PAGE, STORE_URLS, openUpdate, updateLinks } from '../update-destination';

const PLAY_APP = 'market://details?id=org.beanpool.pillar';
const PLAY_WEB = 'https://play.google.com/store/apps/details?id=org.beanpool.pillar';
const APK_PAGE = 'https://beanpool.org/android';

/** A phone: the addresses something on it opens, and every address asked for, in order. */
function phone(opens: (url: string) => boolean) {
    const asked: string[] = [];
    const open = async (url: string) => {
        asked.push(url);
        if (!opens(url)) throw new Error(`No Activity found to handle Intent { ${url} }`);
    };
    return { asked, open };
}
const withPlay = () => phone(() => true);
const noPlay = () => phone((url) => !url.startsWith('market://'));

describe('updateLinks: the address by install source', () => {
    it('Google Play\'s installs go to Google Play: its app, then its web page', () => {
        for (const installer of ['com.android.vending', 'com.google.android.feedback']) {
            expect(updateLinks('android', installer)).toEqual({ app: PLAY_APP, web: PLAY_WEB });
        }
    });

    it('the direct download\'s installs, and any other installer, go to beanpool.org/android', () => {
        for (const installer of [
            'com.google.android.packageinstaller', // the file opened from Downloads or a browser's notification
            'com.android.packageinstaller', // the same on AOSP and GrapheneOS
            'com.android.chrome', // Android 11+ names the app that started the install
            'dev.imranr.obtainium', // following the GitHub releases
            null, // no installer of record: adb, some sideloads
        ]) {
            expect(updateLinks('android', installer)).toEqual({ app: APK_PAGE, web: APK_PAGE });
        }
    });

    it('when the app cannot read its installer (expo-application 55 has no such call): Google Play first, else the download page, never Google Play\'s web page', () => {
        expect(updateLinks('android')).toEqual({ app: PLAY_APP, web: APK_PAGE });
        expect(updateLinks('android', undefined)).toEqual({ app: PLAY_APP, web: APK_PAGE });
    });

    it('an iPhone goes to the App Store, whatever it is told', () => {
        expect(updateLinks('ios')).toEqual(STORE_URLS.ios);
        expect(updateLinks('ios', null)).toEqual(STORE_URLS.ios);
        expect(STORE_URLS.ios.app).toMatch(/^itms-apps:\/\/.*id6761870086$/);
    });

    it('the download page is ours, over https, and ships in this repository (apps/website/android.html)', () => {
        expect(ANDROID_DOWNLOAD_PAGE).toBe(APK_PAGE);
        expect(fs.existsSync(path.resolve(__dirname, '../../../website/android.html'))).toBe(true);
    });
});

describe('openUpdate: what the member lands on', () => {
    it('a phone with Google Play, installer unknown: Google Play\'s app, and nothing else', async () => {
        const p = withPlay();
        await openUpdate('android', p.open);
        expect(p.asked).toEqual([PLAY_APP]);
    });

    it('a phone with no Google Play (GrapheneOS without it), installer unknown: beanpool.org/android, where it can get the build', async () => {
        const p = noPlay();
        await openUpdate('android', p.open);
        expect(p.asked).toEqual([PLAY_APP, APK_PAGE]);
    });

    it('a direct-download install: the page at once, even on a phone that has Google Play', async () => {
        const p = withPlay();
        await openUpdate('android', p.open, 'com.google.android.packageinstaller');
        expect(p.asked).toEqual([APK_PAGE]);
    });

    it('a Google Play install on a phone whose store app will not open: Google Play\'s web page', async () => {
        const p = noPlay();
        await openUpdate('android', p.open, 'com.android.vending');
        expect(p.asked).toEqual([PLAY_APP, PLAY_WEB]);
    });

    it('nothing opens at all: it asks once more for a different address, never twice for the same, and never throws', async () => {
        const p = phone(() => false);
        await expect(openUpdate('android', p.open, null)).resolves.toBeUndefined();
        expect(p.asked).toEqual([APK_PAGE]);
        const q = phone(() => false);
        await expect(openUpdate('android', q.open)).resolves.toBeUndefined();
        expect(q.asked).toEqual([PLAY_APP, APK_PAGE]);
    });
});

describe('every Update button the app draws over its screens uses it', () => {
    // "Update required" (the community's floor), and a tool or a screen this version doesn't have. The header's banner
    // (components/GlobalHeader.tsx) is protected and keeps its own store addresses: see the PR.
    for (const file of ['components/ForceUpdateBlock.tsx', 'tools/frame.tsx']) {
        it(`${file}: Update opens openUpdate with the platform and Linking, and no store address of its own`, () => {
            const src = fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
            expect(src).toMatch(/import \{ openUpdate \} from '\.\.\/utils\/update-destination';/);
            expect(src).toMatch(/void openUpdate\(Platform\.OS, \(url\) => Linking\.openURL\(url\)\);/);
            expect(src).toMatch(/onPress=\{openStore\}/);
            expect(src).not.toMatch(/market:\/\/|play\.google\.com|STORE_URLS/);
        });
    }
});
