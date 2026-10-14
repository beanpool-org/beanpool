/**
 * Copy of the 12 words stays on the clipboard for a minute (utils/words-clipboard.ts).
 *
 * - A minute after the copy, with BeanPool in front, the clipboard is cleared if it still holds exactly the words.
 * - Something the member copied since is never touched.
 * - The minute is the helper's, not the screen's: nothing a screen does cancels it.
 * - A minute that ends while BeanPool is behind is finished when it comes back (Android lets only the app in front read
 *   the clipboard, and answers anyone else with nothing).
 * - Every Copy of the words goes through it, with the line saying so next to the button.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const phone = vi.hoisted(() => ({
    os: 'android' as 'android' | 'ios' | 'web',
    state: 'active' as string,
    listeners: new Set<(s: string) => void>(),
    clip: '',
    /** What a read answers: the clipboard, or nothing when the app isn't allowed to read it. */
    readable: true,
}));
vi.mock('react-native', () => ({
    Platform: { get OS() { return phone.os; } },
    AppState: {
        get currentState() { return phone.state; },
        addEventListener: (_type: string, fn: (s: string) => void) => {
            phone.listeners.add(fn);
            return { remove: () => phone.listeners.delete(fn) };
        },
    },
}));
const clipboard = vi.hoisted(() => ({
    getStringAsync: vi.fn(async () => (phone.readable ? phone.clip : '')),
    setStringAsync: vi.fn(async (text: string) => { phone.clip = text; return true; }),
}));
vi.mock('expo-clipboard', () => clipboard);

const WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

async function helper() {
    vi.resetModules();
    return import('../words-clipboard');
}

/** The app goes behind another, or comes back to the front. */
function appIs(state: 'active' | 'background'): void {
    phone.state = state;
    for (const fn of [...phone.listeners]) fn(state);
}

beforeEach(() => {
    vi.useFakeTimers();
    phone.os = 'android';
    phone.state = 'active';
    phone.listeners.clear();
    phone.clip = '';
    phone.readable = true;
    clipboard.getStringAsync.mockClear();
    clipboard.setStringAsync.mockClear();
});
afterEach(() => {
    vi.useRealTimers();
});

