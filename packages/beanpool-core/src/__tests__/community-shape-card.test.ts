import { describe, it, expect } from 'vitest';
import {
    communityShapeLines,
    communityShapeSummary,
    isOldNodeWithoutShape,
    COMMUNITY_SHAPE_CARD_WORDS,
    type CommunityShapeFeatures,
} from '../community-shape-card.js';

describe('communityShapeCard (design §4, slice S5)', () => {
    describe('isOldNodeWithoutShape', () => {
        it('returns true for null, undefined, or empty object', () => {
            expect(isOldNodeWithoutShape(null)).toBe(true);
            expect(isOldNodeWithoutShape(undefined)).toBe(true);
            expect(isOldNodeWithoutShape({})).toBe(true);
        });

        it('returns true for an old node features object that says nothing about shape', () => {
            expect(isOldNodeWithoutShape({ showcase: true } as any)).toBe(true);
            expect(isOldNodeWithoutShape({ probation: true } as any)).toBe(true);
        });

        it('returns false when at least one structural setting is defined', () => {
            expect(isOldNodeWithoutShape({ beans: true })).toBe(false);
            expect(isOldNodeWithoutShape({ beans: false })).toBe(false);
            expect(isOldNodeWithoutShape({ door: 'members' })).toBe(false);
            expect(isOldNodeWithoutShape({ door: 'admins' })).toBe(false);
            expect(isOldNodeWithoutShape({ door: 'open' })).toBe(false);
            expect(isOldNodeWithoutShape({ invites: false })).toBe(false);
            expect(isOldNodeWithoutShape({ openJoin: true })).toBe(false);
            expect(isOldNodeWithoutShape({ privatePreview: true })).toBe(false);
            expect(isOldNodeWithoutShape({ knocks: true })).toBe(false);
            expect(isOldNodeWithoutShape({ decisions: true })).toBe(false);
        });
    });

    describe('communityShapeLines: every features shape', () => {
        it('an old node that says nothing produces no lines (empty array)', () => {
            expect(communityShapeLines(null)).toEqual([]);
            expect(communityShapeLines(undefined)).toEqual([]);
            expect(communityShapeLines({})).toEqual([]);
            expect(communityShapeLines({ showcase: true } as any)).toEqual([]);
        });

        it('standard local community (any member invites, knocks on, beans on, decisions on)', () => {
            const f: CommunityShapeFeatures = {
                door: 'members',
                knocks: true,
                beans: true,
                decisions: true,
            };
            expect(communityShapeLines(f)).toEqual([
                '**Joining:** any member can invite someone; people can ask to join',
                '**Beans:** on — trades, credit and the Commons',
                '**Decisions:** members vote; anyone who has completed a trade, and the admins, can propose',
            ]);
        });

        it('local community with knocks off', () => {
            const f: CommunityShapeFeatures = {
                door: 'members',
                knocks: false,
                beans: true,
                decisions: true,
            };
            expect(communityShapeLines(f)).toEqual([
                '**Joining:** any member can invite someone; nobody can ask to join',
                '**Beans:** on — trades, credit and the Commons',
                '**Decisions:** members vote; anyone who has completed a trade, and the admins, can propose',
            ]);
        });

        it('known community: only admins invite (knocks on)', () => {
            const f: CommunityShapeFeatures = {
                door: 'admins',
                knocks: true,
                beans: true,
                decisions: true,
            };
            expect(communityShapeLines(f)).toEqual([
                '**Joining:** only the admins invite people; people can ask to join',
                '**Beans:** on — trades, credit and the Commons',
                '**Decisions:** members vote; anyone who has completed a trade, and the admins, can propose',
            ]);
        });

        it('known community: only admins invite (knocks off)', () => {
            const f: CommunityShapeFeatures = {
                door: 'admins',
                knocks: false,
                beans: true,
                decisions: true,
            };
            expect(communityShapeLines(f)).toEqual([
                '**Joining:** only the admins invite people',
                '**Beans:** on — trades, credit and the Commons',
                '**Decisions:** members vote; anyone who has completed a trade, and the admins, can propose',
            ]);
        });

        it('paused community: invites off', () => {
            const f: CommunityShapeFeatures = {
                door: 'members',
                invites: false,
                knocks: false,
                beans: true,
                decisions: true,
            };
            expect(communityShapeLines(f)).toEqual([
                '**Joining:** paused — no new members for now',
                '**Beans:** on — trades, credit and the Commons',
                '**Decisions:** members vote; anyone who has completed a trade, and the admins, can propose',
            ]);
        });

        it('open door (global community): with 12 words and sign-in', () => {
            const f: CommunityShapeFeatures = {
                door: 'open',
                wordsDoor: true,
                beans: false,
                decisions: false,
                dmRequests: true,
                probation: true,
                autoHideReports: true,
                autoMute: true,
            };
            expect(communityShapeLines(f)).toEqual([
                '**Joining:** anyone, with 12 words or a sign-in',
                '**Beans:** off — no prices, no credit here',
                '**Messages:** a first message from someone new waits until you accept it',
                '**Decisions:** off — the moderators look after this community',
                '**New accounts:** limits for their first days',
                '**Reported posts** are hidden until a moderator looks',
                '**Repeat offenders** are muted automatically',
            ]);
        });

        it('open door with sign-in only (wordsDoor false)', () => {
            const f: CommunityShapeFeatures = {
                openJoin: true,
                wordsDoor: false,
                beans: false,
                decisions: false,
            };
            expect(communityShapeLines(f)).toEqual([
                '**Joining:** anyone, with a sign-in',
                '**Beans:** off — no prices, no credit here',
                '**Decisions:** off — the moderators look after this community',
            ]);
        });

        it('open door from a node that says nothing of wordsDoor: the sign-in alone, never 12 words', () => {
            for (const f of [{ door: 'open' }, { openJoin: true }] as CommunityShapeFeatures[]) {
                const joining = communityShapeLines(f)[0];
                expect(joining).toBe('**Joining:** anyone, with a sign-in');
                expect(joining).not.toContain('12 words');
            }
        });

        it('open door without explicit decisions defaults decisions off', () => {
            const f: CommunityShapeFeatures = {
                door: 'open',
                beans: false,
            };
            expect(communityShapeLines(f)).toContain('**Decisions:** off — the moderators look after this community');
        });

        it('private preview on', () => {
            const f: CommunityShapeFeatures = {
                door: 'members',
                privatePreview: true,
                beans: true,
                decisions: true,
            };
            expect(communityShapeLines(f)).toContain('**Private preview:** only people the owner or an admin invites get in; visitors see nothing');
        });

        it('confirmed members known floor', () => {
            const f: CommunityShapeFeatures = {
                door: 'members',
                beans: true,
                decisions: true,
                knownFloor: 1000,
            };
            expect(communityShapeLines(f)).toContain('**Confirmed members** can owe up to 1,000 Beans (the known floor)');
        });

        it('confirmed members custom known floor formatted with commas', () => {
            const f: CommunityShapeFeatures = {
                door: 'members',
                beans: true,
                decisions: true,
                knownFloor: 1500,
            };
            expect(communityShapeLines(f)).toContain('**Confirmed members** can owe up to 1,500 Beans (the known floor)');
        });

        it('dmRequests off: messages arrive straight away', () => {
            const f: CommunityShapeFeatures = {
                door: 'members',
                beans: true,
                decisions: true,
                dmRequests: false,
            };
            expect(communityShapeLines(f)).toContain('**Messages:** arrive straight away');
        });
    });

    describe('communityShapeSummary (Home card one-line)', () => {
        it('an old node that says nothing returns null (no line drawn on Home)', () => {
            expect(communityShapeSummary(null)).toBeNull();
            expect(communityShapeSummary(undefined)).toBeNull();
            expect(communityShapeSummary({})).toBeNull();
        });

        it('standard local community', () => {
            const f: CommunityShapeFeatures = {
                door: 'members',
                knocks: true,
                beans: true,
                decisions: true,
            };
            expect(communityShapeSummary(f)).toBe('How it works: any member invites · Beans on · votes on · requests to join on');
        });

        it('known community with knocks off', () => {
            const f: CommunityShapeFeatures = {
                door: 'admins',
                knocks: false,
                beans: true,
                decisions: true,
            };
            expect(communityShapeSummary(f)).toBe('How it works: only admins invite · Beans on · votes on · requests to join off');
        });

        it('paused community', () => {
            const f: CommunityShapeFeatures = {
                door: 'members',
                invites: false,
                knocks: false,
                beans: true,
                decisions: true,
            };
            expect(communityShapeSummary(f)).toBe('How it works: paused · Beans on · votes on · requests to join off');
        });

        it('global community (open door, beans off, decisions off, knocks off)', () => {
            const f: CommunityShapeFeatures = {
                door: 'open',
                knocks: false,
                beans: false,
                decisions: false,
            };
            expect(communityShapeSummary(f)).toBe('How it works: anyone joins · Beans off · votes off · requests to join off');
        });

        it('open door community without explicit decisions defaults votes to votes off', () => {
            const f: CommunityShapeFeatures = {
                door: 'open',
                knocks: false,
                beans: false,
            };
            expect(communityShapeSummary(f)).toBe('How it works: anyone joins · Beans off · votes off · requests to join off');
        });
    });
});
