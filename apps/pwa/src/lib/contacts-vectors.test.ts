import { it } from 'vitest';
import * as core from '@beanpool/core';
import { checkContactsVectors } from '@beanpool/core/contacts-vectors';

// The frozen private-contacts vectors (packages/beanpool-core/src/contacts-vectors.ts), run by the web app: the phone runs
// the same list through its own module (apps/native utils/__tests__/contacts-vectors.test.ts), so a list locked on one
// opens on the other. Today both hand in core's functions; the web app's contacts store (DESIGN-private-contacts-fable.md
// slice C4) hands in its own module here when it wraps them.
it('the web app locks and opens the frozen contacts copy byte for byte, with the PKCS8 key it keeps and the phone\'s bare seed', () => {
    checkContactsVectors(core);
});
