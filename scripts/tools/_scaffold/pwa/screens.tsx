/**
 * The tool's web screens, the same as the phone's. The host's covered page draws the frame around each and, while the
 * document is empty, the two doors; a screen draws the rest with the host's primitives (../ui) and reaches the app only
 * through `host`. Every sentence through t() from @beanpool/core; what the member wrote is shown as written.
 */
import { t, type ScaffoldScreenProps } from '@beanpool/core';
import { ToolRow, ToolSection } from '../ui';

/** The tool's first screen: what it keeps, one row each. */
export function Main({ host }: ScaffoldScreenProps) {
    const doc = host.doc.get();
    return (
        <ToolSection title={t('Kept here')}>
            {doc.items.length === 0
                ? <ToolRow title={t('Nothing here yet.')} />
                : doc.items.map((item) => <ToolRow key={item.id} title={item.name} state={item.addedAt.slice(0, 10)} />)}
        </ToolSection>
    );
}

export const SCREENS = { main: Main };
