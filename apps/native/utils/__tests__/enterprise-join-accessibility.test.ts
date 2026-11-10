import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('enterprise join request button accessibility', () => {
    const pagePath = path.resolve(__dirname, '../../app/treasury-detail.tsx');
    const pageContent = fs.readFileSync(pagePath, 'utf-8');

    it('has accessibilityRole="button", explicit accessibilityLabel, and dynamic accessibilityState on the join button', () => {
        expect(pageContent).toContain('onPress={handleJoinRequest}');
        const joinSection = pageContent.slice(
            pageContent.indexOf('onPress={handleJoinRequest}'),
            pageContent.indexOf('</Pressable>', pageContent.indexOf('onPress={handleJoinRequest}')),
        );
        expect(joinSection).toContain('accessibilityRole="button"');
        expect(joinSection).toContain("accessibilityLabel={project ? t('Request to join as a collaborator') : t('Request to join as a keeper')}");
        // Disabled while it sends or while the pledge is more than the reader can back: both whole hundredths of a Bean (the
        // typed pledge read by core parseHundredths, the detail's availableToBack_c), so Beans are never compared with hundredths.
        expect(joinSection).toContain('accessibilityState={{ disabled: submittingJoin || joinBacking_c > availableToBack, busy: submittingJoin }}');
        expect(joinSection).toContain('ActivityIndicator');
    });
});
