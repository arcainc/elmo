import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@workspace/lib/db/db";
import { invitation } from "@workspace/lib/db/schema";
import { and, eq, gt } from "drizzle-orm";
import { parseInviteSignupToken } from "./invite-signup";

function signInvitation(invitationId: string, secret: string): string {
	return createHmac("sha256", secret).update(`elmo:invite-signup:${invitationId}`).digest("hex");
}

export function createLocalInvitationUrl(invitationId: string, secret: string, appUrl: string): string {
	const url = new URL("/auth/register", appUrl);
	url.hash = `invite=${invitationId}.${signInvitation(invitationId, secret)}`;
	return url.href;
}

export async function canSignUpWithInvitation(token: string, email: string, secret: string): Promise<boolean> {
	const parsed = parseInviteSignupToken(token);
	if (!parsed) return false;
	const { invitationId, signature } = parsed;
	if (!timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(signInvitation(invitationId, secret), "hex"))) {
		return false;
	}

	const [pending] = await db
		.select({ email: invitation.email })
		.from(invitation)
		.where(and(eq(invitation.id, invitationId), eq(invitation.status, "pending"), gt(invitation.expiresAt, new Date())))
		.limit(1);
	return pending?.email.toLowerCase() === email.toLowerCase();
}
