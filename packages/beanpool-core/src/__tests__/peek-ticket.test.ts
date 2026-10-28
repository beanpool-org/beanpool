import { describe, it, expect } from 'vitest';
import { PEEK_TICKET_DAYS, isPeekTicket, isPeekPostId, peekFromLink, peekLink, readPeekShares } from '../peek-ticket';

const T = 'AbCdEfGhIjKlMnOpQrSt_-';

describe('the peek ticket: its shape', () => {
    it('is 22 base64url characters, nothing else', () => {
        expect(T).toHaveLength(22);
        expect(isPeekTicket(T)).toBe(true);
        for (const bad of ['', T.slice(1), `${T}A`, `${T.slice(0, 21)}=`, `${T.slice(0, 21)}+`, `${T.slice(0, 21)}/`, ` ${T.slice(1)}`, null, 42, {}]) {
            expect(isPeekTicket(bad)).toBe(false);
        }
    });

    it('lasts seven days (design §3.4)', () => {
        expect(PEEK_TICKET_DAYS).toBe(7);
    });

    it('a post id is a UUID or a sample id, never a path, a query or a space', () => {
        expect(isPeekPostId('3f0c8a8e-1b2c-4d5e-8f90-123456789abc')).toBe(true);
        expect(isPeekPostId('sample-offer-1')).toBe(true);
        for (const bad of ['', 'a/b', 'a?b', 'a&peek=x', 'a b', '../x', 'x'.repeat(101)]) expect(isPeekPostId(bad)).toBe(false);
    });
});

describe('the link a member shares outside', () => {
    it('is the community\'s own address with ?post= and &peek=', () => {
        expect(peekLink('https://mullum.beanpool.org', 'p-1', T)).toBe(`https://mullum.beanpool.org/?post=p-1&peek=${T}`);
        expect(peekLink('https://commons.example.net//', 'p-1', T)).toBe(`https://commons.example.net/?post=p-1&peek=${T}`);
    });

    it('reads back the post and the ticket, in either order, and nothing that lacks either', () => {
        expect(peekFromLink(peekLink('https://a.example', 'p-1', T))).toEqual({ postId: 'p-1', ticket: T });
        expect(peekFromLink(`https://a.example/?peek=${T}&post=p-1`)).toEqual({ postId: 'p-1', ticket: T });
        expect(peekFromLink(`beanpool://peek?node=https%3A%2F%2Fa.example&post=p-1&peek=${T}#x`)).toEqual({ postId: 'p-1', ticket: T });
        expect(peekFromLink('https://a.example/?post=p-1')).toBeNull();
        expect(peekFromLink(`https://a.example/?peek=${T}`)).toBeNull();
        expect(peekFromLink(`https://a.example/?post=p-1&peek=short`)).toBeNull();
        expect(peekFromLink(`https://a.example/?post=a%2Fb&peek=${T}`)).toBeNull();
        expect(peekFromLink(null)).toBeNull();
    });

    it('a link that names the post or the ticket twice is no peek', () => {
        expect(peekFromLink(`https://a.example/?post=p-1&post=p-2&peek=${T}`)).toBeNull();
        expect(peekFromLink(`https://a.example/?post=p-1&peek=${T}&peek=${T}`)).toBeNull();
    });
});

describe('the member\'s open links, as the apps read the node\'s list', () => {
    it('keeps each well-formed row and drops the rest', () => {
        const rows = readPeekShares({
            shares: [
                { id: 'r1', postId: 'p-1', title: '  Ladder to lend ', createdAt: '2026-10-29T00:00:00Z', expiresAt: '2026-11-05T00:00:00Z', ticket: T },
                { id: 'r2', postId: 'p-2', title: null, createdAt: '2026-10-29T00:00:00Z', expiresAt: '2026-11-05T00:00:00Z' },
                { id: 'r3', postId: 'a/b', title: 'x', createdAt: 'c', expiresAt: 'e' },
                { postId: 'p-4', createdAt: 'c', expiresAt: 'e' },
                'nope',
            ],
        });
        expect(rows).toEqual([
            { id: 'r1', postId: 'p-1', title: 'Ladder to lend', createdAt: '2026-10-29T00:00:00Z', expiresAt: '2026-11-05T00:00:00Z' },
            { id: 'r2', postId: 'p-2', title: null, createdAt: '2026-10-29T00:00:00Z', expiresAt: '2026-11-05T00:00:00Z' },
        ]);
        expect(readPeekShares(null)).toEqual([]);
        expect(readPeekShares({ shares: 'x' })).toEqual([]);
    });
});
