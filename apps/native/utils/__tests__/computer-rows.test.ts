/**
 * Settings' two "computer" rows say what they do (Marty, 2026-09-27: were "Sign in on a computer" and "Link Another
 * Device" the same thing? They aren't).
 *
 * - "Manage this community from a computer" (NodeAdminEntry, owners/admins; "Moderate …" for a moderator) signs a
 *   computer's browser into the community's Settings page. The key stays on the phone.
 * - "Use your account on another device" (Settings → pair-device) copies the member's own account to a browser.
 *
 * Each row's accessibilityLabel is its visible label (WCAG 2.5.3). The screens cannot be rendered here (see
 * vitest.config.ts): the words are read from their source.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Code only: what a comment says is not what the screen shows. */
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (rel: string) => code(fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf-8'));
/** The <Pressable …> … </Pressable> that holds `needle`. */
function pressableAround(s: string, needle: string): string {
    const at = s.indexOf(needle);
    expect(at, `missing: ${needle}`).toBeGreaterThan(-1);
    const from = s.lastIndexOf('<Pressable', at);
    const to = s.indexOf('</Pressable>', at);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(at);
    return s.slice(from, to);
}

describe("Settings' computer rows", () => {
    it('the community one: labelled by computerSigninLabel, on screen and for a screen reader, and says the key stays', () => {
        const row = pressableAround(read('components/NodeAdminEntry.tsx'), "pathname: '/settings-signin'");
        expect(row).toContain('accessibilityLabel={computerLabel}');
        expect(row).toContain('<Text style={styles.menuText}>{computerLabel}</Text>');
        expect(row).toContain('your key stays on this phone');
        expect(read('components/NodeAdminEntry.tsx')).toContain('const computerLabel = computerSigninLabel(role);');
    });

    it('the account one: "Use your account on another device", on screen and for a screen reader', () => {
        const row = pressableAround(read('app/(tabs)/settings.tsx'), "router.push('/pair-device')");
        expect(row).toContain('accessibilityLabel="Use your account on another device"');
        expect(row).toContain('<Text style={styles.menuText}>Use your account on another device</Text>');
        expect(row).toContain('Copies your own account to a browser, to use BeanPool there as you');
    });

    it("pair-device's header matches, and wraps rather than running off a narrow screen", () => {
        const src = read('app/pair-device.tsx');
        expect(src).toContain('<Text style={styles.headerTitle}>Your account on another device</Text>');
        const style = src.slice(src.indexOf('headerTitle: {'), src.indexOf('},', src.indexOf('headerTitle: {')));
        expect(style).toContain('flexShrink: 1');
    });

    it('neither old name is left on a row', () => {
        for (const rel of ['components/NodeAdminEntry.tsx', 'app/(tabs)/settings.tsx', 'app/pair-device.tsx', 'app/settings-signin.tsx']) {
            expect(read(rel), rel).not.toMatch(/Sign in on a computer|Link Another Device/i);
        }
    });
});
