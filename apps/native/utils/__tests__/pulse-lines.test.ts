/**
 * components/pulse-lines.ts translates, where the Channels screen and the Pulse tab show them, the sentences
 * utils/pulse-oauth.ts, utils/pulse.ts and utils/node-url.ts write in English (those files keep a platform's token or
 * sign a request, and never reach the words layer). Each sentence it knows is held here to the source that writes it: every fixed sentence
 * thrown in those files is found (the pseudo-locale brackets it), the ones with a name or a status in them are built by
 * the real connectRefusal or read from the source's own template, and in English each reads exactly as its source
 * writes it. What a node or a platform said is shown as it came.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, DeviceEventEmitter: { addListener: () => ({ remove() {} }) } }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (len: number) => new Uint8Array(len).fill(9) }));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: async () => ({ type: 'cancel' }), dismissAuthSession: () => {} }));
vi.mock('expo-linking', () => ({ addEventListener: () => ({ remove() {} }) }));
vi.mock('../node-post', () => ({ anchorUrl: async () => null, signedPost: async () => ({ ok: true, json: async () => ({}) }) }));

import { pseudoLocalise, setLanguage } from '@beanpool/core';
import { connectRefusal } from '../pulse-oauth';
import { UNSAFE_NODE_ADDRESS_MESSAGE } from '../node-url';
import { pulseLineWords } from '../../components/pulse-lines';

afterEach(() => setLanguage('en'));

const ROOT = path.resolve(__dirname, '../..');
const source = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const inXx = (fn: () => string) => { setLanguage('xx'); try { return fn(); } finally { setLanguage('en'); } };
/** Letters left once every bracket, and the names given, are taken out. */
function outsideBrackets(text: string, names: readonly string[] = []): string {
    let rest = text;
    for (let was = ''; was !== rest;) { was = rest; rest = rest.replace(/\[[^[\]]*\]/g, ''); }
    for (const n of [...names].sort((a, b) => b.length - a.length)) rest = rest.split(n).join('');
    return rest.replace(/[^\p{L}]+/gu, ' ').trim();
}

/** Every fixed sentence a file throws: `new PulseOAuthError('reason', '…')`, `new Error('…')`, and `new Error(a || b || '…')`. */
function thrownSentences(rel: string): string[] {
    const src = source(rel);
    const out = new Set<string>();
    for (const m of src.matchAll(/new PulseOAuthError\(\s*'[a-z-]+',\s*'([^']+)'\s*\)/g)) out.add(m[1]);
    for (const m of src.matchAll(/new Error\(([^;]*?)\);/g)) {
        const last = m[1].match(/'([^']+)'\s*$/);
        if (last) out.add(last[1]);
    }
    return [...out];
}

/** The sentences built from a template in those files, each as its source writes it and with the values a member sees. */
const TEMPLATES: ReadonlyArray<{ file: string; template: string; sample: string; values: string[] }> = [
    { file: 'utils/pulse-oauth.ts', template: '`${platformName} connection timed out.`', sample: 'TikTok connection timed out.', values: ['TikTok'] },
    { file: 'utils/pulse-oauth.ts', template: '`${platformName} connection timed out.`', sample: 'Instagram Creator connection timed out.', values: ['Instagram Creator'] },
    { file: 'utils/pulse-oauth.ts', template: '`Could not reach your community node: ${e.message}`', sample: 'Could not reach your community node: Network request failed', values: ['Network request failed'] },
    { file: 'utils/pulse-oauth.ts', template: '`TikTok returned error: ${error}`', sample: 'TikTok returned error: access_denied', values: ['access_denied'] },
    { file: 'utils/pulse.ts', template: '`Failed to load feed page (${res.status})`', sample: 'Failed to load feed page (503)', values: [] },
    { file: 'utils/pulse.ts', template: '`Failed to update mute status (${res.status})`', sample: 'Failed to update mute status (500)', values: [] },
    { file: 'utils/pulse.ts', template: '`Failed to report item (${res.status})`', sample: 'Failed to report item (429)', values: [] },
];

