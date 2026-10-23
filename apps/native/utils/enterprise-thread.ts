/**
 * An enterprise's discussion thread as the phone shows it: on its page (app/treasury-detail.tsx), where every member reads
 * and writes, and in its keepers' console (app/treasury-manage.tsx), where a keeper removes a message.
 */
import { t } from '@beanpool/core';
import { decodeBase64, decodeUtf8 } from './crypto';

/** What stands in for a message a keeper (a project's collaborator) removed: the same words the remove alert quotes. */
export function removedLine(project: boolean): string {
    return project ? t('removed by a collaborator') : t('removed by a keeper');
}

export function decodeThreadMessage(ciphertext: string, type: string, project = false): string {
    if (type === 'removed') return removedLine(project);
    try {
        return decodeUtf8(decodeBase64(ciphertext));
    } catch {
        return ciphertext;
    }
}
