import { describe, it, expect, vi } from 'vitest';
import type { SyntheticEvent } from 'react';
import { GATED_FOCUS, GATED_LOOK, gatedProps, guardGated } from './gated-control';

const event = () => ({ preventDefault: vi.fn() }) as unknown as SyntheticEvent & { preventDefault: ReturnType<typeof vi.fn> };

describe('gatedProps', () => {
    it('says nothing when the viewer is allowed to use the control', () => {
        expect(gatedProps(false, 'why')).toEqual({});
    });

    it('marks a blocked control unavailable and points at its reason', () => {
        expect(gatedProps(true, 'why')).toEqual({ 'aria-disabled': true, 'aria-describedby': 'why' });
    });

    it('points at every reason that applies at once', () => {
        expect(gatedProps(true, 'one two')['aria-describedby']).toBe('one two');
    });

    it('leaves aria-describedby off rather than pointing at nothing', () => {
        expect(gatedProps(true, '   ')).toEqual({ 'aria-disabled': true });
    });
});

describe('guardGated', () => {
    it('runs the handler when the control is not blocked', () => {
        const run = vi.fn();
        const e = event();
        guardGated(false, run)(e);
        expect(run).toHaveBeenCalledTimes(1);
        expect(e.preventDefault).not.toHaveBeenCalled();
    });

    it('does nothing at all when the control is blocked', () => {
        const run = vi.fn();
        const e = event();
        guardGated(true, run)(e);
        expect(run).not.toHaveBeenCalled();
        expect(e.preventDefault).toHaveBeenCalledTimes(1);
    });

    it('blocks with no handler, for a radio that must not tick', () => {
        const e = event();
        expect(() => guardGated(true)(e)).not.toThrow();
        expect(e.preventDefault).toHaveBeenCalledTimes(1);
    });
});

describe('the gated look', () => {
    it('keeps a focus ring, because a gated control is still focusable', () => {
        expect(GATED_FOCUS).toMatch(/focus-visible:outline/);
        expect(GATED_LOOK).toContain(GATED_FOCUS);
    });

    it('dims the control without taking it out of reach', () => {
        expect(GATED_LOOK).toMatch(/opacity-50/);
        expect(GATED_LOOK).not.toMatch(/pointer-events-none/);
    });
});
