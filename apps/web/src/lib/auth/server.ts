/**
 * Auth instance for the web app.
 *
 * Created once at module scope using the shared factory from @workspace/lib,
 * with deployment-specific options injected based on DEPLOYMENT_MODE.
 *
 * This is the single source of truth for the server-side auth object.
 * All server functions, middleware, and route handlers import from here.
 */
import { getCloudAuthOptions } from "@workspace/deployment/auth-hooks/cloud";
import { getWhitelabelAuthOptions } from "@workspace/deployment/auth-hooks/whitelabel";
import { type CreateAuthOptions, createAuth } from "@workspace/lib/auth/server";
import { countUsers, provisionLocalOrg } from "@workspace/lib/db/provisioning";
import { APIError } from "better-auth/api";
import { INVITE_SIGNUP_HEADER } from "./invite-signup";
import { canSignUpWithInvitation } from "./local-invitations";

function getLocalAuthOptions(): CreateAuthOptions {
	return {
		databaseHooks: {
			user: {
				create: {
					before: async (user, ctx) => {
						const token = ctx?.headers?.get(INVITE_SIGNUP_HEADER);
						if (token && ctx?.path === "/sign-up/email") {
							if (await canSignUpWithInvitation(token, user.email, ctx.context.secret)) return;
							throw new APIError("FORBIDDEN", {
								message: "Use the invited email address and a valid, unexpired invitation link.",
							});
						}
						if ((await countUsers()) > 0) {
							throw new APIError("FORBIDDEN", { message: "An invitation is required to create an account." });
						}
					},
					after: async (user, ctx) => {
						if (ctx?.path === "/sign-up/email" && ctx.headers?.get(INVITE_SIGNUP_HEADER)) return;
						await provisionLocalOrg({ userId: user.id });
					},
				},
			},
		},
	};
}

function getDeploymentAuthOptions(): CreateAuthOptions | undefined {
	switch (process.env.DEPLOYMENT_MODE) {
		case "whitelabel":
			return getWhitelabelAuthOptions();
		case "demo":
			// Demo deployments authenticate only the provisioned demo user.
			return { disableSignUp: true };
		case "cloud": {
			// Full cloud auth stack (email verification, Google OAuth, Resend
			// transactional email, team invitations, disposable-domain blocking,
			// invite-only allowlist, and umbrella-org provisioning). The cloud
			// package owns the entire hook chain — this case is a single call.
			return getCloudAuthOptions();
		}
		default:
			return getLocalAuthOptions();
	}
}

export const auth = createAuth(getDeploymentAuthOptions());

// The runtime's unhandled-rejection log drops the error's `cause`.
auth.$context.catch((error: unknown) => {
	console.error("[auth] init failed:", error);
	throw error;
});
