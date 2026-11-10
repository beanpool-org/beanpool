import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Shape, ShapeSettings } from '../../lib/community-shape';
import type { NodeProfile } from '../../lib/profiles';
import {
    CoreWalkthrough,
    currentDoor,
    draftFrom,
    knownFloorLock,
    changesFrom,
    knownFloorProblem,
} from './CoreWalkthrough';
import * as communityShapeLib from '../../lib/community-shape';

vi.mock('@beanpool/core', async (orig) => {
    const real = await orig<typeof import('@beanpool/core')>();
    return {
        ...real,
        createAddressLookup: (opts: { onState: (s: unknown) => void }) => ({
            input: () => opts.onState({
                status: 'done',
                results: [{ displayName: 'Mullumbimby NSW, Australia', lat: -28.55, lng: 153.5 }],
            }),
            dispose: () => {},
        }),
    };
});

const NODE: NodeProfile = {
    id: 'node-test-1',
    name: 'Test Node',
    url: 'https://node.example.org',
    adminPassword: 'secret-admin-pass',
};

function makeShape(over: { core?: Shape['core']; settings?: Partial<ShapeSettings>; kind?: 'local' | 'global' } = {}): Shape {
    const settings = {
        join: { value: 'members', configured: 'members', source: 'default', lock: null, door: 'members' as const },
        openDoor: { value: false, configured: false, source: 'default', lock: null },
        knocks: { value: true, configured: true, source: 'default', lock: null },
        preview: { value: false, configured: false, source: 'server', lock: null },
        beans: { value: true, configured: true, source: 'default', lock: null, includes: { escrow: true, enterprises: true, treasuries: true, crowdfund: true } },
        // The shape reads the known floor in whole hundredths of a Bean (config/community-shape.ts): 100000 is 1,000 Beans.
        knownFloor: { value: { on: true, floor: 100000, cap: 200000, capMax: 500000 }, configured: { on: true, floor: 100000, cap: 200000, capMax: 500000 }, source: 'default', lock: null },
        decisions: { value: true, configured: true, source: 'default', lock: null },
        shareOutside: { value: true, configured: true, source: 'default', lock: null },
        recoveryCopies: { value: 'vault' as const, configured: 'vault' as const, source: 'default', lock: null },
        listed: { value: true, configured: true, source: 'default', lock: null },
        shareLocation: { value: true, configured: true, source: 'default', lock: null },
        shareMemberCount: { value: true, configured: true, source: 'default', lock: null },
        shareEmail: { value: false, configured: false, source: 'default', lock: null },
        sharePhone: { value: false, configured: false, source: 'default', lock: null },
        shareHealth: { value: true, configured: true, source: 'default', lock: null },
        probation: { value: { on: false, days: 0 }, configured: { on: false, days: 0 }, source: 'default', lock: null },
        autoHide: { value: true, configured: true, source: 'default', lock: null },
        autoMute: { value: true, configured: true, source: 'default', lock: null },
        removalDecider: { value: 'admins' as const, configured: 'admins' as const, source: 'default', lock: null },
        ...over.settings,
    } as unknown as ShapeSettings;

    return {
        kind: over.kind ?? 'local',
        standby: false,
        version: 1,
        kindOnly: [],
        settings,
        ...(over.core === null ? {} : { core: over.core ?? {
            settings: ['join', 'beans', 'knownFloor', 'decisions', 'shareOutside', 'recoveryCopies'],
            lock: null,
            place: { needed: false, set: true },
        } }),
        log: [],
    };
}

