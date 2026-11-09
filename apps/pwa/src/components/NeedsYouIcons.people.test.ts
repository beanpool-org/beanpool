/**
 * The Needs-you line "N people asked to join" lands on People → Invites and says a notice brought the member there, so that
 * if every request has been answered by the time they arrive the page says so instead of showing nothing (9 Nov, an owner of
 * Byron; see WantsToJoin.test.tsx). The line "N asked for an invite" lands on the same page, but is about another list, and a
 * sentence about requests to join in front of it would mislead. Every other line lands as it did. HomePage.test.tsx holds
 * Home's own copy of the same lines.
 */
import { describe, expect, it, vi } from 'vitest';
import { goToWebNeedsTarget } from './NeedsYouIcons';

describe('where the "people" icons land', () => {
    it('"N people asked to join": People → Invites, as a notice\'s visit', () => {
        const onNavigate = vi.fn();
        goToWebNeedsTarget({ to: 'people' }, onNavigate, 'knock');
        expect(onNavigate).toHaveBeenCalledOnce();
        expect(onNavigate).toHaveBeenCalledWith('people-invites', 'asked');
    });

    it('"N asked for an invite": People → Invites, an ordinary visit (it is not about requests to join)', () => {
        const onNavigate = vi.fn();
        goToWebNeedsTarget({ to: 'people' }, onNavigate, 'ask');
        expect(onNavigate).toHaveBeenCalledOnce();
        expect(onNavigate).toHaveBeenCalledWith('people-invites');
    });

    it('a line whose kind is not known: an ordinary visit', () => {
        const onNavigate = vi.fn();
        goToWebNeedsTarget({ to: 'people' }, onNavigate);
        expect(onNavigate).toHaveBeenCalledWith('people-invites');
    });

    it('another line is not a notice\'s visit: the deals list lands on the Market and nothing more', () => {
        const onNavigate = vi.fn();
        goToWebNeedsTarget({ to: 'my-deals' }, onNavigate, 'deal');
        expect(onNavigate).toHaveBeenCalledWith('marketplace');
    });
});
