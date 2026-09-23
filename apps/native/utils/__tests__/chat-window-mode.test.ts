/**
 * The Android window's soft-input mode has ONE owner: ChatKeyboardAvoidingView.
 *
 * The mode is a property of the WINDOW, not of a component, so any second component that sets it wins by
 * mount order and loses by unmount order. react-native-keyboard-controller's `useKeyboardHandler` and
 * `useKeyboardAnimation` both call `useResizeMode()` behind the hook — `setInputMode(ADJUST_RESIZE)` on mount,
 * `setDefaultMode()` on unmount — so a chat component that reaches for either quietly undoes the
 * ADJUST_NOTHING the avoiding view declares, and the restore on unmount defeats the mounted-screens counter
 * that exists to keep a chat pushed on top of a chat from handing the default back.
 *
 * That happened: ChatMessageList used `useKeyboardHandler` to follow the keyboard frame by frame. In a group
 * or event chat the list mounts in the same commit as the avoiding view, so ADJUST_NOTHING landed last and
 * the bug was invisible; in the DM the list mounts only after the first read, so the window stayed
 * ADJUST_RESIZE for the rest of the screen's life. With the lift now padding by the ABSOLUTE keyboard height,
 * a window the OS also resizes underneath it (Android 10 and below, and this product's floor is API 26)
 * would lift the composer twice.
 *
 * The screens are not rendered here (see vitest.config.ts), so this reads their source. `useGenericKeyboardHandler`
 * is the variant that sets no mode, and is what a chat component that only wants the frames must use.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const NATIVE_ROOT = join(__dirname, '..', '..');

/** The one file allowed to name the window's mode. */
const MODE_OWNER = 'components/chat/ChatKeyboardAvoidingView.tsx';

/** The screens that host the shared chat components; everything under components/chat/ is added to these. */
const CHAT_SCREENS = [
    'app/chat/[id].tsx',
    'components/GroupChatView.tsx',
    'components/EventChatView.tsx',
];

/** The hooks that set the window's mode as a side effect of tracking the keyboard. */
const MODE_SETTING_HOOKS = ['useKeyboardHandler', 'useResizeMode', 'useKeyboardAnimation'];

/**
 * These files explain in prose why they avoid the banned hooks, and MODE_OWNER's comment names
 * `setInputMode`. Only code counts, so comments come out first.
 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        // `[^:]` so a `https://` inside a string is not read as the start of a line comment.
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir: string, out: string[]) {
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '__tests__') continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p);
    }
}

function chatFiles(): string[] {
    const files: string[] = [];
    walk(join(NATIVE_ROOT, 'components', 'chat'), files);
    for (const f of CHAT_SCREENS) files.push(join(NATIVE_ROOT, f));
    return files;
}

describe('the chat owns the Android window mode in exactly one place', () => {
    it('is reading the files it means to', () => {
        const names = chatFiles().map(f => relative(NATIVE_ROOT, f));
        expect(names).toContain('components/chat/ChatMessageList.tsx');
        expect(names).toContain(MODE_OWNER);
        for (const screen of CHAT_SCREENS) expect(names).toContain(screen);
    });

    it('no chat component or screen uses a hook that sets the window mode', () => {
        const offenders: string[] = [];
        for (const file of chatFiles()) {
            const src = stripComments(readFileSync(file, 'utf8'));
            for (const hook of MODE_SETTING_HOOKS) {
                if (new RegExp(`\\b${hook}\\b`).test(src)) {
                    offenders.push(`${relative(NATIVE_ROOT, file)}: ${hook}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('nothing in the app calls setInputMode but the avoiding view', () => {
        const files: string[] = [];
        walk(join(NATIVE_ROOT, 'app'), files);
        walk(join(NATIVE_ROOT, 'components'), files);
        walk(join(NATIVE_ROOT, 'utils'), files);
        walk(join(NATIVE_ROOT, 'services'), files);

        const callers = files
            .filter(f => /\bsetInputMode\s*\(/.test(stripComments(readFileSync(f, 'utf8'))))
            .map(f => relative(NATIVE_ROOT, f));
        expect(callers).toEqual([MODE_OWNER]);
    });

    it('and the avoiding view really does set ADJUST_NOTHING (so the rule above cannot pass by nobody setting it)', () => {
        const src = stripComments(readFileSync(join(NATIVE_ROOT, MODE_OWNER), 'utf8'));
        expect(src).toMatch(/setInputMode\(AndroidSoftInputModes\.SOFT_INPUT_ADJUST_NOTHING\)/);
        expect(src).toMatch(/setDefaultMode\(\)/);
    });
});
