import { randomUUID } from "node:crypto";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { db } from "@workspace/lib/db/db";
import { account, invitation, member, organization, user } from "@workspace/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { INVITE_SIGNUP_HEADER } from "../invite-signup";

vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => ({
		validator: (schema: { parse: (input: unknown) => unknown }) => ({
			handler:
				(handler: (options: { data: unknown }) => unknown) =>
				({ data }: { data: unknown }) =>
					handler({ data: schema.parse(data) }),
		}),
	}),
}));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: vi.fn() }));

const origin = "http://localhost:3000";
const secret = "local-invitation-integration-test-secret";
const organizationId = randomUUID();
const adminId = randomUUID();
const adminEmail = `${adminId}@example.com`;
const inviteeEmail = `${organizationId}@example.com`;
const wrongEmail = `other-${organizationId}@example.com`;
const retryEmail = `retry-${organizationId}@example.com`;
const password = "test-password-123";

let auth: typeof import("../server").auth;
let team: typeof import("@/server/team");
let adminHeaders: Headers;
const resendRequest = vi.fn<typeof fetch>();

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
		vi.stubEnv("RESEND_API_KEY", "re_example");
		vi.stubEnv("RESEND_FROM_EMAIL", "Elmo <invites@example.com>");
		vi.stubEnv("RESEND_BASE_URL", "https://api.resend.com");
		vi.stubGlobal("fetch", resendRequest);
		({ auth } = await import("../server"));
		team = await import("@/server/team");
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
		adminHeaders = new Headers({ cookie: sessionCookie(result) });
	});

	afterAll(async () => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		await db.delete(organization).where(eq(organization.id, organizationId));
		await db.delete(user).where(inArray(user.email, [adminEmail, inviteeEmail, wrongEmail, retryEmail]));
	});

	it("sends a signup link that grants only the invited role in the invited organization", async () => {
		vi.mocked(getRequestHeaders).mockReturnValue(adminHeaders);
		resendRequest.mockResolvedValueOnce(Response.json({ id: randomUUID() }));

		const invite = await team.inviteTeamMemberFn({
			data: { email: inviteeEmail, organizationId, role: "member" },
		});
		expect(invite).toMatchObject({ emailSent: true, inviteUrl: null });
		const [endpoint, request] = resendRequest.mock.lastCall ?? [];
		expect(endpoint).toBe("https://api.resend.com/emails");
		const email = JSON.parse(String(request?.body));
		expect(email).toMatchObject({
			from: "Elmo <invites@example.com>",
			to: inviteeEmail,
			subject: "Admin invited you to Test organization on Elmo",
		});
		const url = new URL(email.html.match(/href="([^"]+)"/)?.[1] ?? "");
		expect(url.origin).toBe(origin);
		expect(url.pathname).toBe("/auth/register");
		expect(email.text).toContain(url.href);
		const token = new URLSearchParams(url.hash.slice(1)).get("invite") ?? "";
		const [pending] = await db.select().from(invitation).where(eq(invitation.id, invite.id));

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

		await db.update(invitation).set({ expiresAt: pending.expiresAt }).where(eq(invitation.id, invite.id));
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

	it("keeps a failed email pending for an admin to resend to the same address", async () => {
		vi.mocked(getRequestHeaders).mockReturnValue(adminHeaders);
		resendRequest.mockResolvedValueOnce(Response.json({ name: "rate_limit_exceeded" }, { status: 429 }));
		const invite = await team.inviteTeamMemberFn({ data: { email: retryEmail, organizationId, role: "member" } });
		expect(invite).toMatchObject({ emailSent: false, inviteUrl: expect.stringContaining("/auth/register#invite=") });

		resendRequest.mockResolvedValueOnce(Response.json({ id: randomUUID() }));
		const data = { organizationId, invitationId: invite.id };
		expect(await team.resendInvitationFn({ data })).toEqual({ emailSent: true });
		const email = JSON.parse(String(resendRequest.mock.lastCall?.[1]?.body));
		expect(email.to).toBe(retryEmail);
		expect(email.text).toContain(invite.inviteUrl);

		await team.cancelInvitationFn({ data });
		await expect(team.resendInvitationFn({ data })).rejects.toThrow("This invitation is no longer available");
	});
});
