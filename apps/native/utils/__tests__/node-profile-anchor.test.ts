/**
 * Which community a screen's node profile belongs to (utils/node-profile-anchor.ts): a switch drops to unknown
 * before the new community's profile is read, and a profile for any community but the current one is never shown.
 * The hook that runs these on each focus is exercised in use-node-profile.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { UNKNOWN_NODE_PROFILE, anchorRead, profileArrived, type AnchoredNodeProfile } from '../node-profile-anchor';
import type { NodeProfile } from '../node-profile';

const A = 'https://global.beanpool.org';
const B = 'https://mullum.beanpool.org';
const GLOBAL: NodeProfile = { profile: 'global', features: { beans: false, openJoin: true }, checkedAt: '2026-09-27T00:00:00.000Z' };
const LOCAL: NodeProfile = { profile: 'local', features: { beans: true }, checkedAt: '2026-09-27T00:00:00.000Z' };

const onA: AnchoredNodeProfile = { url: A, profile: GLOBAL };

describe('anchorRead: the screen came into view on a community', () => {
    it('starts unknown, on no community', () => {
        expect(UNKNOWN_NODE_PROFILE).toEqual({ url: null, profile: null });
    });

    it('drops to unknown on a different community, before anything of the new one is read', () => {
        expect(anchorRead(onA, B)).toEqual({ url: B, profile: null });
    });

    it('drops to unknown when the phone has no community', () => {
        expect(anchorRead(onA, null)).toEqual({ url: null, profile: null });
    });

    it('keeps what it has, as the same object, on the same community', () => {
        expect(anchorRead(onA, A)).toBe(onA);
        expect(anchorRead(UNKNOWN_NODE_PROFILE, null)).toBe(UNKNOWN_NODE_PROFILE);
    });

    it('names the first community read, with nothing known yet', () => {
        expect(anchorRead(UNKNOWN_NODE_PROFILE, A)).toEqual({ url: A, profile: null });
    });
});

describe('profileArrived: a copy or an answer for a community landed', () => {
    it('shows a profile for the community the phone is on', () => {
        expect(profileArrived({ url: B, profile: null }, B, LOCAL)).toEqual({ url: B, profile: LOCAL });
        expect(profileArrived(onA, A, { ...GLOBAL, features: { beans: false, openJoin: false } }).profile?.features.openJoin).toBe(false);
    });

    it('never shows a late answer from the community before', () => {
        const onB: AnchoredNodeProfile = { url: B, profile: null };
        expect(profileArrived(onB, A, GLOBAL)).toBe(onB);
        const onBKnown: AnchoredNodeProfile = { url: B, profile: LOCAL };
        expect(profileArrived(onBKnown, A, GLOBAL)).toBe(onBKnown);
    });

    it('never shows an answer once the phone has no community', () => {
        expect(profileArrived(UNKNOWN_NODE_PROFILE, A, GLOBAL)).toBe(UNKNOWN_NODE_PROFILE);
    });

    it('changes nothing when there was no copy or no answer', () => {
        expect(profileArrived(onA, A, null)).toBe(onA);
        const onB: AnchoredNodeProfile = { url: B, profile: null };
        expect(profileArrived(onB, B, null)).toBe(onB);
    });
});

describe('the helper stays out of React and storage', () => {
    it('imports nothing but node-profile types', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve(__dirname, '../node-profile-anchor.ts'), 'utf-8');
        const imports = src.split('\n').filter(l => /^\s*import\b/.test(l));
        expect(imports).toEqual(["import type { NodeProfile } from './node-profile';"]);
    });
});
