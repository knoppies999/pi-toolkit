/**
 * Parse Azure DevOps git remote URLs. Pure, so it can be unit tested with `node --test`.
 */

export interface AzureRepo {
	/** Organization URL, e.g. https://dev.azure.com/contoso */
	orgUrl: string;
	project: string;
	repository: string;
}

/**
 * Supported forms:
 * - https://dev.azure.com/{org}/{project}/_git/{repo}
 * - https://{user}@dev.azure.com/{org}/{project}/_git/{repo}
 * - https://{org}.visualstudio.com/{project}/_git/{repo}  (also with DefaultCollection)
 * - git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
 * - {org}@vs-ssh.visualstudio.com:v3/{org}/{project}/{repo}
 */
export function parseAzureRemote(remote: string): AzureRepo | undefined {
	const url = remote.trim();
	const decode = (s: string) => decodeURIComponent(s);

	let m = url.match(/^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+?)(?:\.git)?\/?$/i);
	if (m) return { orgUrl: `https://dev.azure.com/${m[1]}`, project: decode(m[2]), repository: decode(m[3]) };

	m = url.match(/^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+?)(?:\.git)?\/?$/i);
	if (m) return { orgUrl: `https://dev.azure.com/${m[1]}`, project: decode(m[2]), repository: decode(m[3]) };

	m = url.match(/^(?:ssh:\/\/)?[^@]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)[:/]v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
	if (m) return { orgUrl: `https://dev.azure.com/${m[1]}`, project: decode(m[2]), repository: decode(m[3]) };

	return undefined;
}

/** Convert the HTML Azure DevOps stores in descriptions and comments to plain text. */
export function htmlToText(html: string): string {
	return html
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|li|h\d|tr)>/gi, "\n")
		.replace(/<li[^>]*>/gi, "- ")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
