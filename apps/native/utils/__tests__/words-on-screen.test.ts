/**
 * No screenshots or screen recordings while an account's 12 words are on screen (utils/words-on-screen.ts,
 * components/WordsOnScreen.tsx), one plain line on a phone with no screen lock, and no screen that tells a member to
 * keep the words in a screenshot or a photo.
 *
 * - The block is asked for when the first screen holds it and let go when the last one does, always under one tag: the
 *   library's iPhone code can't take a second block without a release in between.
 * - A hold says when the library has answered, and the words wait for that answer (words-on-screen-render.test.ts
 *   renders the wrapper that does the waiting).
 * - A build without the native module, or the web, shows the words as before: nothing throws.
 * - Every screen that draws the words, or the boxes they are typed into, draws them inside the block (the sweep below).
 *
 * The screens cannot be rendered here (see vitest.config.ts): their wiring is read from their source.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() } }));
vi.mock('expo-local-authentication', () => ({
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    getEnrolledLevelAsync: vi.fn(),
}));
const capture = vi.hoisted(() => ({
    api: {
        preventScreenCaptureAsync: vi.fn(async (_key?: string) => {}),
        allowScreenCaptureAsync: vi.fn(async (_key?: string) => {}),
    } as { preventScreenCaptureAsync: (key?: string) => Promise<void>; allowScreenCaptureAsync: (key?: string) => Promise<void> } | null,
}));
vi.mock('../screen-capture-module', () => ({ loadScreenCapture: () => capture.api }));

import * as LocalAuthentication from 'expo-local-authentication';

const fakes = {
    prevent: vi.fn(async (_key?: string) => {}),
    allow: vi.fn(async (_key?: string) => {}),
};

/** Imported at the test, not the top: on a tree without it, only the tests that use it fail. */
const onScreen = async () => import('../words-on-screen');

beforeEach(() => {
    fakes.prevent.mockReset().mockResolvedValue(undefined);
    fakes.allow.mockReset().mockResolvedValue(undefined);
    capture.api = { preventScreenCaptureAsync: fakes.prevent, allowScreenCaptureAsync: fakes.allow };
});

describe('holding the block', () => {
    it('blocks when the words come and lets go when they go, under one tag', async () => {
        const { holdNoScreenCapture } = await onScreen();
        const { release } = holdNoScreenCapture();
        expect(fakes.prevent).toHaveBeenCalledTimes(1);
        expect(fakes.prevent).toHaveBeenCalledWith('beanpool-12-words');
        expect(fakes.allow).not.toHaveBeenCalled();

        release();
        expect(fakes.allow).toHaveBeenCalledTimes(1);
        expect(fakes.allow).toHaveBeenCalledWith('beanpool-12-words');
    });

    it('two screens at once: asked once, let go only when both have gone', async () => {
        const { holdNoScreenCapture } = await onScreen();
        const first = holdNoScreenCapture().release;
        const second = holdNoScreenCapture().release;
        expect(fakes.prevent).toHaveBeenCalledTimes(1);

        first();
        expect(fakes.allow).not.toHaveBeenCalled();
        second();
        expect(fakes.allow).toHaveBeenCalledTimes(1);
    });

    it('a release made twice lets go once, and a later screen blocks again', async () => {
        const { holdNoScreenCapture } = await onScreen();
        const { release } = holdNoScreenCapture();
        release();
        release();
        expect(fakes.allow).toHaveBeenCalledTimes(1);

        const again = holdNoScreenCapture().release;
        expect(fakes.prevent).toHaveBeenCalledTimes(2);
        again();
        expect(fakes.allow).toHaveBeenCalledTimes(2);
    });

    it('a build without the module, or a library that refuses, shows the words as before: nothing throws', async () => {
        const { holdNoScreenCapture } = await onScreen();
        capture.api = null;
        expect(() => holdNoScreenCapture().release()).not.toThrow();

        capture.api = { preventScreenCaptureAsync: fakes.prevent, allowScreenCaptureAsync: fakes.allow };
        fakes.prevent.mockRejectedValueOnce(new Error('UnavailabilityError'));
        fakes.allow.mockImplementationOnce(() => { throw new Error('no activity'); });
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        try {
            const { release } = holdNoScreenCapture();
            expect(() => release()).not.toThrow();
            await new Promise((r) => setTimeout(r, 0));
            expect(unhandled).not.toHaveBeenCalled();
        } finally {
            process.off('unhandledRejection', unhandled);
        }
    });
});

