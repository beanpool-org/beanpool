import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConsentText } from './ConsentText';

describe('ConsentText', () => {
    it('renders summary and details with focus ring styling on summary element', () => {
        const text = 'First sentence summary. More summary. The community allows: trading items; listing goods; and sending messages. Further details follow.';
        render(<ConsentText text={text} fontSize="14px" />);

        expect(screen.getByText('First sentence summary. More summary.')).toBeInTheDocument();

        const summary = screen.getByText('Read all of it');
        expect(summary).toBeInTheDocument();
        expect(summary.tagName.toLowerCase()).toBe('summary');
        expect(summary.className).toContain('focus-visible:ring-2');
        expect(summary.className).toContain('focus-visible:ring-emerald-500');
    });
});
