/**
 * Azure DevOps Extension
 *
 * Registers a read-only `azure_devops` tool for pull requests and work items, using the REST API (7.1).
 *
 * Auth, first match wins:
 * - AZURE_DEVOPS_PAT or AZURE_DEVOPS_EXT_PAT: personal access token (Code: Read, Work Items: Read)
 * - Azure CLI: an Entra ID token from `az account get-access-token`, when `az` is installed and logged in
 * - SYSTEM_ACCESSTOKEN: the Azure Pipelines job token
 *
 * Organization, project and repository come from the tool arguments, then AZURE_DEVOPS_ORG_URL /
 * AZURE_DEVOPS_PROJECT, then the `origin` remote of the current git repository.
 */

import { execFile } from "node:child_process";
import { StringEnum } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type ExtensionAPI, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AzureRepo, htmlToText, parseAzureRemote } from "./remote.ts";

const API_VERSION = "7.1";

const Params = Type.Object({
	action: StringEnum(["pr_list", "pr_get", "pr_threads", "pr_changes", "work_item"] as const, {
		description:
			"pr_list: list pull requests. pr_get: PR details and linked work items. pr_threads: review comment threads. pr_changes: files changed in the latest iteration. work_item: one work item.",
	}),
	id: Type.Optional(Type.Number({ description: "Pull request id (pr_get, pr_threads, pr_changes) or work item id (work_item)" })),
	status: Type.Optional(
		StringEnum(["active", "completed", "abandoned", "all"] as const, { description: "pr_list filter (default active)" }),
	),
	orgUrl: Type.Optional(Type.String({ description: "Organization URL, e.g. https://dev.azure.com/contoso. Defaults to the git remote." })),
	project: Type.Optional(Type.String({ description: "Project name. Defaults to the git remote." })),
	repository: Type.Optional(Type.String({ description: "Repository name. Defaults to the git remote." })),
});

/** Entra ID application id of Azure DevOps, the resource to request tokens for. */
const AZURE_DEVOPS_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";

let azToken: { token: string; expiresAt: number } | undefined;

/** Get an Entra ID token from the Azure CLI, cached until five minutes before it expires. */
async function azCliToken(): Promise<{ token?: string; error?: string }> {
	if (azToken && azToken.expiresAt - Date.now() > 5 * 60_000) return { token: azToken.token };
	return new Promise((resolve) => {
		// `az` is a .cmd file on Windows, which Node can only start through a shell. The arguments are constants.
		execFile(
			"az",
			["account", "get-access-token", "--resource", AZURE_DEVOPS_RESOURCE, "--output", "json"],
			{ shell: process.platform === "win32", timeout: 30_000, windowsHide: true },
			(err, stdout, stderr) => {
				if (err) {
					const notInstalled = (err as NodeJS.ErrnoException).code === "ENOENT" || /not recognized|not found/i.test(stderr);
					return resolve({ error: notInstalled ? undefined : stderr.trim() || err.message });
				}
				try {
					const data = JSON.parse(stdout);
					const expiresAt = data.expires_on ? Number(data.expires_on) * 1000 : Date.parse(data.expiresOn);
					azToken = { token: data.accessToken, expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 30 * 60_000 };
					resolve({ token: azToken.token });
				} catch {
					resolve({ error: "Could not parse `az account get-access-token` output." });
				}
			},
		);
	});
}