describe('the Pulse lower layers\' English, in the member\'s language where it is shown', () => {
    it('finds the fixed sentences in both files (the scan itself is not empty)', () => {
        expect(thrownSentences('utils/pulse-oauth.ts')).toEqual(expect.arrayContaining([
            'Update BeanPool to connect this channel.', 'TikTok connection is not configured on this community node.', 'Failed to disconnect channel.',
        ]));
        expect(thrownSentences('utils/pulse.ts')).toEqual(expect.arrayContaining(['Invalid feed response from server', 'Not connected to a node.']));
    });

    it('every fixed sentence pulse-oauth.ts and pulse.ts throw: English exactly as written, translated in the pseudo-locale', () => {
        for (const file of ['utils/pulse-oauth.ts', 'utils/pulse.ts']) {
            for (const sentence of thrownSentences(file)) {
                expect(pulseLineWords(sentence), `${file}: ${sentence}`).toBe(sentence);
                expect(inXx(() => pulseLineWords(sentence)), `${file}: ${sentence}`).toBe(pseudoLocalise(sentence));
            }
        }
    });

    it('utils/node-url.ts\'s refusal of an address the key will not sign for, from the real constant', () => {
        expect(pulseLineWords(UNSAFE_NODE_ADDRESS_MESSAGE)).toBe(UNSAFE_NODE_ADDRESS_MESSAGE);
        expect(inXx(() => pulseLineWords(UNSAFE_NODE_ADDRESS_MESSAGE))).toBe(pseudoLocalise(UNSAFE_NODE_ADDRESS_MESSAGE));
    });

    it('the sentences built from a template: each template is in its source; English as built; translated around the values', () => {
        for (const { file, template, sample, values } of TEMPLATES) {
            expect(source(file), `${file} still writes ${template}`).toContain(template);
            expect(pulseLineWords(sample)).toBe(sample);
            const xx = inXx(() => pulseLineWords(sample));
            expect(xx, sample).not.toBe(sample);
            expect(outsideBrackets(xx, values), sample).toBe('');
            for (const v of values) expect(xx).toContain(v);
        }
    });

    it('connectRefusal\'s sentences, from the real function: English as it writes them, translated with the platform and the handle as written', () => {
        const cases: Array<[string, string | null, number, Record<string, unknown>]> = [];
        for (const platform of ['TikTok', 'Instagram']) {
            cases.push(
                [platform, '@kofi.makes', 403, { error: 'account_mismatch' }],
                [platform, null, 403, { error: 'account_mismatch' }],
                [platform, '@kofi.makes', 400, { error: 'not_verifiable' }],
                [platform, '@kofi.makes', 502, { error: 'identity_unavailable' }],
                [platform, '@kofi.makes', 426, { error: 'update_required' }],
                [platform, '@kofi.makes', 429, { error: 'rate_limited' }],
                [platform, '@kofi.makes', 404, {}],
                [platform, '@kofi.makes', 500, {}],
            );
        }
        for (const [platform, handle, status, json] of cases) {
            const english = connectRefusal(platform, handle, status, json).message;
            expect(pulseLineWords(english), english).toBe(english);
            const xx = inXx(() => pulseLineWords(english));
            expect(xx, english).not.toBe(english);
            expect(outsideBrackets(xx, [platform, ...(handle ? [handle] : [])]), english).toBe('');
        }
    });

    it('a node\'s or a platform\'s own words are shown as they came, in every language', () => {
        const theirs = [
            connectRefusal('TikTok', '@kofi', 502, { error: 'identity_unavailable', message: 'TikTok is down for maintenance.' }).message,
            connectRefusal('TikTok', '@kofi', 400, { error_description: 'The code has expired.' }).message,
            'Signed request required',
            'Could not connect to server.',
        ];
        for (const words of theirs) expect(inXx(() => pulseLineWords(words))).toBe(words);
    });
});
