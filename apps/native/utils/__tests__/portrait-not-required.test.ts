/**
 * Google Play lists the app for devices without a portrait screen (Play console on 1.4.6 340 and 1.4.7 341, "1 issue
 * found"): ML Kit's barcode scanner activity is portrait, so Play implied android.hardware.screen.portrait as required.
 * plugins/withPortraitNotRequired.js declares it not required. What aapt reads from it (a manifest-only APK, 20 Nov):
 * without the declaration `uses-implied-feature: name='android.hardware.screen.portrait' reason='one or more activities
 * have specified a portrait orientation'`; with it, `uses-feature-not-required: name='android.hardware.screen.portrait'`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const nodeRequire = createRequire(import.meta.url);
const PORTRAIT = 'android.hardware.screen.portrait';

describe('the portrait screen is not required (Play)', () => {
    it('the build runs the plugin', () => {
        const app = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../app.json'), 'utf8'));
        expect(app.expo.plugins).toContain('./plugins/withPortraitNotRequired');
        // The app's own screens still turn with the screen: nothing is made portrait-only.
        expect(app.expo.orientation).toBe('default');
    });

    const cases: Array<[string, any[] | undefined, any[]]> = [
        ['no features yet', undefined, [{ $: { 'android:name': PORTRAIT, 'android:required': 'false' } }]],
        ['other features kept', [{ $: { 'android:name': 'android.hardware.camera', 'android:required': 'false' } }],
            [{ $: { 'android:name': 'android.hardware.camera', 'android:required': 'false' } }, { $: { 'android:name': PORTRAIT, 'android:required': 'false' } }]],
        ['a required one made not required', [{ $: { 'android:name': PORTRAIT, 'android:required': 'true' } }],
            [{ $: { 'android:name': PORTRAIT, 'android:required': 'false' } }]],
        ['already there: once', [{ $: { 'android:name': PORTRAIT, 'android:required': 'false' } }],
            [{ $: { 'android:name': PORTRAIT, 'android:required': 'false' } }]],
    ];
    it.each(cases)('%s', (_name, features, after) => {
        const { portraitNotRequired } = nodeRequire('../../plugins/withPortraitNotRequired.js');
        const manifest: any = { $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' }, application: [{ $: {} }] };
        if (features) manifest['uses-feature'] = features;
        expect(portraitNotRequired(manifest)['uses-feature']).toEqual(after);
        // Run twice (a second prebuild): the same.
        expect(portraitNotRequired(manifest)['uses-feature']).toEqual(after);
    });
});
