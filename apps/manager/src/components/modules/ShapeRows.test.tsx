import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
    ShapeRow,
    RowControls,
    joinDisplay,
    joinRadioTitle,
    joinRadioDescription,
    visitorsDisplay,
} from './ShapeRows';
import type { ShapeLock, JoinState } from '../../lib/community-shape';

describe('ShapeRows helper functions', () => {
    describe('joinDisplay', () => {
        it('returns human-readable text for join states', () => {
            expect(joinDisplay('members')).toBe('Any member invites');
            expect(joinDisplay('admins')).toBe('Only admins invite');
            expect(joinDisplay('paused')).toBe('Paused');
            expect(joinDisplay('open')).toBe('Open');
            expect(joinDisplay('custom' as unknown as JoinState)).toBe('custom');
        });
    });

    describe('joinRadioTitle and joinRadioDescription', () => {
        it('returns titles for join options', () => {
            expect(joinRadioTitle('members')).toBe('Invite: any member invites');
            expect(joinRadioTitle('admins')).toBe('Known: only admins invite');
            expect(joinRadioTitle('paused')).toBe('Paused: nobody new for now');
        });

        it('returns descriptions for join options', () => {
            expect(joinRadioDescription('members')).toContain('Any member can make an invite');
            expect(joinRadioDescription('admins')).toContain('Only owners and admins can make invites');
            expect(joinRadioDescription('paused')).toContain('Nobody new can join');
        });
    });

    describe('visitorsDisplay', () => {
        it('returns readable label for visitor settings', () => {
            expect(visitorsDisplay('nothing')).toBe('See nothing');
            expect(visitorsDisplay('listings')).toBe('Listings only');
            expect(visitorsDisplay('open')).toBe('Open');
            expect(visitorsDisplay('unknown' as any)).toBe('unknown');
        });
    });
});

