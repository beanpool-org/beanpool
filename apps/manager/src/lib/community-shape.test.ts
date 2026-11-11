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
    knownFloorChange,
    knownFloorDraftOf,
    knownFloorUnchanged,
    Shape,
    ShapeSettings,
    KnownFloorSettings,
} from './community-shape';

/** An owner automation token (bp_ + 12 hex + _ + 64 hex): what a request carries, as a bearer. */
const TOKEN = 'bp_' + 'a'.repeat(12) + '_' + 'b'.repeat(64);

describe('community-shape lib', () => {
    describe('hoursWording', () => {
        // Whole hundredths of a Bean: 4000 is 40 Beans, an hour of work (PROTOCOL_CONSTANTS.REFERENCE_RATE).
        it('formats 40 beans as 1 hour', () => {
            expect(hoursWording(4000)).toBe('40 Beans is about 1 hour of work the community is trusting you for.');
        });

        it('formats 80 beans as 2 hours', () => {
            expect(hoursWording(8000)).toBe('80 Beans is about 2 hours of work the community is trusting you for.');
        });

        it('says a figure to the cent as hundredths', () => {
            expect(hoursWording(4925)).toBe('49.25 Beans is about 1 hour of work the community is trusting you for.');
        });
    });

    describe('the known floor draft', () => {
        it('starts its boxes from the shape\'s hundredths, and sends the typed Beans as { on, floor_c, cap_c }', () => {
            const draft = knownFloorDraftOf({ on: true, floor: 100000, cap: 250050 });
            expect(draft).toEqual({ on: true, floor: '1000', cap: '2500.50' });
            expect(knownFloorChange(draft)).toEqual({ on: true, floor_c: 100000, cap_c: 250050 });
            expect(knownFloorChange({ on: true, floor: '999.99', cap: '2000' })).toEqual({ on: true, floor_c: 99999, cap_c: 200000 });
        });

        it('sends nothing while the dial is on and a typed figure is not Beans to the cent; with the dial off, only the dial', () => {
            expect(knownFloorChange({ on: true, floor: '12.505', cap: '2000' })).toBeNull();
            expect(knownFloorChange({ on: true, floor: '1,000', cap: '2000' })).toBeNull();
            expect(knownFloorChange({ on: false, floor: '', cap: '2000' })).toEqual({ on: false });
        });

        it('knows when a change changes nothing', () => {
            const now = { on: true, floor: 100000, cap: 200000 };
            expect(knownFloorUnchanged({ on: true, floor_c: 100000, cap_c: 200000 }, now)).toBe(true);
            expect(knownFloorUnchanged({ on: true, floor_c: 100001, cap_c: 200000 }, now)).toBe(false);
            expect(knownFloorUnchanged({ on: false }, now)).toBe(false);
            expect(knownFloorUnchanged(null, now)).toBe(false);
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

    describe('readKnownFloorSettings & readShapeKnownFloor', () => {
        // As GET /api/local/admin/known-floor sends them (config/known-floor.ts knownFloorSettings): `*_c`, whole hundredths;
        // the defaults are core's, in hundredths too (CREDIT_CAP_DEFAULT 200000, CREDIT_CAP_MAX 500000).
        it('parses valid KnownFloorSettings with defaults', () => {
            const result = readKnownFloorSettings({
                confirmation: true,
                knownFloor_c: 10000,
                creditCap_c: 50000,
            });
            expect(result).toEqual({
                confirmation: true,
                knownFloor_c: 10000,
                creditCap_c: 50000,
                creditCapDefault_c: 200000,
                creditCapMax_c: 500000,
            });
        });

        it('returns null for invalid inputs', () => {
            expect(readKnownFloorSettings(null)).toBeNull();
            expect(readKnownFloorSettings({ confirmation: 'yes' })).toBeNull();
            expect(readKnownFloorSettings({ confirmation: true, knownFloor_c: 1.5, creditCap_c: 500 })).toBeNull();
            // The old names are no answer.
            expect(readKnownFloorSettings({ confirmation: true, knownFloor: 100, creditCap: 500 })).toBeNull();
        });

        it('reads shape known floor from shape object', () => {
            const before: KnownFloorSettings = {
                confirmation: false,
                knownFloor_c: 0,
                creditCap_c: 100000,
                creditCapDefault_c: 200000,
                creditCapMax_c: 500000,
            };
            // The shape keeps the old names, in whole hundredths (config/community-shape.ts readShape).
            const shape = {
                settings: {
                    knownFloor: {
                        value: {
                            on: true,
                            floor: 20000,
                            cap: 100000,
                            capMax: 600000,
                        },
                    },
                },
            };
            const result = readShapeKnownFloor(shape, before);
            expect(result).toEqual({
                confirmation: true,
                knownFloor_c: 20000,
                creditCap_c: 100000,
                creditCapDefault_c: 200000,
                creditCapMax_c: 600000,
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

            const res = await fetchCommunityShape('http://localhost:8080', TOKEN);
            expect(res).toEqual(mockShape);
            expect(globalThis.fetch).toHaveBeenCalledWith(
                '/proxy/http/localhost:8080/api/local/admin/community-shape',
                expect.objectContaining({
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
                })
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
                updateCommunityShape('http://localhost:8080', TOKEN, { a: 1, b: 2 })
            ).rejects.toThrow('A save writes exactly one change: never send multiple changes in one request.');
        });

        it('updateCommunityShape posts single change and returns body', async () => {
            const mockRes = { shape: { kind: 'local' }, told: 'members' };
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => mockRes,
            } as Response);

            const res = await updateCommunityShape('http://localhost:8080', TOKEN, { openDoor: true }, 'a note');
            expect(res).toEqual(mockRes);
            // The bearer is the credential; no password rides in the body.
            expect(globalThis.fetch).toHaveBeenCalledWith(
                '/proxy/http/localhost:8080/api/local/admin/community-shape',
                expect.objectContaining({
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
                    body: JSON.stringify({
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
                await updateCommunityShape('http://localhost:8080', TOKEN, { openDoor: false });
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err.message).toBe('Invalid value');
                expect(err.status).toBe(400);
                expect(err.code).toBe('INVALID');
                expect(err.setting).toBe('openDoor');
            }
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
                    knownFloor: { ...defaultSetting({ on: true, floor: 50000, cap: 200000, capMax: 500000 }) },
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
            // The draft as typed (Beans text); a floor that isn't Beans to the cent reads the floor the shape has (500).
            expect(getConsequenceSentence('knownFloor', { on: true, floor: '300', cap: '2000' }, shape)).toContain('Confirmed members can owe up to 300 Beans');
            expect(getConsequenceSentence('knownFloor', { on: true, floor: '299.50', cap: '2000' }, shape)).toContain('Confirmed members can owe up to 299.50 Beans');
            expect(getConsequenceSentence('knownFloor', { on: true, floor: 'abc', cap: '2000' }, shape)).toContain('Confirmed members can owe up to 500 Beans');
        });

        it('handles the voucher budget and the members\' gift in whole hundredths', () => {
            const shape = createMockShape({});
            expect(getConsequenceSentence('voucherBudget', 150000, shape)).toContain('New vouchers start with a budget of 1,500 Beans');
            expect(getConsequenceSentence('voucherBudget', null, shape)).toBe('');
            expect(getConsequenceSentence('memberGift', 0, shape)).toContain('Members can no longer give part of their credit line');
            expect(getConsequenceSentence('memberGift', 2500, shape)).toContain('A member can give another up to 25 Beans');
            expect(getConsequenceSentence('memberGift', 25.5, shape)).toBe('');
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
