/**
 * The sentences on the sign-in return pages: beanpool.org/auth/<provider> (apps/website/auth/*.html) and the web app's own
 * /auth/facebook.html (apps/pwa/public/auth/facebook.html). A provider sends the member back to one of these fixed
 * addresses; the page bounces on to the app (beanpool://auth/<provider>) and, for the moment it shows, says so in the
 * member's language.
 *
 * Marked with word() so the translation pass sees them with the rest of core's words; scripts/website-build.mjs builds
 * the five pages from this file and core's catalogs (packages/beanpool-core/words/<lang>.json): a language that has a
 * sentence shows it, a language that has not shows the English (never a failure). Edit here, then run
 * `node scripts/website-build.mjs`; `--check` fails until the pages match. One line per sentence, no escapes: the build
 * reads this file without a TypeScript compiler. {provider} is the provider's own name (Google, Facebook, Instagram,
 * TikTok), never translated.
 */
import { word } from './words.js';

export const AUTH_BOUNCE_WORDS = {
    title: word('Connecting to BeanPool...'),
    heading: word('Returning to BeanPool...'),
    signIn: word("Connecting your {provider} sign-in. If you aren't redirected automatically, tap the button below:"),
    authentication: word("Connecting your {provider} authentication. If you aren't redirected automatically, tap the button below:"),
    open: word('Open BeanPool'),
} as const;
