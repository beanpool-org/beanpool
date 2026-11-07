/**
 * Two reads of a failed web request that took a busy network's 429 for the node's verdict (deciding review of #2960, round 2,
 * the 429 sweep):
 * - the member's role (GET /api/node-admin/me): "no role" is an answer and hides the invite entries, so a 429 (a busy network,
 *   or the gateway's limit) read as one took the entries from an admin for a busy moment;
 * - the tour's record: a refusal drops what was kept to send again, so a 429 read as one lost the tour's end.
 * No answer at all and a 5xx are neither. Nothing here contacts a node.
 */
import { describe, expect, it } from 'vitest';
import { busyError } from '@beanpool/core';
import { roleReadRefused } from './node-invites';
import { tourRecordRefused } from './tour-store';

const status = (n: number) => Object.assign(new Error('x'), { status: n });

describe('roleReadRefused', () => {
    it('is the node refusing (not a member, an older node): no role', () => {
        for (const s of [400, 401, 403, 404]) expect(roleReadRefused(status(s)), String(s)).toBe(true);
    });
    it('is not a busy network (429, code busy), the gateway\'s own 429, a 5xx, or no answer: the role stays unknown', () => {
        expect(roleReadRefused(busyError(null))).toBe(false);
        expect(roleReadRefused(status(429))).toBe(false);
        for (const s of [500, 502, 503, 530]) expect(roleReadRefused(status(s)), String(s)).toBe(false);
        for (const e of [new TypeError('Failed to fetch'), null, undefined, {}, { status: '404' }]) expect(roleReadRefused(e)).toBe(false);
    });
});

describe('tourRecordRefused', () => {
    it('is the node refusing the record outright (a 4xx): the card ends and nothing is kept', () => {
        for (const s of [400, 403, 404, 422]) expect(tourRecordRefused(status(s)), String(s)).toBe(true);
    });
    it('is not a busy network (429), a 5xx, or no answer: the record is kept and sent on the next Home open', () => {
        expect(tourRecordRefused(busyError('3'))).toBe(false);
        expect(tourRecordRefused(status(429))).toBe(false);
        for (const s of [500, 503]) expect(tourRecordRefused(status(s)), String(s)).toBe(false);
        for (const e of [new TypeError('Failed to fetch'), null, undefined, {}]) expect(tourRecordRefused(e)).toBe(false);
    });
});
