/** A sign-in did not check out. The message is written for the member who may end up reading it. */
export class SsoVerificationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SsoVerificationError';
    }
}

/**
 * The provider could not be asked: its keys or its user endpoint failed (5xx), came back unusable,
 * or could not be reached. Nothing was learned about the token, and the nonce is still unspent.
 *
 * A subclass, so every caller that treats any SsoVerificationError as "the sign-in did not check
 * out" keeps doing exactly that. A caller that can tell the member "try again in a minute" instead
 * (on a node: the open door, routes/open-join.ts; the keeper and recovery routes, signInFailure in
 * routes/keepers.ts) checks for this one first.
 */
export class SsoProviderUnavailableError extends SsoVerificationError {
    constructor(message: string) {
        super(message);
        this.name = 'SsoProviderUnavailableError';
    }
}