describe('CoreWalkthrough helper functions', () => {
    describe('currentDoor', () => {
        it('returns stored j.door when present', () => {
            const shape = makeShape();
            expect(currentDoor(shape)).toBe('members');
            shape.settings.join.door = 'admins';
            expect(currentDoor(shape)).toBe('admins');
        });

        it('falls back to value when door is not set', () => {
            const shape = makeShape();
            delete (shape.settings.join as any).door;
            shape.settings.join.value = 'admins' as any;
            expect(currentDoor(shape)).toBe('admins');

            shape.settings.join.value = 'paused' as any;
            shape.settings.join.configured = 'admins';
            expect(currentDoor(shape)).toBe('admins');

            shape.settings.join.configured = 'members';
            expect(currentDoor(shape)).toBe('members');
        });
    });

    describe('draftFrom', () => {
        it('extracts draft settings correctly from shape', () => {
            const shape = makeShape();
            const draft = draftFrom(shape);
            expect(draft).toEqual({
                join: 'members',
                wordsDoor: undefined,
                beans: true,
                // The boxes hold the figures as typed Beans text.
                knownFloor: { on: true, floor: '1000', cap: '2000' },
                decisions: true,
                shareOutside: true,
                recoveryCopies: 'vault',
            });
        });
    });

    describe('knownFloorLock', () => {
        it('returns null if there is no knownFloor lock', () => {
            const shape = makeShape();
            const draft = draftFrom(shape);
            expect(knownFloorLock(shape, draft)).toBeNull();
        });

        it('returns lock when lock code is not beans_off', () => {
            const shape = makeShape();
            shape.settings.knownFloor.lock = { code: 'ledger_moved', why: 'Ledger moved' };
            const draft = draftFrom(shape);
            expect(knownFloorLock(shape, draft)).toEqual({ code: 'ledger_moved', why: 'Ledger moved' });
        });

        it('bypasses beans_off lock when draft has beans turned on', () => {
            const shape = makeShape();
            shape.settings.knownFloor.lock = { code: 'beans_off', why: 'Beans off' };
            const draft = draftFrom(shape);
            draft.beans = true;
            expect(knownFloorLock(shape, draft)).toBeNull();

            draft.beans = false;
            expect(knownFloorLock(shape, draft)).toEqual({ code: 'beans_off', why: 'Beans off' });
        });
    });

    describe('changesFrom', () => {
        it('returns empty object when no settings changed', () => {
            const shape = makeShape();
            const draft = draftFrom(shape);
            expect(changesFrom(shape, draft)).toEqual({});
        });

        it('returns only modified settings', () => {
            const shape = makeShape();
            const draft = draftFrom(shape);
            draft.join = 'admins';
            draft.beans = false;
            draft.decisions = false;

            expect(changesFrom(shape, draft)).toEqual({
                join: 'admins',
                beans: false,
                decisions: false,
            });
        });

        it('does not include settings held by server locks', () => {
            const shape = makeShape();
            shape.settings.join.lock = { code: 'server_env', why: 'Locked by server' };
            const draft = draftFrom(shape);
            draft.join = 'admins';

            expect(changesFrom(shape, draft)).toEqual({});
        });

        it('detects knownFloor changes when beans are on and unlocked, and sends them as the node takes them', () => {
            const shape = makeShape();
            const draft = draftFrom(shape);
            draft.knownFloor = { on: true, floor: '1500', cap: '2500.50' };

            // `{ on, floor_c, cap_c }`, whole hundredths (config/community-shape-write.ts), never the old floor/cap keys.
            expect(changesFrom(shape, draft)).toEqual({
                knownFloor: { on: true, floor_c: 150000, cap_c: 250050 },
            });
        });

        it('sends no knownFloor change when the typed figures are what the shape has', () => {
            const shape = makeShape();
            const draft = draftFrom(shape);
            draft.knownFloor = { on: true, floor: '1000.00', cap: '2000' };
            expect(changesFrom(shape, draft)).toEqual({});
        });
    });

    describe('knownFloorProblem', () => {
        it('returns null when floor is off', () => {
            expect(knownFloorProblem({ on: false, floor: '9999', cap: '100' })).toBeNull();
        });

        it('validates floor not exceeding cap', () => {
            expect(knownFloorProblem({ on: true, floor: '3000', cap: '2500' })).toBe("The known floor can't be more than the cap.");
            // To the hundredth: 2,500.01 is more than a cap of 2,500.
            expect(knownFloorProblem({ on: true, floor: '2500.01', cap: '2500' })).toBe("The known floor can't be more than the cap.");
        });

        it('validates floor is not negative', () => {
            expect(knownFloorProblem({ on: true, floor: '-10', cap: '2500' })).toBe("The known floor can't be negative.");
        });

        it('validates cap bounds (2,000 to 5,000)', () => {
            expect(knownFloorProblem({ on: true, floor: '500', cap: '1500' })).toBe('The cap must be between 2,000 and 5,000 Beans.');
            expect(knownFloorProblem({ on: true, floor: '500', cap: '6000' })).toBe('The cap must be between 2,000 and 5,000 Beans.');
            expect(knownFloorProblem({ on: true, floor: '500', cap: '1999.99' })).toBe('The cap must be between 2,000 and 5,000 Beans.');
        });

        it('refuses typed figures that are not Beans to the cent, in words', () => {
            expect(knownFloorProblem({ on: true, floor: '1000.505', cap: '3000' })).toBe('Type at most 2 decimals, like 12.5.');
            expect(knownFloorProblem({ on: true, floor: '1000', cap: '' })).toBe('Type an amount.');
        });

        it('returns null for valid configuration', () => {
            expect(knownFloorProblem({ on: true, floor: '1000', cap: '3000' })).toBeNull();
            expect(knownFloorProblem({ on: true, floor: '999.50', cap: '2000' })).toBeNull();
        });
    });
});

