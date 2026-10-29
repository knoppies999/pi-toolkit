import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDiagnostic, mergeRuns, parseMsBuildDiagnostics, parseTrx } from "../extensions/dotnet/parse.ts";

const buildOutput = String.raw`
C:\repo\src\Api\OrdersController.cs(42,17): error CS0103: The name 'ordr' does not exist in the current context [C:\repo\src\Api\Api.csproj]
C:\repo\src\Api\Program.cs(8,1): warning CS8600: Converting null literal or possible null value to non-nullable type. [C:\repo\src\Api\Api.csproj]
MSBUILD : error MSB1009: Project file does not exist.
C:\repo\src\Api\OrdersController.cs(42,17): error CS0103: The name 'ordr' does not exist in the current context [C:\repo\src\Api\Api.csproj]
Build FAILED.
`;

test("parses and dedupes MSBuild diagnostics", () => {
	const ds = parseMsBuildDiagnostics(buildOutput, process.platform === "win32" ? "C:\\repo" : undefined);
	assert.equal(ds.length, 3);
	assert.deepEqual(
		ds.map((d) => [d.severity, d.code, d.line]),
		[
			["error", "CS0103", 42],
			["warning", "CS8600", 8],
			["error", "MSB1009", undefined],
		],
	);
	assert.equal(ds[2].file, undefined);
	if (process.platform === "win32") {
		assert.equal(formatDiagnostic(ds[0]), "src\\Api\\OrdersController.cs(42,17): error CS0103: The name 'ordr' does not exist in the current context");
	}
});

const trx = `<?xml version="1.0" encoding="utf-8"?>
<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult testId="1" testName="Orders.Total_IsSum" outcome="Passed" />
    <UnitTestResult testId="2" testName="Orders.Discount_&lt;10&gt;" outcome="Failed">
      <Output>
        <ErrorInfo>
          <Message>Assert.Equal() Failure&#xD;
Expected: 90
Actual:   100</Message>
          <StackTrace>   at Orders.Discount() in C:\\repo\\tests\\OrdersTests.cs:line 21</StackTrace>
        </ErrorInfo>
      </Output>
    </UnitTestResult>
  </Results>
  <ResultSummary outcome="Failed">
    <Counters total="3" executed="2" passed="1" failed="1" notExecuted="1" />
  </ResultSummary>
</TestRun>`;

test("parses TRX counts and failures", () => {
	const run = parseTrx(trx);
	assert.equal(run.total, 3);
	assert.equal(run.passed, 1);
	assert.equal(run.failed, 1);
	assert.equal(run.skipped, 1);
	assert.equal(run.failures.length, 1);
	assert.equal(run.failures[0].name, "Orders.Discount_<10>");
	assert.match(run.failures[0].message!, /Expected: 90/);
	assert.match(run.failures[0].stackTrace!, /OrdersTests.cs:line 21/);
});

test("merges runs from several test projects", () => {
	const merged = mergeRuns([parseTrx(trx), parseTrx(trx)]);
	assert.equal(merged.total, 6);
	assert.equal(merged.failures.length, 2);
});
