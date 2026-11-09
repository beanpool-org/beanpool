/**
 * "Invited by", Brought in and the Ledger's credit line: one set of words for both apps (invited-by.ts, vouch-presets.ts;
 * DESIGN-invites-vouching-review-fable.md slice I3).
 */
import { describe, expect, it } from 'vitest';
import { invitedByLines, broughtInWords, broughtInStatusWords, broughtInRowWords, showInviterSwitchWords, ledgerCreditLine } from '../index.js';

const member = (role: 'owner' | 'admin' | null) => ({ kind: 'member' as const, publicKey: 'b'.repeat(64), callsign: 'marty', avatarUrl: null, tier: 'Elder', role });
const words = (l: { title: string; sub: string | null }) => `${l.title} ${l.sub ?? ''}`;

describe('invitedByLines', () => {
    it('names an owner and an admin with their role word, a plain member with none', () => {
        expect(invitedByLines(member('owner'), false).title).toBe('🌱 Invited by marty · owner');
        expect(invitedByLines(member('admin'), false).title).toBe('🌱 Invited by marty · admin');
        expect(invitedByLines(member(null), false).title).toBe('🌱 Invited by marty');
        expect(invitedByLines({ ...member(null), role: undefined }, false).title).toBe('🌱 Invited by marty');
    });
    it('on your own profile: "You were invited by"', () => {
        expect(invitedByLines(member('owner'), true).title).toBe('🌱 You were invited by marty · owner');
        expect(invitedByLines(member(null), true).title).toBe('🌱 You were invited by marty');
    });
    it('the tier line only when the app gives its tier words', () => {
        expect(invitedByLines(member(null), false).sub).toBeNull();
        expect(invitedByLines(member(null), false, (t) => `<${t}>`).sub).toBe('<Elder> tier · tap to reach out');
    });
    it('a password card and the founder name nobody, and the old sentences are gone for every kind', () => {
        const card = invitedByLines({ kind: 'card', publicKey: null, callsign: null, avatarUrl: null, tier: null, role: null }, false);
        expect(card.title).toBe('Invited with an owner’s invite card');
        const founder = invitedByLines({ kind: 'founder', publicKey: null, callsign: null, avatarUrl: null, tier: null, role: null }, false);
        expect(founder.title).toBe('Founding member');
        for (const l of [card, founder, invitedByLines(member('owner'), false), invitedByLines(member('admin'), true)]) {
            expect(words(l)).not.toContain('Invited directly by the system admin');
            expect(words(l)).not.toContain('Vetted by the admin at sign-up');
        }
    });
});

describe('Brought in, the switch, the Ledger line', () => {
    it('counts people', () => {
        expect(broughtInWords(1)).toBe('Brought in 1 person ›');
        expect(broughtInWords(3)).toBe('Brought in 3 people ›');
        expect(broughtInStatusWords('active')).toBe('Still here');
        expect(broughtInStatusWords('pruned')).toBe('No longer a member');
        expect(broughtInRowWords('2026-10-01T00:00:00.000Z', 'active')).toMatch(/^Joined .*2026 · still here$/);
        expect(broughtInRowWords('2026-10-01T00:00:00.000Z', 'pruned')).toMatch(/^Joined .*2026 · no longer a member$/);
        expect(broughtInRowWords(null, 'active')).toBe('Still here');
    });
    it('the switch says who always sees it', () => {
        expect(showInviterSwitchWords()).toEqual({
            label: 'Show who invited me to other members',
            hint: 'Owners, admins and the person who invited you always see it.',
        });
    });
    it('the Ledger names the voucher and the amount', () => {
        expect(ledgerCreditLine('marty', 200)).toBe('Your credit line: 200, vouched by @marty');
    });
});
