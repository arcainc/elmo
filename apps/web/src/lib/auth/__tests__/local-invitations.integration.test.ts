import { randomUUID } from "node:crypto";
import { db } from "@workspace/lib/db/db";
import { account, invitation, member, organization, user } from "@workspace/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { INVITE_SIGNUP_HEADER } from "../invite-signup";
import { createLocalInvitationUrl } from "../local-invitations";

const origin = "http://localhost:3000";
const secret = "local-invitation-integration-test-secret";
const organizationId = randomUUID();
const adminId = randomUUID();
const adminEmail = `${adminId}@example.com`;
const inviteeEmail = `${organizationId}@example.com`;
const wrongEmail = `other-${organizationId}@example.com`;
const password = "test-password-123";

let auth: typeof import("../server").auth;
let adminCookie: string;

function post(path: string, body: Record<string, unknown>, extraHeaders?: Record<string, string>) {
	return auth.handler(
		new Request(`${origin}/api/auth/${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", origin, ...extraHeaders },
			body: JSON.stringify(body),
		}),
	);
}

function sessionCookie(response: Response): string {
	return response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ");
}

function signup(email: string, token?: string) {
	return post(
		"sign-up/email",
		{ name: "Invitee", email, password },
		token ? { [INVITE_SIGNUP_HEADER]: token } : undefined,
	);
}

describe("self-hosted invitations", () => {
	beforeAll(async () => {
		vi.stubEnv("DEPLOYMENT_MODE", "local");
		vi.stubEnv("APP_URL", origin);
		vi.stubEnv("PORT", "3000");
		vi.stubEnv("BETTER_AUTH_SECRET", secret);
		({ auth } = await import("../server"));
		const context = await auth.$context;
		await db.transaction(async (tx) => {
			await tx.insert(user).values({ id: adminId, name: "Admin", email: adminEmail });
			await tx.insert(account).values({
				id: randomUUID(),
				userId: adminId,
				accountId: adminId,
				providerId: "credential",
				password: await context.password.hash(password),
				updatedAt: new Date(),
			});
			await tx.insert(organization).values({
				id: organizationId,
				slug: organizationId,
				name: "Test organization",
				createdAt: new Date(),
			});
			await tx.insert(member).values({
				id: randomUUID(),
				organizationId,
				userId: adminId,
				role: "admin",
				createdAt: new Date(),
			});
		});
		const result = await post("sign-in/email", { email: adminEmail, password });
		expect(result.status).toBe(200);
		adminCookie = sessionCookie(result);
	});

	afterAll(async () => {
		vi.unstubAllEnvs();
		await db.delete(organization).where(eq(organization.id, organizationId));
		await db.delete(user).where(inArray(user.email, [adminEmail, inviteeEmail, wrongEmail]));
	});

	it("requires a live invitation for signup and grants only its role in the invited organization", async () => {
		const invite = await auth.api.createInvitation({
			body: { email: inviteeEmail, organizationId, role: "member" },
			headers: new Headers({ cookie: adminCookie }),
		});
		const url = new URL(createLocalInvitationUrl(invite.id, secret, origin));
		const token = new URLSearchParams(url.hash.slice(1)).get("invite") ?? "";

		expect((await signup(inviteeEmail)).status).toBe(403);
		expect((await signup(inviteeEmail, `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`)).status).toBe(403);
		expect((await signup(wrongEmail, token)).status).toBe(403);

		await db.update(invitation).set({ status: "canceled" }).where(eq(invitation.id, invite.id));
		expect((await signup(inviteeEmail, token)).status).toBe(403);

		await db
			.update(invitation)
			.set({ status: "pending", expiresAt: new Date(0) })
			.where(eq(invitation.id, invite.id));
		expect((await signup(inviteeEmail, token)).status).toBe(403);

		await db.update(invitation).set({ expiresAt: invite.expiresAt }).where(eq(invitation.id, invite.id));
		const signupResult = await signup(inviteeEmail.toUpperCase(), token);
		expect(signupResult.status).toBe(200);
		const headers = new Headers({ cookie: sessionCookie(signupResult) });
		const accepted = await auth.api.acceptInvitation({ body: { invitationId: invite.id }, headers });
		expect(accepted.member).toMatchObject({ organizationId, role: "member" });
		const memberships = await db.select().from(member).where(eq(member.userId, accepted.member.userId));
		expect(memberships).toHaveLength(1);

		await expect(
			auth.api.createInvitation({ body: { email: wrongEmail, organizationId, role: "member" }, headers }),
		).rejects.toMatchObject({ statusCode: 403 });
		await expect(auth.api.acceptInvitation({ body: { invitationId: invite.id }, headers })).rejects.toMatchObject({
			statusCode: 400,
		});
	});
});