describe('the minute', () => {
    it('clears the words a minute after the copy, with the app in front', async () => {
        const { copyWordsForAMinute } = await helper();
        await copyWordsForAMinute(WORDS);
        expect(phone.clip).toBe(WORDS);

        await vi.advanceTimersByTimeAsync(59_000);
        expect(phone.clip).toBe(WORDS);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(phone.clip).toBe('');
    });

    it('leaves alone something the member copied since', async () => {
        const { copyWordsForAMinute } = await helper();
        await copyWordsForAMinute(WORDS);
        phone.clip = 'an invite code';
        await vi.advanceTimersByTimeAsync(61_000);
        expect(phone.clip).toBe('an invite code');
        expect(clipboard.setStringAsync).toHaveBeenCalledTimes(1);
    });

    it('is kept by the helper: a screen that goes away does not stop the clearing', async () => {
        const { copyWordsForAMinute } = await helper();
        // The screen's promise settles and the screen is gone; nothing it holds can cancel the minute.
        await expect(copyWordsForAMinute(WORDS)).resolves.toBeUndefined();
        await vi.advanceTimersByTimeAsync(61_000);
        expect(phone.clip).toBe('');
    });

    it('a minute that ends with the app behind is finished when it comes back, a second later', async () => {
        const { copyWordsForAMinute } = await helper();
        await copyWordsForAMinute(WORDS);
        appIs('background');
        phone.readable = false;
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(clipboard.getStringAsync).not.toHaveBeenCalled();
        expect(phone.clip).toBe(WORDS);

        phone.readable = true;
        appIs('active');
        await vi.advanceTimersByTimeAsync(999);
        expect(clipboard.getStringAsync).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(phone.clip).toBe('');
    });

    it('an answer that can\'t tell (nothing) is tried again on the next two returns, then left', async () => {
        const { copyWordsForAMinute } = await helper();
        await copyWordsForAMinute(WORDS);
        phone.readable = false;
        await vi.advanceTimersByTimeAsync(61_000);
        expect(clipboard.getStringAsync).toHaveBeenCalledTimes(1);
        expect(phone.clip).toBe(WORDS);

        appIs('background');
        appIs('active');
        await vi.advanceTimersByTimeAsync(1_000);
        expect(clipboard.getStringAsync).toHaveBeenCalledTimes(2);

        phone.readable = true;
        appIs('background');
        appIs('active');
        await vi.advanceTimersByTimeAsync(1_000);
        expect(clipboard.getStringAsync).toHaveBeenCalledTimes(3);
        expect(phone.clip).toBe('');
    });

    it('gives up after three reads that can\'t tell', async () => {
        const { copyWordsForAMinute } = await helper();
        await copyWordsForAMinute(WORDS);
        phone.readable = false;
        await vi.advanceTimersByTimeAsync(61_000);
        for (let i = 0; i < 4; i++) {
            appIs('background');
            appIs('active');
            await vi.advanceTimersByTimeAsync(1_000);
        }
        expect(clipboard.getStringAsync).toHaveBeenCalledTimes(3);
        expect(phone.listeners.size).toBe(0);
        expect(phone.clip).toBe(WORDS);
    });

    it('a newer copy takes over: the minute runs from it', async () => {
        const { copyWordsForAMinute } = await helper();
        await copyWordsForAMinute(WORDS);
        await vi.advanceTimersByTimeAsync(30_000);
        await copyWordsForAMinute(WORDS);
        await vi.advanceTimersByTimeAsync(31_000);
        expect(phone.clip).toBe(WORDS);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(phone.clip).toBe('');
    });

    it('a read or a clear that fails never throws', async () => {
        const { copyWordsForAMinute } = await helper();
        await copyWordsForAMinute(WORDS);
        clipboard.getStringAsync.mockRejectedValueOnce(new Error('no clipboard'));
        await vi.advanceTimersByTimeAsync(61_000);
        clipboard.setStringAsync.mockRejectedValueOnce(new Error('no clipboard'));
        appIs('background');
        appIs('active');
        await vi.advanceTimersByTimeAsync(1_000);
        expect(clipboard.getStringAsync).toHaveBeenCalledTimes(2);
    });

    it('the native app\'s web build copies and leaves the clipboard alone (a browser would ask to read it)', async () => {
        phone.os = 'web';
        const { copyWordsForAMinute } = await helper();
        await copyWordsForAMinute(WORDS);
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(clipboard.getStringAsync).not.toHaveBeenCalled();
        expect(phone.clip).toBe(WORDS);
    });
});

describe('every Copy of the words', () => {
    const NATIVE = path.resolve(__dirname, '..', '..');
    const read = (rel: string) => fs.readFileSync(path.join(NATIVE, rel), 'utf8');

    it('goes through copyWordsForAMinute, and nothing writes the words to the clipboard directly', () => {
        const welcome = read('app/welcome.tsx');
        const settings = read('app/(tabs)/settings.tsx');
        expect(welcome.match(/copyWordsForAMinute\(/g)?.length).toBe(2);
        expect(settings.match(/copyWordsForAMinute\(/g)?.length).toBe(2);
        for (const src of [welcome, settings]) {
            expect(src).not.toMatch(/Clipboard\.setStringAsync\((words|mnemonicWords|seedWords|pendingWords|outgoingWords)/);
        }
    });

    it('says next to the button that the copy clears in a minute', async () => {
        const { COPY_CLEARS_LINE } = await helper();
        expect(COPY_CLEARS_LINE).toBe('The copy clears from your clipboard after a minute. If you leave BeanPool first, it clears when you come back.');
        expect(read('app/welcome.tsx').match(/<CopyClearsNote /g)?.length).toBe(2);
        expect(read('app/(tabs)/settings.tsx').match(/<CopyClearsNote /g)?.length).toBe(2);
    });

    it('keeps no timer of its own on a screen that could cancel it', () => {
        for (const file of ['app/welcome.tsx', 'app/(tabs)/settings.tsx']) {
            expect(read(file)).not.toMatch(/Clipboard\.getStringAsync\(\)[\s\S]{0,200}setStringAsync\(''\)/);
        }
    });
});
