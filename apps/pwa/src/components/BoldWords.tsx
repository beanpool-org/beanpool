/**
 * A translated sentence with **bold** words in it (the guide's convention, design §2.1): the sentence stays one string,
 * so a translator can move the bold part where their language puts it, and it renders as the same <strong> it always
 * did. `<BoldWords text={t('These 12 words **are** your account.')} />`
 */

import { Fragment } from 'react';
import { splitBold } from '@beanpool/core';

export function BoldWords({ text }: { text: string }) {
    return <>{splitBold(text).map((s, i) => (s.bold ? <strong key={i}>{s.text}</strong> : <Fragment key={i}>{s.text}</Fragment>))}</>;
}
