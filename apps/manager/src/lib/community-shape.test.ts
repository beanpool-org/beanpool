import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    Shape,
    ShapeSettings,
    KnownFloorSettings,
    isCoreSetting,
    coreLocked,
    coreAwaitsOwner,
    recoveryCopiesName,
    removalDeciderName,
    readRecoveryCopies,
    confirmCoreSettings,
    adviseOwners,
    saveCommunityPlace,
} from './community-shape';

describe('community-shape lib', () => {
    describe('hoursWording', () => {
        it('formats 40 beans as 1 hour', () => {
            expect(hoursWording(40)).toBe('40 Beans is about 1 hour of work the community is trusting you for.');
        });

        it('formats 80 beans as 2 hours', () => {
            expect(hoursWording(80)).toBe('80 Beans is about 2 hours of work the community is trusting you for.');
        });
    });

    describe('readDoor', () => {
        it('returns valid door values', () => {
            expect(readDoor('open')).toBe('open');
            expect(readDoor('members')).toBe('members');
            expect(readDoor('admins')).toBe('admins');
        });

        it('returns null for invalid values', () => {
            expect(readDoor('closed')).toBeNull();
            expect(readDoor(null)).toBeNull();
            expect(readDoor(123)).toBeNull();
        });
    });

    describe('readJoinLock', () => {
        it('returns null for null or undefined', () => {
            expect(readJoinLock(null)).toBeNull();
            expect(readJoinLock(undefined)).toBeNull();
        });

        it('parses valid object with why and unlock', () => {
            expect(readJoinLock({ why: 'Server lock', unlock: 'admin_only' })).toEqual({
                why: 'Server lock',
                unlock: 'admin_only',
            });
        });

        it('uses fallback why message when why is empty or non-string', () => {
            expect(readJoinLock({})).toEqual({
                why: 'This node takes no change to who may invite right now.',
            });
            expect(readJoinLock({ why: '   ' })).toEqual({
                why: 'This node takes no change to who may invite right now.',
            });
        });
    });

    describe('doorChangeConsequence & unpauseConsequence', () => {
        it('returns consequence message for members to admins', () => {
            const msg = doorChangeConsequence('members', 'admins');
            expect(msg).toContain('Members will stop being able to make invites');
        });

        it('returns consequence message for admins to members', () => {
            const msg = doorChangeConsequence('admins', 'members');
            expect(msg).toContain('Every member will be able to make invites');
        });

        it('returns unpause message for admins', () => {
            const msg = unpauseConsequence('admins');
            expect(msg).toContain('only owners and admins can make invites');
        });

        it('returns unpause message for members', () => {
            const msg = unpauseConsequence('members');
            expect(msg).toContain('every member can make invites');
        });
    });

    describe('core helper functions', () => {
        it('isCoreSetting checks whether key is in CORE_SETTINGS', () => {
            expect(isCoreSetting('join')).toBe(true);
            expect(isCoreSetting('wordsDoor')).toBe(true);
            expect(isCoreSetting('beans')).toBe(true);
            expect(isCoreSetting('knownFloor')).toBe(true);
            expect(isCoreSetting('memberGift')).toBe(true);
            expect(isCoreSetting('decisions')).toBe(true);
            expect(isCoreSetting('shareOutside')).toBe(true);
            expect(isCoreSetting('recoveryCopies')).toBe(true);
            expect(isCoreSetting('openDoor')).toBe(false);
            expect(isCoreSetting('knocks')).toBe(false);
            expect(isCoreSetting('randomKey')).toBe(false);
        });

        it('coreLocked returns true if core lock is set, false otherwise', () => {
            expect(coreLocked(null)).toBe(false);
            expect(coreLocked(undefined)).toBe(false);
            expect(coreLocked({} as any)).toBe(false);
            expect(coreLocked({ core: { settings: [], lock: null } } as any)).toBe(false);
            expect(coreLocked({ core: { settings: [], lock: { at: '2026-10-01', by: 'pk', byCallsign: 'alice' } } } as any)).toBe(true);
        });

        it('coreAwaitsOwner checks if owner needs to confirm unlocked core settings', () => {
            const baseShape: any = {
                standby: false,
                core: { settings: [], lock: null },
            };

            // Owner on unlocked non-standby with core
            expect(coreAwaitsOwner(baseShape, true)).toBe(true);

            // Admin (not owner)
            expect(coreAwaitsOwner(baseShape, false)).toBe(false);

            // Shape missing
            expect(coreAwaitsOwner(null, true)).toBe(false);
            expect(coreAwaitsOwner(undefined, true)).toBe(false);

            // Standby node
            expect(coreAwaitsOwner({ ...baseShape, standby: true }, true)).toBe(false);

            // Node without core block (older node)
            expect(coreAwaitsOwner({ standby: false } as any, true)).toBe(false);

            // Already locked core
            expect(coreAwaitsOwner({ ...baseShape, core: { settings: [], lock: { at: '2026-10-01', by: 'pk', byCallsign: 'alice' } } }, true)).toBe(false);
        });
    });

    describe('recovery copies and removal decider helpers', () => {
        it('recoveryCopiesName returns human-readable label or fallback', () => {
            expect(recoveryCopiesName('vault')).toBe("BeanPool's key vault");
            expect(recoveryCopiesName('server')).toBe('This server');
            expect(recoveryCopiesName('none')).toBe('Nowhere');
            expect(recoveryCopiesName('custom')).toBe('custom');
        });

        it('removalDeciderName returns human-readable label or fallback', () => {
            expect(removalDeciderName('automatic')).toBe('Automatic');
            expect(removalDeciderName('everyone')).toBe('Everyone');
            expect(removalDeciderName('jury')).toBe('A jury');
            expect(removalDeciderName('other')).toBe('other');
        });

        it('readRecoveryCopies parses valid RecoveryCopies value or null', () => {
            expect(readRecoveryCopies('vault')).toBe('vault');
            expect(readRecoveryCopies('server')).toBe('server');
            expect(readRecoveryCopies('none')).toBe('none');
            expect(readRecoveryCopies('unknown')).toBeNull();
            expect(readRecoveryCopies(null)).toBeNull();
            expect(readRecoveryCopies(undefined)).toBeNull();
            expect(readRecoveryCopies(123)).toBeNull();
        });
    });

    describe('readKnownFloorSettings & readShapeKnownFloor', () => {
        it('parses valid KnownFloorSettings with defaults', () => {
            const result = readKnownFloorSettings({
                confirmation: true,
                knownFloor: 100,
                creditCap: 500,
            });
            expect(result).toEqual({
                confirmation: true,
                knownFloor: 100,
                creditCap: 500,
                creditCapDefault: 2000,
                creditCapMax: 5000,
            });
        });

        it('returns null for invalid inputs', () => {
            expect(readKnownFloorSettings(null)).toBeNull();
            expect(readKnownFloorSettings({ confirmation: 'yes' })).toBeNull();
            expect(readKnownFloorSettings({ confirmation: true, knownFloor: 1.5, creditCap: 500 })).toBeNull();
        });

        it('reads shape known floor from shape object', () => {
            const before: KnownFloorSettings = {
                confirmation: false,
                knownFloor: 0,
                creditCap: 1000,
                creditCapDefault: 2000,
                creditCapMax: 5000,
            };
            const shape = {
                settings: {
                    knownFloor: {
                        value: {
                            on: true,
                            floor: 200,
                            cap: 1000,
                            capMax: 6000,
                        },
                    },
                },
            };
            const result = readShapeKnownFloor(shape, before);
            expect(result).toEqual({
                confirmation: true,
                knownFloor: 200,
                creditCap: 1000,
                creditCapDefault: 2000,
                creditCapMax: 6000,
            });
        });
    });

    describe('fetchCommunityShape & updateCommunityShape', () => {
        const originalFetch = globalThis.fetch;

        afterEach(() => {
            globalThis.fetch = originalFetch;
        });

        it('fetchCommunityShape returns json on success', async () => {
            const mockShape = { kind: 'local', version: 1 };
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => mockShape,
            } as Response);

            const res = await fetchCommunityShape('http://localhost:8080', 'secret_pass');
            expect(res).toEqual(mockShape);
            expect(globalThis.fetch).toHaveBeenCalledWith(
                '/proxy/http/localhost:8080/api/local/admin/community-shape',
                expect.objectContaining({ credentials: 'same-origin' })
            );
        });

        it('fetchCommunityShape throws error on failure', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 403,
                json: async () => ({ error: 'Unauthorized' }),
            } as Response);

            await expect(fetchCommunityShape('http://localhost:8080')).rejects.toThrow('Unauthorized');
        });

        it('updateCommunityShape rejects multiple changes', async () => {
            await expect(
                updateCommunityShape('http://localhost:8080', 'pass', { a: 1, b: 2 })
            ).rejects.toThrow('A save writes exactly one change: never send multiple changes in one request.');
        });

        it('updateCommunityShape posts single change and returns body', async () => {
            const mockRes = { shape: { kind: 'local' }, told: 'members' };
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => mockRes,
            } as Response);

            const res = await updateCommunityShape('http://localhost:8080', 'pass', { openDoor: true }, 'a note');
            expect(res).toEqual(mockRes);
            expect(globalThis.fetch).toHaveBeenCalledWith(
                '/proxy/http/localhost:8080/api/local/admin/community-shape',
                expect.objectContaining({
                    method: 'POST',
                    body: JSON.stringify({
                        password: 'pass',
                        changes: { openDoor: true },
                        note: 'a note',
                    }),
                })
            );
        });

        it('updateCommunityShape attaches status and error details on failure', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 400,
                json: async () => ({ error: 'Invalid value', code: 'INVALID', setting: 'openDoor' }),
            } as Response);

            try {
                await updateCommunityShape('http://localhost:8080', 'pass', { openDoor: false });
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err.message).toBe('Invalid value');
                expect(err.status).toBe(400);
                expect(err.code).toBe('INVALID');
                expect(err.setting).toBe('openDoor');
            }
        });

        it('confirmCoreSettings posts lock change and returns body', async () => {
            const mockRes = { shape: { kind: 'local' }, told: 'members' };
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => mockRes,
            } as Response);

            const res = await confirmCoreSettings('http://localhost:8080', 'pass', { beans: false }, 'tfa_token');
            expect(res).toEqual(mockRes);
            expect(globalThis.fetch).toHaveBeenCalledWith(
                '/proxy/http/localhost:8080/api/local/admin/community-shape',
                expect.objectContaining({
                    method: 'POST',
                    body: JSON.stringify({
                        password: 'pass',
                        changes: { beans: false },
                        lock: true,
                    }),
                    headers: expect.objectContaining({
                        'X-Admin-2FA-Session': 'tfa_token',
                    }),
                })
            );
        });

        it('confirmCoreSettings throws shapeError on failure', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 409,
                json: async () => ({ error: 'Core already locked', code: 'core_locked' }),
            } as Response);

            try {
                await confirmCoreSettings('http://localhost:8080', 'pass', {});
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err.message).toBe('Core already locked');
                expect(err.status).toBe(409);
                expect(err.code).toBe('core_locked');
            }
        });

        it('adviseOwners posts advice note and returns body', async () => {
            const mockRes = { shape: { kind: 'local' }, told: 'owners' };
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => mockRes,
            } as Response);

            const res = await adviseOwners('http://localhost:8080', 'pass', 'beans', ' Keep beans on! ');
            expect(res).toEqual(mockRes);
            expect(globalThis.fetch).toHaveBeenCalledWith(
                '/proxy/http/localhost:8080/api/local/admin/community-shape/advice',
                expect.objectContaining({
                    method: 'POST',
                    body: JSON.stringify({
                        password: 'pass',
                        setting: 'beans',
                        advice: 'Keep beans on!',
                    }),
                })
            );
        });

        it('adviseOwners throws shapeError on failure', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 400,
                json: async () => ({ error: 'Advice too long', code: 'advice_too_long' }),
            } as Response);

            await expect(adviseOwners('http://localhost:8080', 'pass', 'beans', 'Too long')).rejects.toThrow('Advice too long');
        });

        it('saveCommunityPlace posts service radius coordinates', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ ok: true }),
            } as Response);

            await saveCommunityPlace('http://localhost:8080', 'pass', { lat: 51.5, lng: -0.1 });
            expect(globalThis.fetch).toHaveBeenCalledWith(
                '/proxy/http/localhost:8080/api/local/admin/node/config',
                expect.objectContaining({
                    method: 'POST',
                    body: JSON.stringify({
                        password: 'pass',
                        serviceRadius: { lat: 51.5, lng: -0.1, radiusKm: 0 },
                    }),
                })
            );
        });

        it('saveCommunityPlace throws shapeError on failure', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 500,
                json: async () => ({ error: 'Failed to save config' }),
            } as Response);

            await expect(saveCommunityPlace('http://localhost:8080', 'pass', { lat: 51.5, lng: -0.1 })).rejects.toThrow('Failed to save config');
        });
    });

    describe('getConsequenceSentence', () => {
        const createMockShape = (settingsPartial: Partial<ShapeSettings>): Shape => {
            const defaultSetting = <T>(val: T): any => ({
                value: val,
                configured: val,
                source: 'default',
                lock: null,
            });

            return {
                kind: 'local',
                standby: false,
                version: 1,
                kindOnly: [],
                log: [],
                settings: {
                    join: defaultSetting('members'),
                    openDoor: defaultSetting(false),
                    knocks: defaultSetting(true),
                    preview: defaultSetting(false),
                    beans: { ...defaultSetting(true), includes: { escrow: true, enterprises: true, treasuries: true, crowdfund: true } },
                    knownFloor: { ...defaultSetting({ on: true, floor: 500, cap: 2000, capMax: 5000 }) },
                    decisions: defaultSetting(true),
                    listed: defaultSetting(true),
                    shareLocation: defaultSetting(true),
                    shareMemberCount: defaultSetting(true),
                    shareEmail: defaultSetting(false),
                    sharePhone: defaultSetting(false),
                    shareHealth: defaultSetting(true),
                    visitors: defaultSetting('listings'),
                    probation: defaultSetting(true),
                    autoHide: defaultSetting(true),
                    autoMute: defaultSetting(true),
                    connections: defaultSetting(true),
                    ...settingsPartial,
                } as ShapeSettings,
            };
        };

        it('handles join settings', () => {
            const shapePaused = createMockShape({ join: { value: 'paused', configured: 'paused', source: 'owner', lock: null } });
            expect(getConsequenceSentence('join', 'members', shapePaused)).toContain('New members will be taken again');

            const shapeMembers = createMockShape({ join: { value: 'members', configured: 'members', source: 'owner', lock: null } });
            expect(getConsequenceSentence('join', 'admins', shapeMembers)).toContain('Members will stop being able to make invites');
            expect(getConsequenceSentence('join', 'paused', shapeMembers)).toContain('Nobody new will join until you change this');
        });

        it('handles knocks setting', () => {
            const shape = createMockShape({});
            expect(getConsequenceSentence('knocks', false, shape)).toContain('Nobody can ask to join');
            expect(getConsequenceSentence('knocks', true, shape)).toContain('People who find this community can ask to join');
        });

        it('handles beans setting with and without open door', () => {
            const shapeOpenDoor = createMockShape({ openDoor: { value: true, configured: true, source: 'owner', lock: null } });
            expect(getConsequenceSentence('beans', false, shapeOpenDoor)).toContain('Switching Beans off is one-way');

            const shapeClosedDoor = createMockShape({ openDoor: { value: false, configured: false, source: 'owner', lock: null } });
            expect(getConsequenceSentence('beans', false, shapeClosedDoor)).toContain("You can't switch Beans off once anyone has traded.");

            expect(getConsequenceSentence('beans', true, shapeClosedDoor)).toContain('Members get a credit line');
        });

        it('handles knownFloor setting', () => {
            const shape = createMockShape({});
            expect(getConsequenceSentence('knownFloor', { on: false }, shape)).toContain('Confirmed members go back to the credit they have earned');
            expect(getConsequenceSentence('knownFloor', { on: true, floor: 300 }, shape)).toContain('Confirmed members can owe up to 300 Beans');
        });

        it('handles boolean toggle settings', () => {
            const shape = createMockShape({});
            expect(getConsequenceSentence('dmRequests', true, shape)).toContain("A member's first message");
            expect(getConsequenceSentence('decisions', false, shape)).toContain('Nothing can be proposed or voted on');
            expect(getConsequenceSentence('listed', false, shape)).toContain('comes off the directory and the map on beanpool.org at once');
            expect(getConsequenceSentence('shareLocation', true, shape)).toContain('Anyone will be able to see roughly where');
            expect(getConsequenceSentence('shareMemberCount', false, shape)).toContain('The directory will no longer show');
            expect(getConsequenceSentence('shareEmail', true, shape)).toContain('Your contact email will be listed');
            expect(getConsequenceSentence('sharePhone', true, shape)).toContain('Your contact phone will be listed');
            expect(getConsequenceSentence('shareHealth', false, shape)).toContain('Node health and version diagnostics will no longer be shared');
            expect(getConsequenceSentence('probation', false, shape)).toContain('New members will have no daily limits');
            expect(getConsequenceSentence('autoHide', true, shape)).toContain('Reports from three independent groups');
            expect(getConsequenceSentence('autoMute', true, shape)).toContain('Three posts removed in 30 days');
            expect(getConsequenceSentence('wordsDoor', true, shape)).toContain('People will be able to join with 12 secret words');
        });
    });
});
