/**
 * The capture driver's patch of its scratch copy (e2e/demo/capture.mjs `patchTree`): Sam's identity hook, the silenced LogBox, the
 * status bar on the pushed post page, and (iOS) the theme following the phone. It edits the copy by exact text, so a change to
 * one of those three app files that moves the text must fail HERE, not in the middle of an emulator run. No emulator.
 *
 * The real files are copied into a temp tree first: the patch never touches the app's own sources.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchTree } from '../capture.mjs';

const NATIVE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FILES = ['app/IdentityContext.tsx', 'app/ThemeContext.tsx', 'app/post/[id].tsx'];

let tree = '';
const read = (rel: string) => fs.readFileSync(path.join(tree, 'apps/native', rel), 'utf8');

beforeEach(() => {
    tree = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-patch-test-'));
    for (const rel of FILES) {
        fs.mkdirSync(path.dirname(path.join(tree, 'apps/native', rel)), { recursive: true });
        fs.copyFileSync(path.join(NATIVE, rel), path.join(tree, 'apps/native', rel));
    }
});
afterEach(() => fs.rmSync(tree, { recursive: true, force: true }));

describe('capture.mjs patchTree', () => {
    it("makes the phone Sam when both demo variables are set, and reads the identity as the app always does otherwise", () => {
        patchTree(tree, { ios: false });
        const src = read('app/IdentityContext.tsx');
        expect(src).toContain('process.env.EXPO_PUBLIC_DEMO_WORDS');
        expect(src).toContain('process.env.EXPO_PUBLIC_DEMO_SERVER');
        expect(src).toContain("AsyncStorage.setItem('beanpool_anchor_url', server)");
        expect(src).toContain('createIdentityFromMnemonic(words.split');
        // the provider now starts from the hook, and the hook falls through to loadIdentity when the variables are absent
        expect(src).toContain('        loadDemoIdentity()\n            .then((loaded) => {');
        expect(src).toMatch(/if \(words && server\) \{[\s\S]*\}\n\s+return loadIdentity\(\);/);
        expect(src).toContain('LogBox.ignoreAllLogs(true)');
        // the words themselves are never written into the source: they come from the environment at bundle time
        expect(src).not.toMatch(/struggle|banana/);
    });

    it('leaves the theme alone on Android (light and dark are chosen in Settings) and follows the phone on iOS', () => {
        const before = read('app/ThemeContext.tsx');
        patchTree(tree, { ios: false });
        expect(read('app/ThemeContext.tsx')).toBe(before);
        expect(read('app/IdentityContext.tsx')).not.toContain("'beanpool_theme_mode'");
        fs.copyFileSync(path.join(NATIVE, 'app/IdentityContext.tsx'), path.join(tree, 'apps/native/app/IdentityContext.tsx'));
        patchTree(tree, { ios: true });
        expect(read('app/ThemeContext.tsx')).toContain("useState<ThemePreference>('system')");
        expect(read('app/IdentityContext.tsx')).toContain("'beanpool_theme_mode', 'system'");
    });

    it("sets the status bar on the post page only, inside the post page's own component, and gives it back on leaving", () => {
        patchTree(tree, { ios: false });
        const src = read('app/post/[id].tsx');
        // The listing screen's own component; the route's default export (PostRoute) draws it.
        const at = src.indexOf('\nfunction PostDetailModal() {');
        expect(at).toBeGreaterThan(0);
        expect(src.slice(0, at)).toContain("import { setStatusBarStyle as demoBarStyle } from 'expo-status-bar';");
        const body = src.slice(at);
        expect(body).toContain("demoBarStyle(theme === 'dark' ? 'light' : 'dark')");
        expect(body).toContain("demoBarStyle('light')");
        // exactly once: no other component in the file got the hook
        expect(src.match(/demoBarStyle\(theme/g)).toHaveLength(1);
    });

    it("never writes into the app's own sources", () => {
        const sources = FILES.map((rel) => fs.readFileSync(path.join(NATIVE, rel), 'utf8'));
        patchTree(tree, { ios: true });
        expect(FILES.map((rel) => fs.readFileSync(path.join(NATIVE, rel), 'utf8'))).toEqual(sources);
        expect(sources.join('\n')).not.toContain('loadDemoIdentity');
    });

    it('stops with a plain sentence, not a half-patched tree, when an app file no longer reads as the patch expects', () => {
        fs.writeFileSync(path.join(tree, 'apps/native/app/IdentityContext.tsx'), 'export default function Nothing() { return null; }\n');
        expect(() => patchTree(tree, { ios: false })).toThrow(/identity provider no longer reads/);
    });
});
