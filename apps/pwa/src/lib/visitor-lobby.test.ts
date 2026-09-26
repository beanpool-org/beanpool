/**
 * A listing a visitor opened in the lobby from a shared link, kept in this tab across the join's sign-in round trip
 * (G9b follow-up, 4112421730): one key, one use, only the post's id, and nothing once it is stale.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keepLinkedPost, takeKeptLinkedPost, LINKED_POST_KEPT_MS, LINKED_POST_STORAGE_KEY } from './visitor-lobby';

const T0 = Date.UTC(2026, 8, 27, 10, 0, 0);

beforeEach(() => { sessionStorage.clear(); });
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sessionStorage.clear();
});

describe('the listing kept across a join', () => {
    it('is handed back once, and then the slot is empty', () => {
        keepLinkedPost('p-need', T0);
        expect(takeKeptLinkedPost(T0 + 5 * 60_000)).toBe('p-need');
        expect(takeKeptLinkedPost(T0 + 5 * 60_000)).toBeNull();
        expect(sessionStorage.getItem(LINKED_POST_STORAGE_KEY)).toBeNull();
    });

    it("holds the post's id and when it was kept, and nothing else", () => {
        keepLinkedPost('p-need', T0);
        expect(JSON.parse(sessionStorage.getItem(LINKED_POST_STORAGE_KEY)!)).toEqual({ id: 'p-need', at: T0 });
        // One key: a second listing replaces the first.
        keepLinkedPost('p-offer', T0 + 1);
        expect(sessionStorage.length).toBe(1);
        expect(takeKeptLinkedPost(T0 + 2)).toBe('p-offer');
    });

    it('once it is older than the time a join takes, nothing, and the slot is emptied', () => {
        keepLinkedPost('p-need', T0);
        expect(takeKeptLinkedPost(T0 + LINKED_POST_KEPT_MS + 1)).toBeNull();
        expect(sessionStorage.getItem(LINKED_POST_STORAGE_KEY)).toBeNull();
    });

    it('kept "in the future" (the clock went back): nothing', () => {
        keepLinkedPost('p-need', T0);
        expect(takeKeptLinkedPost(T0 - 60_000)).toBeNull();
    });

    it('anything in the slot that is not a post id and a time: nothing, and the slot is emptied', () => {
        for (const junk of ['not json', '"p-need"', 'null', '{"id":3,"at":0}', `{"id":"p-need","at":"${T0}"}`, `{"id":"a b","at":${T0}}`, `{"id":"${'x'.repeat(201)}","at":${T0}}`, `{"id":"","at":${T0}}`]) {
            sessionStorage.setItem(LINKED_POST_STORAGE_KEY, junk);
            expect(takeKeptLinkedPost(T0 + 1)).toBeNull();
            expect(sessionStorage.getItem(LINKED_POST_STORAGE_KEY)).toBeNull();
        }
    });

    it('never keeps something that is not a post id', () => {
        keepLinkedPost('https://elsewhere.example/?x=1', T0);
        keepLinkedPost('', T0);
        expect(sessionStorage.getItem(LINKED_POST_STORAGE_KEY)).toBeNull();
    });

    it('a browser whose storage refuses (a private window): nothing is thrown, and nothing opens', () => {
        const refuse = () => { throw new DOMException('denied', 'SecurityError'); };
        const refusing = { getItem: vi.fn(refuse), setItem: vi.fn(refuse), removeItem: vi.fn(refuse), clear: vi.fn(), key: vi.fn(), length: 0 };
        vi.stubGlobal('sessionStorage', refusing);
        expect(() => keepLinkedPost('p-need', T0)).not.toThrow();
        expect(refusing.setItem).toHaveBeenCalled();
        expect(takeKeptLinkedPost(T0 + 1)).toBeNull();
        expect(refusing.getItem).toHaveBeenCalled();
    });
});