describe('ShapeRow component', () => {
    it('renders as a clickable button when user is owner and row is unlocked', () => {
        const onToggle = vi.fn();
        render(
            <ShapeRow
                id="join"
                icon="🚪"
                name="Who can join"
                summary="Invite is how every community starts"
                extraLine="Pausing stops new invites"
                displayValue="Any member invites"
                isOwner={true}
                isOpen={false}
                onToggle={onToggle}
            >
                <div>Children details</div>
            </ShapeRow>
        );

        expect(screen.getByText('Who can join')).toBeInTheDocument();
        expect(screen.getByText('Invite is how every community starts')).toBeInTheDocument();
        expect(screen.getByText('Pausing stops new invites')).toBeInTheDocument();
        expect(screen.getByTestId('shape-val-join')).toHaveTextContent('Any member invites');

        const button = screen.getByRole('button');
        expect(button).toBeInTheDocument();
        expect(button).toHaveAttribute('aria-expanded', 'false');
        expect(screen.getByText('›')).toBeInTheDocument();

        fireEvent.click(button);
        expect(onToggle).toHaveBeenCalledTimes(1);

        // Children should not be visible when isOpen is false
        expect(screen.queryByText('Children details')).not.toBeInTheDocument();
    });

    it('renders expanded content and open indicator when isOpen is true', () => {
        render(
            <ShapeRow
                id="join"
                icon="🚪"
                name="Who can join"
                summary="Summary text"
                displayValue="Any member invites"
                isOwner={true}
                isOpen={true}
                onToggle={vi.fn()}
            >
                <div data-testid="expanded-slot">Expanded Content</div>
            </ShapeRow>
        );

        const button = screen.getByRole('button');
        expect(button).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByText('▲')).toBeInTheDocument();
        expect(screen.getByTestId('expanded-slot')).toHaveTextContent('Expanded Content');
    });

    it('renders as non-expandable div when user is not owner', () => {
        render(
            <ShapeRow
                id="join"
                icon="🚪"
                name="Who can join"
                summary="Summary text"
                displayValue="Any member invites"
                isOwner={false}
                isOpen={false}
                onToggle={vi.fn()}
            />
        );

        expect(screen.queryByRole('button')).not.toBeInTheDocument();
        expect(screen.queryByText('›')).not.toBeInTheDocument();
    });

    it('renders serverBadge and prevents expansion even for owner', () => {
        render(
            <ShapeRow
                id="join"
                icon="🚪"
                name="Who can join"
                summary="Summary text"
                displayValue="Any member invites"
                serverBadge="Global"
                isOwner={true}
                isOpen={false}
                onToggle={vi.fn()}
            />
        );

        expect(screen.getByText('Global')).toBeInTheDocument();
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('renders locked state and prevents expansion by default', () => {
        const lock: ShapeLock = {
            code: 'server_env',
            why: 'Controlled by server policy',
            unlock: 'To unlock, edit config file',
        };

        render(
            <ShapeRow
                id="join"
                icon="🚪"
                name="Who can join"
                summary="Summary text"
                displayValue="Any member invites"
                lock={lock}
                isOwner={true}
                isOpen={false}
                onToggle={vi.fn()}
            />
        );

        expect(screen.queryByRole('button')).not.toBeInTheDocument();
        const lockStatus = screen.getByTestId('shape-lock-join');
        expect(lockStatus).toHaveTextContent('Controlled by server policy');
        expect(lockStatus).toHaveTextContent('To unlock, edit config file');
        expect(lockStatus.className).toContain('bg-nature-900/60');
    });

    it('styles auth_hatch_open lock with danger tint', () => {
        const lock: ShapeLock = {
            code: 'auth_hatch_open',
            why: 'Hatch is open',
        };

        render(
            <ShapeRow
                id="join"
                icon="🚪"
                name="Who can join"
                summary="Summary text"
                displayValue="Any member invites"
                lock={lock}
                isOwner={true}
                isOpen={false}
                onToggle={vi.fn()}
            />
        );

        const lockStatus = screen.getByTestId('shape-lock-join');
        expect(lockStatus.className).toContain('bg-bp-chip-danger-tint');
    });

    it('allows expansion when locked if allowExpandWithLock is true', () => {
        const lock: ShapeLock = {
            code: 'beans_off',
            why: 'Locked core setting',
        };

        render(
            <ShapeRow
                id="beans"
                icon="🫘"
                name="Beans"
                summary="Summary text"
                displayValue="On"
                lock={lock}
                allowExpandWithLock={true}
                isOwner={true}
                isOpen={false}
                onToggle={vi.fn()}
                coreLockLine="Core locked line"
                coreAction={<button type="button">Unlock</button>}
            />
        );

        expect(screen.getByRole('button', { name: /Beans/ })).toBeInTheDocument();
        expect(screen.getByTestId('shape-core-lock-beans')).toHaveTextContent('Core locked line');
        expect(screen.getByRole('button', { name: 'Unlock' })).toBeInTheDocument();
    });
});

describe('RowControls component', () => {
    it('handles note change, save, and cancel actions', () => {
        const onSave = vi.fn();
        const onCancel = vi.fn();
        const onNoteChange = vi.fn();

        render(
            <RowControls
                onSave={onSave}
                onCancel={onCancel}
                note="Initial note"
                onNoteChange={onNoteChange}
                saving={false}
                consequence="Changing this affects all members"
            />
        );

        expect(screen.getByTestId('shape-consequence')).toHaveTextContent('Changing this affects all members');

        const noteInput = screen.getByPlaceholderText('Optional note to members (e.g. why this changed)');
        expect(noteInput).toHaveValue('Initial note');
        fireEvent.change(noteInput, { target: { value: 'Updated note' } });
        expect(onNoteChange).toHaveBeenCalledWith('Updated note');

        const saveButton = screen.getByRole('button', { name: 'Save' });
        expect(saveButton).not.toBeDisabled();
        fireEvent.click(saveButton);
        expect(onSave).toHaveBeenCalledTimes(1);

        const cancelButton = screen.getByRole('button', { name: 'Cancel' });
        fireEvent.click(cancelButton);
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('disables save button when typedWord does not match, and enables when matched', () => {
        const onTypedChange = vi.fn();

        const { rerender } = render(
            <RowControls
                onSave={vi.fn()}
                onCancel={vi.fn()}
                note=""
                onNoteChange={vi.fn()}
                saving={false}
                typedWord="disable"
                typed="dis"
                onTypedChange={onTypedChange}
            />
        );

        const typedInput = screen.getByTestId('shape-typed-word');
        expect(typedInput).toHaveValue('dis');

        const saveBtn = screen.getByRole('button', { name: 'Save' });
        expect(saveBtn).toBeDisabled();

        fireEvent.change(typedInput, { target: { value: 'disable' } });
        expect(onTypedChange).toHaveBeenCalledWith('disable');

        // Rerender with matched typed text
        rerender(
            <RowControls
                onSave={vi.fn()}
                onCancel={vi.fn()}
                note=""
                onNoteChange={vi.fn()}
                saving={false}
                typedWord="disable"
                typed="disable"
                onTypedChange={onTypedChange}
            />
        );

        expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
    });

    it('shows error alert and saving state', () => {
        render(
            <RowControls
                onSave={vi.fn()}
                onCancel={vi.fn()}
                note=""
                onNoteChange={vi.fn()}
                saving={true}
                error="Could not save setting"
                below={<div data-testid="below-slot">Fresh proof box</div>}
            />
        );

        expect(screen.getByRole('alert')).toHaveTextContent('Could not save setting');
        const saveButton = screen.getByRole('button', { name: 'Saving...' });
        expect(saveButton).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
        expect(screen.getByTestId('below-slot')).toBeInTheDocument();
    });
});
