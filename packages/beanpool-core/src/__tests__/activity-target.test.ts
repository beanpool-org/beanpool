import { describe, it, expect } from 'vitest';
import { activityTarget } from '../activity-target.js';

describe('activityTarget — where a Community Pulse row opens', () => {
    it('a member joining opens their profile', () => {
        expect(activityTarget({ eventType: 'member_joined', actorPubkey: 'pk-bob' })).toEqual({ kind: 'profile', pubkey: 'pk-bob' });
    });
    it('a joined row with no key opens nothing', () => {
        expect(activityTarget({ eventType: 'member_joined' })).toBeNull();
    });
    it('a post opens that post, numeric ids as text', () => {
        expect(activityTarget({ eventType: 'post_created', actorPubkey: 'a', metadata: { postId: 'p1' } })).toEqual({ kind: 'post', postId: 'p1' });
        expect(activityTarget({ eventType: 'post_created', metadata: { postId: 7 } })).toEqual({ kind: 'post', postId: '7' });
    });
    it('a post with no id opens nothing', () => {
        expect(activityTarget({ eventType: 'post_created', actorPubkey: 'a', metadata: { title: 'x' } })).toBeNull();
        expect(activityTarget({ eventType: 'post_created', actorPubkey: 'a', metadata: { postId: '' } })).toBeNull();
    });
    it('a trade or rating opens its listing, else the other member, else the actor', () => {
        for (const eventType of ['trade_completed', 'rating_given']) {
            expect(activityTarget({ eventType, actorPubkey: 'a', targetPubkey: 't', metadata: { postId: 'p' } })).toEqual({ kind: 'post', postId: 'p' });
            expect(activityTarget({ eventType, actorPubkey: 'a', targetPubkey: 't' })).toEqual({ kind: 'profile', pubkey: 't' });
            expect(activityTarget({ eventType, actorPubkey: 'a' })).toEqual({ kind: 'profile', pubkey: 'a' });
            expect(activityTarget({ eventType })).toBeNull();
        }
    });
    it('a resolved dispute and an unknown event open nothing', () => {
        expect(activityTarget({ eventType: 'dispute_resolved', actorPubkey: 'admin' })).toBeNull();
        expect(activityTarget({ eventType: 'something_new', actorPubkey: 'a' })).toBeNull();
    });
});
