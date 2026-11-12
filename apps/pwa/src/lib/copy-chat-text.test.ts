// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { copyableChatText, copyChatText } from './copy-chat-text';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('copyableChatText: which words a Copy may put on the clipboard', () => {
    it('is the words as shown', () => {
        expect(copyableChatText('See you at 3\nbring the key')).toBe('See you at 3\nbring the key');
    });
    it('is nothing for a removed line, a stand-in for a line that did not open, or no words', () => {
        expect(copyableChatText('This message was deleted', { removed: true })).toBeNull();
        expect(copyableChatText('[Unable to decrypt this message]', { unreadable: ['[Unable to decrypt this message]'] })).toBeNull();
        expect(copyableChatText('   ')).toBeNull();
        expect(copyableChatText('')).toBeNull();
        expect(copyableChatText(null)).toBeNull();
    });
});

describe('copyChatText', () => {
    it('writes to the clipboard when the browser has one', async () => {
        const writeText = vi.fn(async () => {});
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        await expect(copyChatText('hello')).resolves.toBe(true);
        expect(writeText).toHaveBeenCalledWith('hello');
    });

    it('falls back to the older copy command where there is no clipboard (a plain http:// address on the local network)', async () => {
        vi.stubGlobal('navigator', {});
        let copiedWhileSelected = '';
        (document as any).execCommand = vi.fn(() => {
            // The helper box holds the words, and they are what the older command copies.
            copiedWhileSelected = document.querySelector('textarea')?.value ?? '';
            return true;
        });
        await expect(copyChatText('on the LAN')).resolves.toBe(true);
        expect((document as any).execCommand).toHaveBeenCalledWith('copy');
        expect(copiedWhileSelected).toBe('on the LAN');
        // The helper box does not stay in the page.
        expect(document.querySelector('textarea')).toBeNull();
    });

    it('says false when the browser refuses both ways', async () => {
        vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('denied'); }) } });
        (document as any).execCommand = vi.fn(() => false);
        await expect(copyChatText('nope')).resolves.toBe(false);
    });
});

describe("a member's own bubble: its selection can be seen", () => {
    it('index.css draws the selection on .bp-bubble-mine in a colour other than the bubble\'s own accent', () => {
        const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8');
        const rule = css.match(/\.bp-bubble-mine\s+::selection[^{]*\{([^}]*)\}/);
        expect(rule, 'a .bp-bubble-mine ::selection rule').toBeTruthy();
        const background = rule![1].match(/background:\s*([^;]+);/)?.[1].trim();
        expect(background).toBeTruthy();
        // The global ::selection is the sage fill under white, which is the own bubble's colour: fill on fill shows nothing.
        const global = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/(?:^|\})\s*::selection\s*\{([^}]*)\}/)?.[1].match(/background:\s*([^;]+);/)?.[1].trim();
        expect(global).toBe('var(--bp-sage-fill)');
        expect(background).not.toBe(global);
    });
});
