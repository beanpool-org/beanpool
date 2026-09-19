import { describe, it } from 'vitest';
import { SEALED_ENVELOPE_VECTOR_CHECKS } from '@beanpool/core/sealed-envelope-vectors';

/**
 * The frozen `bpseal/v1` vectors, run from the native app's own test runner against the built
 * @beanpool/core it bundles. Core's suite runs the identical list; if the two ever disagree, a
 * phone would fail to open an envelope the server sealed. Node, not Hermes — see vitest.config.ts.
 */
describe('sealed-envelope vectors (native)', () => {
    it.each(SEALED_ENVELOPE_VECTOR_CHECKS.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
        await c.run();
    });
});
