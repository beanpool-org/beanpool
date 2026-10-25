import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
    hoursWording,
    readDoor,
    readJoinLock,
    doorChangeConsequence,
    unpauseConsequence,
    readKnownFloorSettings,
    readShapeKnownFloor,
    fetchCommunityShape,
    updateCommunityShape,
    getConsequenceSentence,
    type KnownFloorSettings,
    type Shape,
} from './community-shape';

describe('community-shape helpers', () => {
    describe('hoursWording', () => {
        it('formats hours correctly for 40 Beans (1 hour)', () => {
            expect(hoursWording(40)).toBe('40 Beans is about 1 hour of work the community is trusting you for.');
        });

        it('formats hours correctly for 80 Beans (2 hours)', () => {
            expect(hoursWording(80)).toBe('80 Beans is about 2 hours of work the community is trusting you for.');
        });
    });

    describe('readDoor', () => {
        it('returns valid door values', () => {
            expect(readDoor('open')).toBe('open');
            expect(readDoor('members')).toBe('members');
            expect(readDoor('admins')).toBe('admins');
        });

        it('returns null for invalid inputs', () => {
            expect(readDoor('invalid')).toBeNull();
            expect(readDoor(123)).toBeNull();
            expect(readDoor(null)).toBeNull();
            expect(readDoor(undefined)).toBeNull();
        });
    });

    describe('readJoinLock', () => {
        it('returns null for null or undefined', () => {
            expect(readJoinLock(null)).toBeNull();
            expect(readJoinLock(undefined)).toBeNull();
        });

        it('parses object with default why string if missing or empty', () => {
            expect(readJoinLock({})).toEqual({ why: 'This node takes no change to who may invite right now.' });
            expect(readJoinLock({ why: '   ' })).toEqual({ why: 'This node takes no change to who may invite right now.' });
        });

        it('parses object with custom why and optional unlock string', () => {
            expect(readJoinLock({ why: 'Custom reason' })).toEqual({ why: 'Custom reason' });
            expect(readJoinLock({ why: 'Custom reason', unlock: 'Do X to unlock' })).toEqual({
                why: 'Custom reason',
                unlock: 'Do X to unlock',
            });
        });
    });

    describe('doorChangeConsequence and unpauseConsequence', () => {
        it('returns member invite disable warning when switching from members to admins', () => {
            const sentence = doorChangeConsequence('members', 'admins');
            expect(sentence).toContain('Members will stop being able to make invites');
        });

        it('returns re-enable warning when switching from admins to members', () => {
            const sentence = doorChangeConsequence('admins', 'members');
            expect(sentence).toContain('Every member will be able to make invites');
        });

        it('returns unpause sentence for admins vs members', () => {
            expect(unpauseConsequence('admins')).toContain('only owners and admins can make invites');
            expect(unpauseConsequence('members')).toContain('every member can make invites');
        });
    });

    describe('readKnownFloorSettings & readShapeKnownFloor', () => {
        it('returns null for invalid known floor settings input', () => {
            expect(readKnownFloorSettings(null)).toBeNull();
            expect(readKnownFloorSettings({})).toBeNull();
            expect(readKnownFloorSettings({ confirmation: true, knownFloor: 'invalid', creditCap: 1000 })).toBeNull();
        });

        it('parses valid known floor settings with defaults', () => {
            const parsed = readKnownFloorSettings({ confirmation: true, knownFloor: 50, creditCap: 1000 });
            expect(parsed).toEqual({
                confirmation: true,
                knownFloor: 50,
                creditCap: 1000,
                creditCapDefault: 2000,
                creditCapMax: 5000,
            });
        });

        it('parses shape known floor setting if present', () => {
            const before: KnownFloorSettings = {
                confirmation: false,
                knownFloor: 0,
                creditCap: 0,
                creditCapDefault: 2000,
                creditCapMax: 5000,
            };
            const shape = {
                settings: {
                    knownFloor: {
                        value: {
                            on: true,
                            floor: 100,
                            cap: 3000,
                            capMax: 6000,
                        },
                    },
                },
            };
            const result = readShapeKnownFloor(shape, before);
            expect(result).toEqual({
                confirmation: true,
                knownFloor: 100,
                creditCap: 3000,
                creditCapDefault: 2000,
                creditCapMax: 6000,
            });
        });

        it('returns null if shape known floor value is missing', () => {
            const before: KnownFloorSettings = {
                confirmation: false,
                knownFloor: 0,
                creditCap: 0,
                creditCapDefault: 2000,
                creditCapMax: 5000,
            };
            expect(readShapeKnownFloor({}, before)).toBeNull();
        });
    });

    describe('API fetch & update functions', () => {
        beforeEach(() => {
            vi.stubGlobal('fetch', vi.fn());
        });

        afterEach(() => {
            vi.unstubAllGlobals();
        });

        it('fetchCommunityShape returns shape on success', async () => {
            const mockShape = { kind: 'local', standby: false, version: 1 };
            (globalThis.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: async () => mockShape,
            });

            const result = await fetchCommunityShape('https://node.example.com', 'cred123');
            expect(result).toEqual(mockShape);
            expect(globalThis.fetch).toHaveBeenCalledWith(
                expect.stringContaining('/api/local/admin/community-shape'),
                expect.objectContaining({ credentials: 'same-origin' })
            );
        });

        it('fetchCommunityShape throws on HTTP error', async () => {
            (globalThis.fetch as any).mockResolvedValueOnce({
                ok: false,
                status: 500,
                json: async () => ({ error: 'Internal failure' }),
            });

            await expect(fetchCommunityShape('https://node.example.com')).rejects.toThrow('Internal failure');
        });

        it('updateCommunityShape enforces single change constraint', async () => {
            await expect(
                updateCommunityShape('https://node.example.com', 'cred', { change1: true, change2: false })
            ).rejects.toThrow('A save writes exactly one change: never send multiple changes in one request.');
        });

        it('updateCommunityShape posts change and returns response', async () => {
            const mockResponse = { shape: { version: 2 }, told: 'members' };
            (globalThis.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: async () => mockResponse,
            });

            const res = await updateCommunityShape(
                'https://node.example.com',
                'cred',
                { knocks: true },
                'Updated knocks setting'
            );
            expect(res).toEqual(mockResponse);
            expect(globalThis.fetch).toHaveBeenCalledWith(
                expect.stringContaining('/api/local/admin/community-shape'),
                expect.objectContaining({
                    method: 'POST',
                    credentials: 'same-origin',
                    body: JSON.stringify({
                        password: 'cred',
                        changes: { knocks: true },
                        note: 'Updated knocks setting',
                    }),
                })
            );
        });

        it('updateCommunityShape attaches response metadata to thrown error on HTTP non-ok', async () => {
            (globalThis.fetch as any).mockResolvedValueOnce({
                ok: false,
                status: 400,
                json: async () => ({ error: 'Locked setting', code: 'locked', setting: 'beans', unlock: 'Unlock first' }),
            });

            try {
                await updateCommunityShape('https://node.example.com', 'cred', { beans: false });
                expect.fail('Should have thrown error');
            } catch (err: any) {
                expect(err.message).toBe('Locked setting');
                expect(err.status).toBe(400);
                expect(err.code).toBe('locked');
                expect(err.setting).toBe('beans');
                expect(err.unlock).toBe('Unlock first');
            }
        });
    });

    describe('getConsequenceSentence', () => {
        const createMockShape = (overrides?: Partial<Shape['settings']>): Shape => {
            const defaultSettings: Shape['settings'] = {
                join: { value: 'members', configured: 'members', source: 'owner', lock: null },
                openDoor: { value: false, configured: false, source: 'owner', lock: null },
                knocks: { value: true, configured: true, source: 'owner', lock: null },
                preview: { value: true, configured: true, source: 'owner', lock: null },
                beans: {
                    value: true,
                    configured: true,
                    source: 'owner',
                    lock: null,
                    includes: { escrow: true, enterprises: true, treasuries: true, crowdfund: true },
                },
                knownFloor: {
                    value: { on: true, floor: 50, cap: 1000, capMax: 5000 },
                    configured: { on: true, floor: 50, cap: 1000, capMax: 5000 },
                    source: 'owner',
                    lock: null,
                },
                decisions: { value: true, configured: true, source: 'owner', lock: null },
                listed: { value: true, configured: true, source: 'owner', lock: null },
                shareLocation: { value: true, configured: true, source: 'owner', lock: null },
                shareMemberCount: { value: true, configured: true, source: 'owner', lock: null },
                shareEmail: { value: true, configured: true, source: 'owner', lock: null },
                sharePhone: { value: true, configured: true, source: 'owner', lock: null },
                shareHealth: { value: true, configured: true, source: 'owner', lock: null },
                visitors: { value: 'open', configured: 'open', source: 'owner', lock: null },
                probation: { value: true, configured: true, source: 'owner', lock: null },
                autoHide: { value: true, configured: true, source: 'owner', lock: null },
                autoMute: { value: true, configured: true, source: 'owner', lock: null },
                connections: { value: true, configured: true, source: 'owner', lock: null },
                ...overrides,
            };
            return {
                kind: 'local',
                standby: false,
                version: 1,
                settings: defaultSettings,
                kindOnly: [],
                log: [],
            };
        };

        it('returns correct sentences for join state changes', () => {
            const shape = createMockShape();
            expect(getConsequenceSentence('join', 'admins', shape)).toContain('Members will stop being able to make invites');
            expect(getConsequenceSentence('join', 'paused', shape)).toContain('Nobody new will join until you change this');

            const pausedShape = createMockShape({
                join: { value: 'paused', configured: 'paused', source: 'owner', lock: null },
            });
            expect(getConsequenceSentence('join', 'members', pausedShape)).toContain('New members will be taken again');
        });

        it('returns correct sentences for knocks and beans', () => {
            const shape = createMockShape();
            expect(getConsequenceSentence('knocks', false, shape)).toContain('Nobody can ask to join');
            expect(getConsequenceSentence('beans', false, shape)).toContain("You can't switch Beans off once anyone has traded.");

            const openDoorShape = createMockShape({
                openDoor: { value: true, configured: true, source: 'owner', lock: null },
            });
            expect(getConsequenceSentence('beans', false, openDoorShape)).toContain('Switching Beans off is one-way');
        });

        it('returns correct sentences for knownFloor settings', () => {
            const shape = createMockShape();
            expect(getConsequenceSentence('knownFloor', { on: false }, shape)).toContain('Confirmed members go back to the credit they have earned');
            expect(getConsequenceSentence('knownFloor', { on: true, floor: 100 }, shape)).toContain('Confirmed members can owe up to 100 Beans');
        });

        it('returns empty string for unhandled settings', () => {
            const shape = createMockShape();
            expect(getConsequenceSentence('preview' as any, true, shape)).toBe('');
        });
    });
});
