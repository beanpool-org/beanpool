/**
 * The requests the fetch wrapper (utils/node-request-signing.ts) sends WITHOUT the member's language, on purpose. Every
 * other request to a community's API carries it (#3271), so a refusal comes back in the member's language.
 *
 * One use: a copy on the worldwide community names nobody (#2731, "A copy names nobody"), so its requests carry the
 * signature's headers and nothing of the member, as the web's do (apps/pwa api.ts signedCopyFetch; apps/server
 * copy-cors.ts lets nothing else through from a browser). Its refusals stay in English, as they always were: carrying the
 * language there is a privacy call of its own, not this one's. utils/__tests__/cross-community-language.test.ts lists
 * every request that asks for this.
 */
const WITHOUT_LANGUAGE = new WeakSet<object>();

/** `init`, marked: the wrapper sends it without `X-Language`. */
export function withoutLanguage<T extends object>(init: T): T {
    WITHOUT_LANGUAGE.add(init);
    return init;
}

/** Whether `init` was marked by {@link withoutLanguage}. */
export function isWithoutLanguage(init: unknown): boolean {
    return typeof init === 'object' && init !== null && WITHOUT_LANGUAGE.has(init);
}
