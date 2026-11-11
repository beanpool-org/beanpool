import { it } from 'vitest';
import * as phone from '../contacts-store';
import { checkContactsVectors } from '@beanpool/core/contacts-vectors';

// The frozen private-contacts vectors (packages/beanpool-core/src/contacts-vectors.ts), run through the phone's own contacts
// store (utils/contacts-store.ts, DESIGN-private-contacts-fable.md slice C2): what it locks and opens with. The web app runs
// the same list through its own module (apps/pwa src/lib/contacts-vectors.test.ts), so a list locked on one opens on the
// other.
it('the phone locks and opens the frozen contacts copy byte for byte, with the bare seed it keeps and the web app\'s PKCS8', () => {
    checkContactsVectors(phone);
});
