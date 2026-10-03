/**
 * The recovery kit's page (recovery-kit.ts), shared by the phone and the web app. The phone's own tests
 * (apps/native/utils/__tests__/recovery-kit.test.ts) cover the words, escaping and what the page leaves out; these
 * cover the two ways back in and the one-sheet print layout.
 */
import { describe, expect, it } from 'vitest';
import { KIT_RESTORE_STEPS, KIT_WEB_RESTORE_STEPS, recoveryKitHtml } from '../recovery-kit.js';

const WORDS = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];
const KIT = { words: WORDS, communityName: 'Mullum', communityAddress: 'http://10.0.0.7:8080', date: new Date(2026, 9, 3) };

describe('recoveryKitHtml', () => {
    it('has "How to get back in" on a phone, then in a web browser, each with its own steps', () => {
        const html = recoveryKitHtml(KIT);
        const back = html.indexOf('How to get back in');
        const phone = html.indexOf('>On a phone<');
        const web = html.indexOf('>In a web browser<');
        expect(back).toBeGreaterThan(0);
        expect(phone).toBeGreaterThan(back);
        expect(web).toBeGreaterThan(phone);
        expect(html.indexOf('Already a Member? Restore Account')).toBeGreaterThan(phone);
        expect(html.indexOf('Already a Member? Restore Account')).toBeLessThan(web);
        expect(html.indexOf('Restore Existing Identity')).toBeGreaterThan(web);
        expect(KIT_RESTORE_STEPS).toHaveLength(6);
        expect(KIT_WEB_RESTORE_STEPS[0]).toBe('Open your community’s address (written above) in a web browser.');
        expect(KIT_WEB_RESTORE_STEPS[KIT_WEB_RESTORE_STEPS.length - 1]).toMatch(/^Click “Recover Identity”/);
    });

    it('names the address it was given, an IP as well as a domain, and assumes no domain of its own', () => {
        const html = recoveryKitHtml(KIT);
        expect(html).toContain('Address: <strong>http://10.0.0.7:8080</strong>');
        expect(html).not.toMatch(/beanpool\.org/i);
    });

    it('prints on one sheet: an @page rule, and no forced page breaks', () => {
        const html = recoveryKitHtml(KIT);
        expect(html).toMatch(/@page\s*\{/);
        expect(html).not.toMatch(/page-break-(before|after)\s*:\s*always|break-(before|after)\s*:\s*page/);
        expect(html).toContain('Made on 3 October 2026');
    });
});
