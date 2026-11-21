/**
 * Walking the web's join as a person does since slice W1 (DESIGN-onboarding-home-landing-fable.md §5): the front door's
 * I have an invite, Your invite's box and Next, then Your name's box and Join. Shared by the WelcomePage suites that used
 * to fill the one long invite form.
 */
import { fireEvent, screen } from '@testing-library/react';

/** The front door, drawn once the page knows what this community is. */
export async function frontDoor(): Promise<HTMLElement> {
    return screen.findByTestId('front-door');
}

/** From the front door to Your name with `code` in Your invite's box. */
export async function inviteThenName(code: string): Promise<void> {
    fireEvent.click(await screen.findByTestId('front-door-invite'));
    typeInvite(code);
    fireEvent.click(screen.getByTestId('your-invite-next'));
    await screen.findByTestId('name-step');
}

/** Your invite's box, as a person types or pastes into it. */
export function typeInvite(value: string): void {
    fireEvent.change(screen.getByLabelText('Invite link or code'), { target: { value } });
}

/** Your name's box. */
export function typeName(name: string): void {
    fireEvent.change(screen.getByLabelText('What should we call you?'), { target: { value: name } });
}

/** Your name's Join. */
export function pressJoin(): void {
    fireEvent.click(screen.getByTestId('name-step-join'));
}

/** The whole first part: front door, Your invite, Your name, Join. */
export async function joinWithInvite(code: string, name: string): Promise<void> {
    await inviteThenName(code);
    typeName(name);
    pressJoin();
}

/** The photo step's main button: Skip for now with no picture, Next with one. */
export function photoNext(): void {
    fireEvent.click(screen.getByTestId('photo-step-next'));
}