describe('CoreWalkthrough Component', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('renders intro step, progress, and navigates through steps with Next / Back', () => {
        const shape = makeShape();
        const onLeave = vi.fn();
        const onLocked = vi.fn();

        render(
            <CoreWalkthrough
                activeNode={NODE}
                shape={shape}
                onLeave={onLeave}
                onLocked={onLocked}
            />
        );

        expect(screen.getByTestId('core-walkthrough')).toHaveAttribute('data-step', 'intro');
        expect(screen.getByTestId('walk-progress')).toHaveTextContent(/Step 1 of/);
        expect(screen.getByRole('heading', { level: 4, name: 'Core settings' })).toBeInTheDocument();

        // Next to join step
        fireEvent.click(screen.getByTestId('walk-next'));
        expect(screen.getByTestId('core-walkthrough')).toHaveAttribute('data-step', 'join');
        expect(screen.getByRole('heading', { level: 4, name: 'Who can join' })).toBeInTheDocument();

        // Back to intro
        fireEvent.click(screen.getByRole('button', { name: 'Back' }));
        expect(screen.getByTestId('core-walkthrough')).toHaveAttribute('data-step', 'intro');

        // Leave for now
        fireEvent.click(screen.getByTestId('walk-leave'));
        expect(onLeave).toHaveBeenCalledTimes(1);
    });

    it('blocks Next when place is needed but not selected, and proceeds once place chosen', () => {
        const shape = makeShape({ core: { settings: ['join'], lock: null, place: { needed: true, set: false } } });
        render(
            <CoreWalkthrough
                activeNode={NODE}
                shape={shape}
                onLeave={vi.fn()}
                onLocked={vi.fn()}
            />
        );

        // Intro -> Place
        fireEvent.click(screen.getByTestId('walk-next'));
        expect(screen.getByTestId('core-walkthrough')).toHaveAttribute('data-step', 'place');
        const nextBtn = screen.getByTestId('walk-next');
        expect(nextBtn).toBeDisabled();

        // Type location query
        const searchInput = screen.getByTestId('walk-place-search');
        fireEvent.change(searchInput, { target: { value: 'Mullumbimby' } });

        // Click search result
        const resultBtn = screen.getByTestId('walk-place-result');
        fireEvent.click(resultBtn);

        expect(screen.getByTestId('walk-place-chosen')).toHaveTextContent('Mullumbimby NSW, Australia');
        expect(nextBtn).not.toBeDisabled();
    });

    it('displays error message and disables Next when knownFloor has invalid bounds', () => {
        const shape = makeShape();
        render(
            <CoreWalkthrough
                activeNode={NODE}
                shape={shape}
                onLeave={vi.fn()}
                onLocked={vi.fn()}
            />
        );

        // Step through to beans step, then to knownFloor
        fireEvent.click(screen.getByTestId('walk-next')); // join
        fireEvent.click(screen.getByTestId('walk-next')); // beans
        fireEvent.click(screen.getByTestId('walk-next')); // knownFloor

        expect(screen.getByTestId('core-walkthrough')).toHaveAttribute('data-step', 'knownFloor');

        const floorInput = screen.getByLabelText(/Known floor \(Beans\)/);
        fireEvent.change(floorInput, { target: { value: '6000' } });

        expect(screen.getByRole('alert')).toHaveTextContent("The known floor can't be more than the cap.");
        expect(screen.getByTestId('walk-next')).toBeDisabled();
    });

    it('supports direct startAt="review" and Walk through them jump back to intro', () => {
        const shape = makeShape();
        render(
            <CoreWalkthrough
                activeNode={NODE}
                shape={shape}
                startAt="review"
                onLeave={vi.fn()}
                onLocked={vi.fn()}
            />
        );

        expect(screen.getByTestId('core-walkthrough')).toHaveAttribute('data-step', 'review');
        expect(screen.getByRole('heading', { level: 4, name: 'Review, then confirm' })).toBeInTheDocument();

        // Jump back to intro
        const walkThroughBtn = screen.getByTestId('walk-through-them');
        fireEvent.click(walkThroughBtn);
        expect(screen.getByTestId('core-walkthrough')).toHaveAttribute('data-step', 'intro');
    });

    it('confirms and locks settings upon clicking Confirm and lock', async () => {
        const shape = makeShape();
        const onLocked = vi.fn();
        const updatedShape = { ...shape, core: { ...shape.core!, lock: { at: '2026-11-08T00:00:00.000Z', by: 'test', byCallsign: 'admin' } } };

        vi.spyOn(communityShapeLib, 'confirmCoreSettings').mockResolvedValueOnce({
            shape: updatedShape,
            told: 'nobody',
        });

        render(
            <CoreWalkthrough
                activeNode={NODE}
                shape={shape}
                startAt="review"
                onLeave={vi.fn()}
                onLocked={onLocked}
            />
        );

        const confirmBtn = screen.getByTestId('walk-confirm');
        expect(confirmBtn).toBeEnabled();
        fireEvent.click(confirmBtn);

        await waitFor(() => {
            expect(communityShapeLib.confirmCoreSettings).toHaveBeenCalledWith(
                NODE.url,
                'secret-admin-pass',
                {},
                undefined
            );
            expect(onLocked).toHaveBeenCalledWith(updatedShape, 'nobody');
        });
    });

    it('displays error alert when confirmCoreSettings fails', async () => {
        const shape = makeShape();
        const onLocked = vi.fn();
        vi.spyOn(communityShapeLib, 'confirmCoreSettings').mockRejectedValueOnce(
            new Error('Server error while saving core settings')
        );

        render(
            <CoreWalkthrough
                activeNode={NODE}
                shape={shape}
                startAt="review"
                onLeave={vi.fn()}
                onLocked={onLocked}
            />
        );

        fireEvent.click(screen.getByTestId('walk-confirm'));

        await waitFor(() => {
            expect(screen.getByTestId('walk-error')).toHaveTextContent('Server error while saving core settings');
        });
    });

    it('falls back to default error message when thrown error has empty message or is non-Error', async () => {
        const shape = makeShape();
        const onLocked = vi.fn();
        vi.spyOn(communityShapeLib, 'confirmCoreSettings').mockRejectedValueOnce(
            new Error('')
        );

        render(
            <CoreWalkthrough
                activeNode={NODE}
                shape={shape}
                startAt="review"
                onLeave={vi.fn()}
                onLocked={onLocked}
            />
        );

        fireEvent.click(screen.getByTestId('walk-confirm'));

        await waitFor(() => {
            expect(screen.getByTestId('walk-error')).toHaveTextContent('Could not confirm. Nothing was locked.');
        });
    });
});
