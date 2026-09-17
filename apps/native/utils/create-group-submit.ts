import { dismissKeyboardWithin } from './keyboard-dismiss';

export type CreateGroupSubmitOutcome = 'invalid' | 'created' | 'failed';

export interface CreateGroupSubmitDeps<T> {
    name: string;
    dismissKeyboard: () => unknown;
    setSubmitting: (submitting: boolean) => void;
    create: (trimmedName: string) => Promise<T>;
    onCreated: (result: T) => void;
    onInvalidName: () => void;
    onError: (error: unknown) => void;
    dismissTimeoutMs?: number;
}

/**
 * Create Group's submit, in the order that keeps it working on old Android:
 * 1. mark submitting first, so the button shows progress and cannot be tapped twice while we wait;
 * 2. dismiss the keyboard, but bounded — on API < 30 the dismiss inside a Modal may never resolve;
 * 3. validate (any Alert now opens over a closed keyboard) and create.
 */
export async function submitCreateGroup<T>(deps: CreateGroupSubmitDeps<T>): Promise<CreateGroupSubmitOutcome> {
    deps.setSubmitting(true);
    try {
        await dismissKeyboardWithin(deps.dismissKeyboard, deps.dismissTimeoutMs);
        const trimmed = deps.name.trim();
        if (trimmed.length < 2) {
            deps.onInvalidName();
            return 'invalid';
        }
        try {
            const result = await deps.create(trimmed);
            deps.onCreated(result);
            return 'created';
        } catch (e) {
            deps.onError(e);
            return 'failed';
        }
    } finally {
        deps.setSubmitting(false);
    }
}
