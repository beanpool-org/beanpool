/**
 * The web app's real copy code on a page of a real community's own address, for e2e/global-tick-check.mjs: what the screens call,
 * with nothing in front of it, so the check can walk each case by name. The row itself is walked in the built app.
 */
import * as api from '../src/lib/api';
import * as copies from '../src/lib/show-on-global';
import { copyPairs } from '../src/lib/copy-pairs';
import { clearAccountStorage } from '../src/lib/device-prefs';
import { loadIdentity } from '../src/lib/identity';

(window as unknown as { tick: unknown }).tick = { api, clearAccountStorage, copies, copyPairs, loadIdentity };
document.title = 'tick-ready';
