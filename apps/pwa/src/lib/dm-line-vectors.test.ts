import { it } from 'vitest';
import { checkDmLineVectors } from '@beanpool/core/dm-line-vectors';
import * as webCrypto from './e2e-crypto';

// The frozen direct-message vectors (packages/beanpool-core/src/dm-line-vectors.ts), run through this app's own
// e2e-crypto module: the phone runs the same list through its own (apps/native dm-line-binding.test.ts).
it('the web app seals and opens the frozen direct-message lines byte for byte, and refuses every changed binding', () => {
    checkDmLineVectors(webCrypto);
});
