import { it } from 'vitest';
import { checkContactsVectors } from '@beanpool/core/contacts-vectors';
import * as webContacts from './contacts-lock';

// The frozen private-contacts vectors (packages/beanpool-core/src/contacts-vectors.ts), run through the web app's OWN
// contacts module (lib/contacts-lock.ts, what lib/contacts-store.ts locks and opens with): the phone runs the same list
// through its own module (apps/native utils/__tests__/contacts-vectors.test.ts), so a list locked on one opens on the other.
it('the web app locks and opens the frozen contacts copy byte for byte, with the PKCS8 key it keeps and the phone\'s bare seed', () => {
    checkContactsVectors(webContacts);
});
