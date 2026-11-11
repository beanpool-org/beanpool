import { it } from 'vitest';
import * as core from '@beanpool/core';
import { checkContactsVectors } from '@beanpool/core/contacts-vectors';

// The frozen private-contacts vectors (packages/beanpool-core/src/contacts-vectors.ts), run by the phone: the web app runs
// the same list through its own module (apps/pwa src/lib/contacts-vectors.test.ts), so a list locked on one opens on the
// other. Today both hand in core's functions; the phone's contacts store (DESIGN-private-contacts-fable.md slice C2) hands
// in its own module here when it wraps them.
it('the phone locks and opens the frozen contacts copy byte for byte, with the bare seed it keeps and the web app\'s PKCS8', () => {
    checkContactsVectors(core);
});
