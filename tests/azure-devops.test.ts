import assert from "node:assert/strict";
import { test } from "node:test";
import { htmlToText, parseAzureRemote } from "../extensions/azure-devops/remote.ts";

const expected = { orgUrl: "https://dev.azure.com/contoso", project: "My Project", repository: "web-api" };

test("parses dev.azure.com HTTPS remotes", () => {
	assert.deepEqual(parseAzureRemote("https://dev.azure.com/contoso/My%20Project/_git/web-api"), expected);
	assert.deepEqual(parseAzureRemote("https://contoso@dev.azure.com/contoso/My%20Project/_git/web-api\n"), expected);
});

test("parses visualstudio.com HTTPS remotes", () => {
	assert.deepEqual(parseAzureRemote("https://contoso.visualstudio.com/My%20Project/_git/web-api"), expected);
	assert.deepEqual(parseAzureRemote("https://contoso.visualstudio.com/DefaultCollection/My%20Project/_git/web-api"), expected);
});

test("parses SSH remotes", () => {
	assert.deepEqual(parseAzureRemote("git@ssh.dev.azure.com:v3/contoso/My%20Project/web-api"), expected);
	assert.deepEqual(parseAzureRemote("contoso@vs-ssh.visualstudio.com:v3/contoso/My%20Project/web-api"), expected);
});

test("returns undefined for other hosts", () => {
	assert.equal(parseAzureRemote("https://github.com/knoppies999/pi-toolkit.git"), undefined);
	assert.equal(parseAzureRemote("git@github.com:knoppies999/pi-toolkit.git"), undefined);
});

test("converts work item HTML to text", () => {
	assert.equal(htmlToText("<div>Given a cart</div><ul><li>When I pay</li><li>Then it&#39;s &amp; done</li></ul>"), "Given a cart\n- When I pay\n- Then it's & done");
});