describe('the answer the words wait for (PR #1284 review 4124177329)', () => {
    const settled = async (p: Promise<void>) => {
        let done = false;
        void p.then(() => { done = true; });
        await new Promise((r) => setTimeout(r, 0));
        return done;
    };

    it('settles only once the library has answered the block', async () => {
        const { holdNoScreenCapture } = await onScreen();
        let answer: () => void = () => {};
        fakes.prevent.mockImplementationOnce(() => new Promise<void>((r) => { answer = r; }));
        const hold = holdNoScreenCapture();
        expect(fakes.prevent).toHaveBeenCalledTimes(1);
        expect(await settled(hold.answered)).toBe(false);
        answer();
        expect(await settled(hold.answered)).toBe(true);
        hold.release();
    });

    it('a second screen while the block is held waits on the same answer, and asks nothing more', async () => {
        const { holdNoScreenCapture } = await onScreen();
        let answer: () => void = () => {};
        fakes.prevent.mockImplementationOnce(() => new Promise<void>((r) => { answer = r; }));
        const first = holdNoScreenCapture();
        const second = holdNoScreenCapture();
        expect(await settled(second.answered)).toBe(false);
        answer();
        expect(await settled(second.answered)).toBe(true);
        expect(fakes.prevent).toHaveBeenCalledTimes(1);
        first.release();
        second.release();
    });

    it('a refusal, a throw, or no module is an answer too: it settles and never rejects', async () => {
        const { holdNoScreenCapture } = await onScreen();
        fakes.prevent.mockRejectedValueOnce(new Error('UnavailabilityError'));
        let hold = holdNoScreenCapture();
        expect(await settled(hold.answered)).toBe(true);
        hold.release();

        fakes.prevent.mockImplementationOnce(() => { throw new Error('no activity'); });
        hold = holdNoScreenCapture();
        expect(await settled(hold.answered)).toBe(true);
        hold.release();

        capture.api = null;
        hold = holdNoScreenCapture();
        expect(await settled(hold.answered)).toBe(true);
        hold.release();
    });

    it('a library that never answers: it settles after the wait, so the words still show', async () => {
        vi.useFakeTimers();
        try {
            const { holdNoScreenCapture, ANSWER_WAIT_MS } = await onScreen();
            fakes.prevent.mockImplementationOnce(() => new Promise<void>(() => {}));
            const hold = holdNoScreenCapture();
            let done = false;
            void hold.answered.then(() => { done = true; });
            await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS - 1);
            expect(done).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            expect(done).toBe(true);
            hold.release();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('a phone with no screen lock', () => {
    it('is told only when the phone says it has no lock of any kind; a phone that can\'t say is not', async () => {
        const { phoneHasNoScreenLock } = await import('../LocalAuth');
        vi.mocked(LocalAuthentication.getEnrolledLevelAsync).mockResolvedValueOnce(0);
        expect(await phoneHasNoScreenLock()).toBe(true);
        vi.mocked(LocalAuthentication.getEnrolledLevelAsync).mockResolvedValueOnce(1);
        expect(await phoneHasNoScreenLock()).toBe(false);
        vi.mocked(LocalAuthentication.getEnrolledLevelAsync).mockResolvedValueOnce(3);
        expect(await phoneHasNoScreenLock()).toBe(false);
        vi.mocked(LocalAuthentication.getEnrolledLevelAsync).mockRejectedValueOnce(new Error('no module'));
        expect(await phoneHasNoScreenLock()).toBe(false);
    });

    it('one plain line, and no gate: the words screens only add the line', async () => {
        const { NO_SCREEN_LOCK_LINE } = await onScreen();
        expect(NO_SCREEN_LOCK_LINE).toBe("This phone has no screen lock, so anyone holding it can open these words. You can set one in the phone's settings.");
        const lock = fs.readFileSync(path.join(NATIVE, 'utils', 'words-behind-lock.ts'), 'utf8');
        expect(lock).not.toContain('phoneHasNoScreenLock');
    });
});

const NATIVE = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(NATIVE, rel), 'utf8');

/**
 * Whether `anchor` (where the words are drawn) sits inside a `<NoScreenCapture>` … `</NoScreenCapture>`: the words wait
 * for the block. A `<NoScreenCapture />` drawn beside them (as on bdfe9440) doesn't count: the words were drawn in the
 * same frame as it, before the block.
 */
function drawnInsideBlock(src: string, anchor: string): boolean {
    const at = src.indexOf(anchor);
    if (at < 0) throw new Error(`anchor not found: ${anchor}`);
    const before = src.slice(0, at);
    const open = Math.max(before.lastIndexOf('<NoScreenCapture>'), before.lastIndexOf('<NoScreenCapture fallback='));
    if (open < 0) return false;
    if (before.lastIndexOf('</NoScreenCapture>') > open) return false;
    const close = src.indexOf('</NoScreenCapture>', at);
    const nextOpen = src.indexOf('<NoScreenCapture', at);
    return close > at && (nextOpen < 0 || close < nextOpen);
}

describe('every screen that draws the words blocks capture with them', () => {
    const screens: [string, string, string][] = [
        ['Safety Backup', 'app/welcome.tsx', 'pendingWords ? pendingWords.map('],
        ["Replace this phone's account?", 'app/welcome.tsx', 'outgoingWords?.map('],
        ['Recover with 12 Words (typed)', 'app/welcome.tsx', 'recoveryWords.map((word, i) => ('],
        ['Account Protection', 'app/(tabs)/settings.tsx', "mnemonicWords?.split(' ').map("],
        ['View Recovery Phrase', 'app/(tabs)/settings.tsx', 'seedWords?.map('],
        ["node-mismatch's delete", 'app/node-mismatch.tsx', 'words.map((w, i) => ('],
        ['Add your 12 words (typed)', 'components/AddWordsForm.tsx', 'boxes.map('],
        ['Check your 12 words (typed)', 'app/owner-words-check.tsx', '<TextInput'],
    ];
    it.each(screens)('%s: drawn inside the block', (_name, file, anchor) => {
        expect(drawnInsideBlock(read(file), anchor)).toBe(true);
    });

    it('no screen draws the block beside the words instead of around them', () => {
        for (const file of [...new Set(screens.map(([, f]) => f))]) {
            expect(read(file)).not.toMatch(/<NoScreenCapture\s*\/>/);
        }
    });

    it('holds the block only while its screen is in front (words-on-screen-render.test.ts renders it)', () => {
        const src = read('components/WordsOnScreen.tsx');
        expect(src).toContain('useIsFocused()');
        expect(src).toContain('focused && inForce ? children : fallback');
    });

    it('no screen reads the words for display without blocking capture: each file that shows them holds it', () => {
        for (const file of ['app/welcome.tsx', 'app/(tabs)/settings.tsx', 'app/node-mismatch.tsx']) {
            const src = read(file);
            expect(src.includes('readWordsBehindLock(')).toBe(true);
            expect(src).toContain('<NoScreenCapture>');
        }
    });

    it('the screen that sends the words to a computer draws none (pair-device), so it has nothing to block', () => {
        const src = read('app/pair-device.tsx');
        expect(src).not.toMatch(/mnemonic\.map|words\.map/);
    });
});

describe('Android: no screenshot detection anywhere in the app (PR #1284 review 4124181957)', () => {
    const REPO = path.resolve(NATIVE, '..', '..');
    const LIB = path.dirname(require.resolve('expo-screen-capture/package.json', { paths: [NATIVE] }));
    const json = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
    const PATCHED = '55.0.18';

    it('the library is patched at the version installed, and the build compiles the patched source', () => {
        expect(json(path.join(LIB, 'package.json')).version).toBe(PATCHED);
        const patch = json(path.join(REPO, 'package.json')).pnpm.patchedDependencies[`expo-screen-capture@${PATCHED}`];
        expect(patch).toBe(`patches/expo-screen-capture@${PATCHED}.patch`);
        expect(fs.existsSync(path.join(REPO, patch))).toBe(true);
        // Without this, Gradle links the library's prebuilt AAR (its local-maven-repo) and the patch never reaches a phone.
        expect(json(path.join(NATIVE, 'package.json')).expo.autolinking.android.buildFromSource).toContain('expo-screen-capture');
    });

    it('the installed module registers no screenshot callback or watcher, and still sets FLAG_SECURE', () => {
        const kt = fs.readFileSync(path.join(LIB, 'android/src/main/java/expo/modules/screencapture/ScreenCaptureModule.kt'), 'utf8');
        const block = (name: string) => {
            const at = kt.indexOf(`${name} {`);
            expect(at).toBeGreaterThan(-1);
            return kt.slice(at, kt.indexOf('\n    }', at));
        };
        expect(block('OnCreate')).not.toMatch(/registerCallback\(|ScreenCaptureCallback|ScreenshotEventEmitter\(/);
        expect(block('OnActivityEntersForeground')).not.toMatch(/registerCallback\(/);
        expect(kt).toContain('currentActivity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)');
        expect(kt).toContain('currentActivity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)');
    });

    it('asks for no screenshot permission: not in the library, and blocked in the app', () => {
        const manifest = fs.readFileSync(path.join(LIB, 'android/src/main/AndroidManifest.xml'), 'utf8');
        expect(manifest).not.toMatch(/uses-permission/);
        const blocked: string[] = json(path.join(NATIVE, 'app.json')).expo.android.blockedPermissions;
        expect(blocked).toContain('android.permission.DETECT_SCREEN_CAPTURE');
    });
});

describe('nothing tells a member to keep the words in a screenshot or a photo', () => {
    const REPO = path.resolve(NATIVE, '..', '..');
    const roots = [
        path.join(NATIVE, 'app'), path.join(NATIVE, 'components'), path.join(NATIVE, 'utils'),
        path.join(REPO, 'apps', 'pwa', 'src'), path.join(REPO, 'packages', 'beanpool-guide', 'content'),
    ];
    const files: string[] = [];
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name === '__tests__' || e.name.startsWith('.')) continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.(ts|tsx|md)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(p);
        }
    };
    roots.forEach(walk);

    it('no "take a screenshot", and no screenshot, photo or notes app offered as a place to keep them', () => {
        const offenders = files.filter((f) => /take a screenshot|screenshot or write|photo or write|(save|keep) them in (a|your|another) (note|notes|app)/i.test(fs.readFileSync(f, 'utf8')));
        expect(offenders.map((f) => path.relative(REPO, f))).toEqual([]);
    });

    it('Safety Backup says paper', () => {
        expect(read('app/welcome.tsx')).toContain('💡 Write them down on paper and keep it somewhere safe.');
    });
});
