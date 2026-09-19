import { describe, it } from 'vitest';
import { SEALED_ENVELOPE_VECTOR_CHECKS } from '@beanpool/core/sealed-envelope-vectors';

/**
 * The frozen `bpseal/v1` vectors, run from the PWA's test runner (jsdom) against the built
 * @beanpool/core it bundles. Core's suite runs the identical list; the PWA holds its key as
 * 48-byte PKCS8, which is exactly the shape these vectors prove opens.
 */
describe('sealed-envelope vectors (PWA)', () => {
    it.each(SEALED_ENVELOPE_VECTOR_CHECKS.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
        await c.run();
    });
});
