import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChangesLog } from './ChangesLog';
import type { ShapeLogLine } from '../../lib/community-shape';

describe('ChangesLog', () => {
    it('renders empty message when lines is empty', () => {
        render(<ChangesLog lines={[]} />);
        expect(screen.getByText('No changes recorded yet.')).toBeInTheDocument();
        expect(screen.queryByTestId('shape-audit-log')).not.toBeInTheDocument();
    });

    it('renders audit log entries with formatted dates, actors, and values', () => {
        const lines: ShapeLogLine[] = [
            {
                id: '1',
                kept: 'community_settings_log',
                at: '2026-05-10T14:30:00.000Z',
                actor: 'owner:password',
                actorCallsign: null,
                actorRole: null,
                setting: 'join',
                from: 'members',
                to: 'admins',
                note: null,
            },
            {
                id: '2',
                kept: 'community_settings_log',
                at: '2026-05-11T09:15:00.000Z',
                actor: 'pubkey1234567890abcdef',
                actorCallsign: 'alice',
                actorRole: 'moderator',
                setting: 'beans',
                from: 'off',
                to: 'on',
                note: 'Turned on beans for testing',
            },
        ];

        render(<ChangesLog lines={lines} />);

        const container = screen.getByTestId('shape-audit-log');
        expect(container).toBeInTheDocument();

        // Check first entry
        expect(screen.getByText('the owner (old admin password)')).toBeInTheDocument();
        expect(screen.getByText('Who can join')).toBeInTheDocument();
        expect(screen.getByText(': Any member invites → Only admins invite')).toBeInTheDocument();

        // Check second entry
        expect(screen.getByText('@alice')).toBeInTheDocument();
        expect(screen.getByText('(moderator)')).toBeInTheDocument();
        expect(screen.getByText('Beans')).toBeInTheDocument();
        expect(screen.getByText(': Off → On')).toBeInTheDocument();
        expect(screen.getByText(/“Turned on beans for testing”/)).toBeInTheDocument();
    });

    it('renders core setting log entries with special coreWords', () => {
        const lines: ShapeLogLine[] = [
            {
                id: '3',
                kept: 'community_settings_log',
                at: '2026-05-12T10:00:00.000Z',
                actor: 'abcdef1234567890',
                actorCallsign: null,
                actorRole: null,
                setting: 'core.lock',
                from: null,
                to: null,
                note: null,
            },
            {
                id: '4',
                kept: 'community_settings_log',
                at: '2026-05-13T12:00:00.000Z',
                actor: 'abcdef1234567890',
                actorCallsign: null,
                actorRole: null,
                setting: 'core.unlock',
                from: null,
                to: 'beans',
                note: null,
            },
            {
                id: '5',
                kept: 'community_settings_log',
                at: '2026-05-14T15:00:00.000Z',
                actor: 'abcdef1234567890',
                actorCallsign: null,
                actorRole: null,
                setting: 'advice.beans',
                from: null,
                to: null,
                note: 'Please consider reopening beans',
            },
        ];

        render(<ChangesLog lines={lines} />);

        expect(screen.getByText('🔒 Core settings confirmed and locked')).toBeInTheDocument();
        expect(screen.getByText('🔓 Unlocked Beans')).toBeInTheDocument();
        expect(screen.getByText('💬 Advised the owners about Beans')).toBeInTheDocument();
        expect(screen.getByText(/“Please consider reopening beans”/)).toBeInTheDocument();

        // Actor shortened key check: abcdef1234567890 (> 12 chars) -> abcdef12…
        expect(screen.getAllByText('abcdef12…')).toHaveLength(3);
    });

    it('respects the limit prop', () => {
        const lines: ShapeLogLine[] = [1, 2, 3, 4, 5].map((idx) => ({
            id: String(idx),
            kept: 'community_settings_log',
            at: '2026-05-10T14:30:00.000Z',
            actor: 'owner:password',
            actorCallsign: null,
            actorRole: null,
            setting: 'join',
            from: 'members',
            to: 'admins',
            note: `Note #${idx}`,
        }));

        render(<ChangesLog lines={lines} limit={2} />);

        expect(screen.getByText(/“Note #1”/)).toBeInTheDocument();
        expect(screen.getByText(/“Note #2”/)).toBeInTheDocument();
        expect(screen.queryByText(/“Note #3”/)).not.toBeInTheDocument();
    });
});
