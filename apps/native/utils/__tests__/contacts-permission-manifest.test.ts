/**
 * The contacts permission as the build will declare it (DESIGN-private-contacts-fable.md §3.4, slice C3): read only.
 * expo-contacts' config plugin adds READ_CONTACTS and WRITE_CONTACTS; app.json blocks WRITE_CONTACTS, so the app's manifest
 * carries it only as `tools:node="remove"`, which also strips it from any library manifest at the merge. Checked through
 * Expo's own introspection (what `expo config --type introspect` and prebuild run): every plugin in app.json and app.config.js
 * applied, nothing written to disk. And iOS gets the sentence the member reads (app.json, the plugin and the 25 languages).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const NATIVE = path.resolve(__dirname, '../..');
const fromNative = createRequire(path.join(NATIVE, 'package.json'));
const fromExpo = createRequire(fromNative.resolve('expo/package.json'));
const SENTENCE = 'BeanPool reads your contacts only when you tap Import contacts, to show you a list to choose from. What you import is locked so only you can read it.';

type Perm = { 'android:name': string; 'tools:node'?: string };

async function introspect(): Promise<{ android: Perm[]; infoPlist: Record<string, unknown> }> {
    const { getPrebuildConfigAsync } = fromExpo('@expo/prebuild-config');
    const { compileModsAsync } = fromExpo('@expo/config-plugins');
    const { exp } = await getPrebuildConfigAsync(NATIVE, { platforms: ['android', 'ios'] });
    const out = await compileModsAsync(exp, { projectRoot: NATIVE, platforms: ['android', 'ios'], introspect: true, assertMissingModProviders: false });
    const android = (out._internal.modResults.android.manifest.manifest['uses-permission'] as { $: Perm }[]).map((p) => p.$);
    return { android, infoPlist: out._internal.modResults.ios.infoPlist };
}

describe('the contacts permission: read only, in the merged manifest', () => {
    it('READ_CONTACTS is asked for; WRITE_CONTACTS only as removed', async () => {
        const { android, infoPlist } = await introspect();
        const contacts = android.filter((p) => /CONTACTS/.test(p['android:name']));
        // Mutation: drop "android.permission.WRITE_CONTACTS" from app.json's blockedPermissions → a plain WRITE_CONTACTS here.
        expect(contacts).toEqual([
            { 'android:name': 'android.permission.READ_CONTACTS' },
            { 'android:name': 'android.permission.WRITE_CONTACTS', 'tools:node': 'remove' },
        ]);
        // iOS asks with the member's sentence, never the plugin's "Allow $(PRODUCT_NAME) to access your contacts".
        expect(infoPlist.NSContactsUsageDescription).toBe(SENTENCE);
    }, 60_000);

    it('app.json gives expo-contacts the same sentence, and adds no other contacts permission', () => {
        const app = JSON.parse(fs.readFileSync(path.join(NATIVE, 'app.json'), 'utf8')).expo;
        expect(app.ios.infoPlist.NSContactsUsageDescription).toBe(SENTENCE);
        const plugin = app.plugins.find((p: unknown) => Array.isArray(p) && p[0] === 'expo-contacts');
        expect(plugin?.[1]).toEqual({ contactsPermission: SENTENCE });
        expect(app.android.permissions.filter((p: string) => /CONTACTS/.test(p))).toEqual([]);
        expect(app.android.blockedPermissions).toContain('android.permission.WRITE_CONTACTS');
    });
});
