import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@workspace/ui/components/select";
import { useState } from "react";
import { WriteErrorMessage } from "@/components/write-error-message";
import { trackEvent } from "@/lib/posthog";
import { pageHead } from "@/lib/route-head";
import { useWriteErrorMessage } from "@/lib/write-errors";
import {
	cancelInvitationFn,
	getShareableInvitationLinkFn,
	inviteTeamMemberFn,
	listTeamFn,
	removeTeamMemberFn,
	resendInvitationFn,
	type TeamData,
} from "@/server/team";

export const Route = createFileRoute("/_authed/app/org/$org/settings/members")({
	staticData: { crumb: "Team" },
	beforeLoad: ({ context }) => {
		if (context.clientConfig && !context.clientConfig.features.teamInvites) {
			throw notFound();
		}
	},
	loader: ({ context }): Promise<TeamData> => listTeamFn({ data: { organizationId: context.organization.id } }),
	head: pageHead({ description: "Invite teammates and manage team members." }),
	component: TeamSettingsPage,
});

function TeamSettingsPage() {
	const { members, invitations, currentUserId, canManageTeam, sharesInviteLinks, emailsLocalInvites, organization } =
		Route.useLoaderData();
	const organizationId = organization.id;
	const inviteByEmail = emailsLocalInvites || !sharesInviteLinks;
	const writeError = useWriteErrorMessage();
	const router = useRouter();
	const [inviteEmail, setInviteEmail] = useState("");
	const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
	const [inviting, setInviting] = useState(false);
	const [resending, setResending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [sentTo, setSentTo] = useState<string | null>(null);
	const [shareLink, setShareLink] = useState<{ invitationId: string; url: string } | null>(null);
	const [copied, setCopied] = useState(false);

	async function handleInvite(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		setSentTo(null);
		setInviting(true);
		try {
			const { id, inviteUrl, emailSent } = await inviteTeamMemberFn({
				data: { organizationId, email: inviteEmail, role: inviteRole },
			});
			setShareLink(inviteUrl ? { invitationId: id, url: inviteUrl } : null);
			setCopied(false);
			if (emailSent) setSentTo(inviteEmail);
			if (emailSent === false) {
				setError("The invitation was created, but the email could not be sent. Resend the email or copy the link.");
			}
			trackEvent("team_member_invited", { role: inviteRole });
			setInviteEmail("");
			setInviteRole("member");
			await router.invalidate();
		} catch (err) {
			setError(writeError(err, "Failed to create invitation"));
		} finally {
			setInviting(false);
		}
	}

	async function handleResend(invitationId: string, email: string) {
		setError(null);
		setSentTo(null);
		setResending(invitationId);
		try {
			const { emailSent } = await resendInvitationFn({ data: { organizationId, invitationId } });
			if (emailSent) setSentTo(email);
			else setError("The invitation email could not be sent. Try again or use Show Link.");
		} catch (err) {
			setError(writeError(err, "Failed to resend the invitation email"));
		} finally {
			setResending(null);
		}
	}

	async function handleShowLink(invitationId: string) {
		setError(null);
		try {
			const { inviteUrl } = await getShareableInvitationLinkFn({ data: { organizationId, invitationId } });
			setShareLink({ invitationId, url: inviteUrl });
			setCopied(false);
		} catch (err) {
			setError(writeError(err, "Failed to load invitation link"));
		}
	}

	async function handleCopyLink(url: string) {
		setError(null);
		try {
			await navigator.clipboard.writeText(url);
			setCopied(true);
		} catch {
			setError("Select and copy the link from the invitation link field.");
		}
	}

	async function handleRemove(memberId: string) {
		setError(null);
		try {
			await removeTeamMemberFn({ data: { organizationId, memberId } });
			await router.invalidate();
		} catch (err) {
			setError(writeError(err, "Failed to remove member"));
		}
	}

	async function handleCancel(invitationId: string) {
		setError(null);
		try {
			await cancelInvitationFn({ data: { organizationId, invitationId } });
			setShareLink((link) => (link?.invitationId === invitationId ? null : link));
			await router.invalidate();
		} catch (err) {
			setError(writeError(err, "Failed to cancel invitation"));
		}
	}

	return (
		<div className="space-y-6">
			<h1 className="text-3xl font-bold">Team</h1>

			{error && (
				<Alert variant="destructive">
					<AlertDescription>
						<WriteErrorMessage message={error} />
					</AlertDescription>
				</Alert>
			)}

			{sentTo && (
				<p className="text-sm" role="status">
					Invitation sent to {sentTo}.
				</p>
			)}

			{canManageTeam && (
				<form onSubmit={handleInvite} className="flex flex-wrap items-end gap-3">
					<div className="flex flex-col gap-2">
						<Label htmlFor="invite-email">Email</Label>
						<Input
							id="invite-email"
							type="email"
							placeholder="teammate@example.com"
							value={inviteEmail}
							onChange={(e) => setInviteEmail(e.target.value)}
							required
							autoComplete="off"
							data-lpignore="true"
							data-1p-ignore
							data-bwignore
							className="w-64"
						/>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="invite-role">Role</Label>
						<Select
							items={{ member: "Member", admin: "Admin" }}
							value={inviteRole}
							onValueChange={(value) => setInviteRole(value as "member" | "admin")}
						>
							<SelectTrigger id="invite-role" className="w-32">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="member">Member</SelectItem>
								<SelectItem value="admin">Admin</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<Button type="submit" disabled={inviting || !!resending}>
						{inviting ? "Inviting..." : inviteByEmail ? "Send Invite" : "Create Invite Link"}
					</Button>
				</form>
			)}

			{canManageTeam && shareLink && (
				<div className="max-w-xl space-y-2 rounded-md border p-4">
					<Label htmlFor="team-invite-link">Invitation Link</Label>
					<p className="text-sm text-muted-foreground">Share this link privately with the invited teammate.</p>
					<div className="flex gap-2">
						<Input id="team-invite-link" value={shareLink.url} readOnly onFocus={(e) => e.currentTarget.select()} />
						<Button type="button" variant="outline" onClick={() => handleCopyLink(shareLink.url)}>
							{copied ? "Copied" : "Copy Link"}
						</Button>
					</div>
				</div>
			)}

			<div className="space-y-3">
				<h2 className="text-lg font-semibold">Members</h2>
				<div className="divide-y rounded-md border">
					{members.map((m) => (
						<div key={m.id} className="flex items-center justify-between gap-3 p-3">
							<div className="min-w-0">
								<p className="truncate font-medium">{m.name}</p>
								<p className="truncate text-sm text-muted-foreground">{m.email}</p>
							</div>
							<div className="flex shrink-0 items-center gap-3">
								<Badge variant="secondary">{m.role}</Badge>
								{canManageTeam && m.userId !== currentUserId && (
									<Button type="button" variant="outline" size="sm" onClick={() => handleRemove(m.id)}>
										Remove
									</Button>
								)}
							</div>
						</div>
					))}
				</div>
			</div>

			{invitations.length > 0 && (
				<div className="space-y-3">
					<h2 className="text-lg font-semibold">Pending invitations</h2>
					<div className="divide-y rounded-md border">
						{invitations.map((inv) => (
							<div key={inv.id} className="flex items-center justify-between gap-3 p-3">
								<div className="min-w-0">
									<p className="truncate font-medium">{inv.email}</p>
									<p className="text-sm text-muted-foreground">
										Expires {new Date(inv.expiresAt).toLocaleDateString()}
									</p>
								</div>
								<div className="flex shrink-0 items-center gap-3">
									<Badge variant="secondary">{inv.role ?? "member"}</Badge>
									{sharesInviteLinks && (
										<Button type="button" variant="outline" size="sm" onClick={() => handleShowLink(inv.id)}>
											Show Link
										</Button>
									)}
									{emailsLocalInvites && new Date(inv.expiresAt) > new Date() && (
										<Button
											type="button"
											variant="outline"
											size="sm"
											disabled={inviting || !!resending}
											onClick={() => handleResend(inv.id, inv.email)}
										>
											{resending === inv.id ? "Sending..." : "Resend Email"}
										</Button>
									)}
									<Button type="button" variant="outline" size="sm" onClick={() => handleCancel(inv.id)}>
										Cancel
									</Button>
								</div>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
