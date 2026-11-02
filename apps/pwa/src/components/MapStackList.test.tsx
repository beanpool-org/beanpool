import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MapStackList } from './MapStackList';
import type { StackPin } from '../lib/map-stack';

describe('MapStackList', () => {
    const pin: StackPin = {
        key: 'p1',
        title: 'Working bee',
        type: 'Event',
        when: 'Sat 7 Nov · 9:00–12:00',
        photo: null,
        emoji: '📌',
        eventStartMs: Date.parse('2026-11-07T09:00:00.000Z'),
        createdMs: Date.parse('2026-11-01T00:00:00.000Z'),
        open: vi.fn(),
    };

    it('uses the custom heading prop when provided', () => {
        render(<MapStackList pins={[pin]} covered={false} takeFocus={false} onClose={vi.fn()} heading="Sat 7 Nov: 1 event" />);
        expect(screen.getByRole('heading', { name: 'Sat 7 Nov: 1 event' })).toBeInTheDocument();
    });

    it('falls back to default stackHeading when heading prop is omitted', () => {
        render(<MapStackList pins={[pin]} covered={false} takeFocus={false} onClose={vi.fn()} />);
        expect(screen.getByRole('heading', { name: '1 at this spot' })).toBeInTheDocument();
    });
});
