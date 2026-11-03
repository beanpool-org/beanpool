/**
 * Lights-out H2: iOS asks for Local Network the first time the app reaches the hall laptop's number (Apple TN3179), and
 * an app with no NSLocalNetworkUsageDescription gets a generic question or none. app.json carries the English, and Expo's
 * `locales` one file per language (apps/native/infoplist-words), so the question comes in the member's language.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LANGS } from '@beanpool/core';

const NATIVE = path.resolve(__dirname, '../..');
const app = JSON.parse(fs.readFileSync(path.join(NATIVE, 'app.json'), 'utf8')).expo;

describe('the Local Network question, in every language', () => {
    it('app.json carries the English sentence', () => {
        expect(app.ios.infoPlist.NSLocalNetworkUsageDescription).toBe(
            "BeanPool uses this to reach your community's laptop on the hall Wi-Fi when the internet is down.",
        );
        // Local networking stays allowed in plain http (the hall laptop's number).
        expect(app.ios.infoPlist.NSAppTransportSecurity.NSAllowsLocalNetworking).toBe(true);
    });

    it('every language the app speaks has its file, with the sentence, and nothing else', () => {
        expect(Object.keys(app.locales).sort()).toEqual([...LANGS].sort());
        for (const lang of LANGS) {
            const file = path.join(NATIVE, app.locales[lang]);
            const words = JSON.parse(fs.readFileSync(file, 'utf8'));
            expect(Object.keys(words), lang).toEqual(['NSLocalNetworkUsageDescription']);
            const s: string = words.NSLocalNetworkUsageDescription;
            expect(s.length, lang).toBeGreaterThan(20);
            expect(s, lang).toContain('BeanPool');
            expect(s.toLowerCase(), lang).not.toMatch(/resilien|surviv/);
        }
    });
});
