import { act, fireEvent, screen, within } from '@testing-library/react';

/** Tests only: answer the in-page confirmation (useInPageConfirm) the last click opened, by its button's name. */
export async function answerInPageConfirm(label: string | RegExp): Promise<void> {
    const dialog = await screen.findByRole('alertdialog');
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: label })); });
}
