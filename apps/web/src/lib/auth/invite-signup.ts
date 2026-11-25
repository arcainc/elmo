export const INVITE_SIGNUP_HEADER = "x-elmo-invite";

export function parseInviteSignupToken(token: string | undefined) {
	const match = token?.match(/^([a-zA-Z0-9_-]{1,128})\.([a-f0-9]{64})$/);
	if (!match) return null;
	return { invitationId: match[1], signature: match[2] };
}
