/**
 * The Tool shed's phone screens, one per name in its manifest (packages/beanpool-core/src/tools/things/manifest.ts). The
 * host route draws the frame around each (the header and its count line, the "…" menu, the backup line) and, while the
 * shed is empty, the two doors; these draw the rest with the template's primitives (../ui) and reach the app only
 * through `host`. Every sentence through t() from @beanpool/core; what the member wrote is shown as written.
 */
import { EditScreen } from './edit';
import { LoansScreen } from './loans';
import { Main } from './main';
import { ThingScreen } from './thing';

export const SCREENS = { main: Main, thing: ThingScreen, edit: EditScreen, loans: LoansScreen };