async function authHeader(): Promise<string> {
	const pat = process.env.AZURE_DEVOPS_PAT ?? process.env.AZURE_DEVOPS_EXT_PAT;
	if (pat) return `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;

	const az = await azCliToken();
	if (az.token) return `Bearer ${az.token}`;

	if (process.env.SYSTEM_ACCESSTOKEN) return `Bearer ${process.env.SYSTEM_ACCESSTOKEN}`;

	throw new Error(
		[
			"No Azure DevOps credentials. Either:",
			"- set AZURE_DEVOPS_PAT to a personal access token with Code (Read) and Work Items (Read) scopes, then restart pi, or",
			"- install the Azure CLI and run `az login`.",
			az.error ? `Azure CLI error: ${az.error}` : "",
		]
			.filter(Boolean)
			.join("\n"),
	);
}

interface Identity {
	displayName?: string;
	uniqueName?: string;
}

const who = (i?: Identity) => i?.displayName ?? i?.uniqueName ?? "unknown";
const branch = (ref?: string) => ref?.replace(/^refs\/heads\//, "") ?? "?";
const voteLabel: Record<number, string> = { 10: "approved", 5: "approved with suggestions", 0: "no vote", [-5]: "waiting for author", [-10]: "rejected" };

export default function (pi: ExtensionAPI) {
	async function resolveRepo(cwd: string, params: { orgUrl?: string; project?: string; repository?: string }) {
		let fromRemote: AzureRepo | undefined;
		const remote = await pi.exec("git", ["remote", "get-url", "origin"], { cwd, timeout: 5000 }).catch(() => undefined);
		if (remote?.code === 0) fromRemote = parseAzureRemote(remote.stdout);

		const orgUrl = (params.orgUrl ?? process.env.AZURE_DEVOPS_ORG_URL ?? fromRemote?.orgUrl)?.replace(/\/+$/, "");
		const project = params.project ?? process.env.AZURE_DEVOPS_PROJECT ?? fromRemote?.project;
		const repository = params.repository ?? fromRemote?.repository;
		if (!orgUrl || !project) {
			throw new Error(
				"Could not work out the Azure DevOps organization and project. Pass orgUrl and project, set AZURE_DEVOPS_ORG_URL and AZURE_DEVOPS_PROJECT, or run pi inside a clone of an Azure Repos repository.",
			);
		}
		return { orgUrl, project, repository };
	}

	async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
		const sep = url.includes("?") ? "&" : "?";
		const response = await fetch(`${url}${sep}api-version=${API_VERSION}`, {
			headers: { Authorization: await authHeader(), Accept: "application/json" },
			signal,
		});
		// 203 is the sign-in page Azure DevOps returns instead of 401 for some bad credentials.
		if (response.status === 203 || response.status === 401) {
			azToken = undefined;
			throw new Error(
				`Azure DevOps rejected the credentials (HTTP ${response.status}). Check the PAT or \`az login\` account has access to this organization; Conditional Access policies can also block tokens from this network.`,
			);
		}
		if (!response.ok) {
			const body = await response.text();
			throw new Error(`Azure DevOps request failed: HTTP ${response.status} ${response.statusText}\n${body.slice(0, 500)}`);
		}
		return (await response.json()) as T;
	}

	pi.registerTool({
		name: "azure_devops",
		label: "Azure DevOps",
		description: `Read Azure DevOps pull requests (list, details, comment threads, changed files) and work items. Read-only. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Read Azure DevOps pull requests, review threads and work items",
		promptGuidelines: [
			"Use azure_devops instead of guessing PR or work item contents; it infers org, project and repo from the git remote.",
			"For a PR review, call pr_get, then pr_changes, then pr_threads so you do not repeat comments that already exist.",
		],
		parameters: Params,
		annotations: { readOnlyHint: true, openWorldHint: true },

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { orgUrl, project, repository } = await resolveRepo(ctx.cwd, params);
			const projectUrl = `${orgUrl}/${encodeURIComponent(project)}`;
			const needsRepo = params.action !== "work_item";
			if (needsRepo && !repository) throw new Error("Pass repository, or run pi inside a clone of the repository.");
			const repoUrl = `${projectUrl}/_apis/git/repositories/${encodeURIComponent(repository ?? "")}`;
			const needId = () => {
				if (params.id === undefined) throw new Error(`${params.action} needs id`);
				return params.id;
			};

			const out: string[] = [];
			let details: Record<string, unknown> = { action: params.action, orgUrl, project, repository };

			switch (params.action) {
				case "pr_list": {
					const status = params.status ?? "active";
					const data = await get<{ value: any[] }>(`${repoUrl}/pullrequests?searchCriteria.status=${status}&$top=50`, signal);
					out.push(`${data.value.length} ${status} pull request(s) in ${project}/${repository}:`);
					for (const pr of data.value) {
						out.push(`!${pr.pullRequestId} ${pr.isDraft ? "[draft] " : ""}${pr.title} (${branch(pr.sourceRefName)} -> ${branch(pr.targetRefName)}, by ${who(pr.createdBy)})`);
					}
					details = { ...details, count: data.value.length };
					break;
				}

				case "pr_get": {
					const id = needId();
					const pr = await get<any>(`${repoUrl}/pullrequests/${id}`, signal);
					out.push(`PR !${pr.pullRequestId}: ${pr.title}`);
					out.push(`Status: ${pr.status}${pr.isDraft ? " (draft)" : ""}, merge: ${pr.mergeStatus ?? "unknown"}`);
					out.push(`Branches: ${branch(pr.sourceRefName)} -> ${branch(pr.targetRefName)}`);
					out.push(`Author: ${who(pr.createdBy)}, created ${pr.creationDate}`);
					if (pr.reviewers?.length) {
						out.push("Reviewers:");
						for (const r of pr.reviewers) out.push(`- ${who(r)}: ${voteLabel[r.vote] ?? r.vote}${r.isRequired ? " (required)" : ""}`);
					}
					out.push("", "Description:", pr.description?.trim() || "(none)");

					const refs = await get<{ value: { id: string }[] }>(`${repoUrl}/pullRequests/${id}/workitems`, signal);
					if (refs.value.length) {
						const ids = refs.value.map((w) => w.id).join(",");
						const items = await get<{ value: any[] }>(
							`${projectUrl}/_apis/wit/workitems?ids=${ids}&fields=System.Title,System.State,System.WorkItemType`,
							signal,
						);
						out.push("", "Linked work items:");
						for (const w of items.value) {
							out.push(`- #${w.id} ${w.fields["System.WorkItemType"]} [${w.fields["System.State"]}] ${w.fields["System.Title"]}`);
						}
					}
					details = { ...details, id, status: pr.status };
					break;
				}

				case "pr_threads": {
					const id = needId();
					const data = await get<{ value: any[] }>(`${repoUrl}/pullRequests/${id}/threads`, signal);
					// Skip vote/push/policy notifications; keep human review comments.
					const threads = data.value.filter((t) => !t.isDeleted && t.comments?.some((c: any) => c.commentType !== "system"));
					out.push(`${threads.length} comment thread(s) on PR !${id}:`);
					for (const t of threads) {
						const ctxInfo = t.threadContext;
						const where = ctxInfo?.filePath ? `${ctxInfo.filePath}:${ctxInfo.rightFileStart?.line ?? ctxInfo.leftFileStart?.line ?? "?"}` : "(general)";
						out.push("", `Thread ${t.id} [${t.status ?? "unknown"}] ${where}`);
						for (const c of t.comments) {
							if (c.commentType === "system" || c.isDeleted) continue;
							out.push(`  ${who(c.author)}: ${String(c.content ?? "").replace(/\n/g, "\n    ")}`);
						}
					}
					details = { ...details, id, threads: threads.length };
					break;
				}

				case "pr_changes": {
					const id = needId();
					const iterations = await get<{ value: { id: number }[] }>(`${repoUrl}/pullRequests/${id}/iterations`, signal);
					const last = iterations.value.at(-1);
					if (!last) throw new Error(`PR !${id} has no iterations`);
					const data = await get<{ changeEntries: any[] }>(`${repoUrl}/pullRequests/${id}/iterations/${last.id}/changes?$top=2000`, signal);
					const files = data.changeEntries.filter((c) => !c.item?.isFolder);
					out.push(`${files.length} file(s) changed in PR !${id} (iteration ${last.id}):`);
					for (const c of files) out.push(`${c.changeType}\t${c.item?.path ?? c.originalPath}`);
					out.push("", "Read the files locally or run `git diff` against the target branch for the content.");
					details = { ...details, id, iteration: last.id, files: files.length };
					break;
				}

				case "work_item": {
					const id = needId();
					const w = await get<any>(`${orgUrl}/_apis/wit/workitems/${id}`, signal);
					const f = w.fields;
					out.push(`#${w.id} ${f["System.WorkItemType"]} [${f["System.State"]}] ${f["System.Title"]}`);
					out.push(`Assigned to: ${who(f["System.AssignedTo"])}`);
					if (f["System.Tags"]) out.push(`Tags: ${f["System.Tags"]}`);
					if (f["System.Description"]) out.push("", "Description:", htmlToText(f["System.Description"]));
					if (f["Microsoft.VSTS.Common.AcceptanceCriteria"]) {
						out.push("", "Acceptance criteria:", htmlToText(f["Microsoft.VSTS.Common.AcceptanceCriteria"]));
					}
					if (f["Microsoft.VSTS.TCM.ReproSteps"]) out.push("", "Repro steps:", htmlToText(f["Microsoft.VSTS.TCM.ReproSteps"]));
					details = { ...details, id, state: f["System.State"] };
					break;
				}
			}

			const truncation = truncateHead(out.join("\n"), { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			let text = truncation.content;
			if (truncation.truncated) text += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines shown.]`;
			return { content: [{ type: "text", text }], details };
		},
	});
}
