/**
 * utils/listing-status-words.ts: a listing's or deal's status on Talk's pills, in the member's language. The status is
 * the node's, synced to the phone, so one this build doesn't know is shown as the node wrote it, and never takes the
 * Talk list or a chat's header down (review of #2179).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { pseudoLocalise, setLanguage } from '@beanpool/core';
import { listingHeaderStatusWords, listingStatusWords } from '../listing-status-words';

afterEach(() => setLanguage('en'));

describe('a status on a pill', () => {
    it('the statuses it knows, in the member\'s language', () => {
        expect(listingStatusWords('pending')).toBe('HELD IN TRUST');
        expect(listingHeaderStatusWords('pending')).toBe('PENDING');
        expect(listingHeaderStatusWords(null)).toBe('UNKNOWN');
        setLanguage('xx');
        expect(listingStatusWords('pending')).toBe(pseudoLocalise('HELD IN TRUST'));
        expect(listingHeaderStatusWords('completed')).toBe(pseudoLocalise('COMPLETED'));
    });

    it('one it doesn\'t know, as the node wrote it: an Object.prototype name included, never a crash', () => {
        for (const status of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'archived']) {
            expect(listingStatusWords(status), status).toBe(status.toUpperCase());
            expect(listingHeaderStatusWords(status), status).toBe(status.toUpperCase());
        }
    });
});
