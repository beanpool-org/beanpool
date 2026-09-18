/**
 * The diagnostic context sent with "Suggest a change to BeanPool": the app's language and platform.
 * Kept out of the screen so it can be tested in node. Nothing here identifies the member.
 */

/**
 * The device's language as a BCP-47 tag (e.g. "es-AR"), or null when it cannot be read.
 * Takes the resolver so the test does not depend on the machine's locale.
 */
export function deviceLang(
    resolve: () => string | undefined = () => Intl.DateTimeFormat().resolvedOptions().locale,
): string | null {
    try {
        const raw = resolve();
        if (typeof raw !== 'string') return null;
        // Drop Unicode extensions ("-u-nu-latn"): they describe number formats, not the language.
        const tag = raw.split('-u-')[0].replace(/_/g, '-');
        return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(tag) ? tag : null;
    } catch {
        return null;
    }
}
