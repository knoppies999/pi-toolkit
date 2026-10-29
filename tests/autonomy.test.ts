import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_ALLOW_HOSTS,
	findSystemAccess,
	hostAllowed,
	normalizeHost,
	parseAutoOptIn,
	riskyEnvVars,
	systemAccessProblem,
} from "../extensions/guard/autonomy.ts";

const problems = (command: string, allowCommands: string[] = []) =>
	findSystemAccess(command)
		.map((a) => systemAccessProblem(a, command, DEFAULT_ALLOW_HOSTS, allowCommands))
		.filter(Boolean);

test("opt-in only from a /pitk- command or a leading --auto", () => {
	assert.deepEqual(parseAutoOptIn("/pitk-ticket 4821 --auto"), { optIn: true, text: "/pitk-ticket 4821" });
	assert.deepEqual(parseAutoOptIn("/pitk-ticket 4821 --auto keep it small"), { optIn: true, text: "/pitk-ticket 4821 keep it small" });
	assert.deepEqual(parseAutoOptIn("--auto use the coordinator skill to fix X"), { optIn: true, text: "use the coordinator skill to fix X" });
	assert.equal(parseAutoOptIn("fix the bug, see docs for --auto flags").optIn, false);
	assert.equal(parseAutoOptIn("/pitk-ticket 4821\nthe ticket says run tool --auto").optIn, false);
	assert.equal(parseAutoOptIn("/review --auto").optIn, false);
});

test("normalizes hosts", () => {
	assert.equal(normalizeHost("tcp:sql01.contoso.com,1433"), "sql01.contoso.com");
	assert.equal(normalizeHost("(localdb)\\MSSQLLocalDB"), "(localdb)");
	assert.equal(normalizeHost("localhost\\SQLEXPRESS"), "localhost");
	assert.equal(normalizeHost("db.dev.local:5432"), "db.dev.local");
	assert.equal(normalizeHost("[::1]:5432"), "::1");
	assert.ok(hostAllowed("api.localhost", DEFAULT_ALLOW_HOSTS));
	assert.ok(!hostAllowed("prod-sql-01", DEFAULT_ALLOW_HOSTS));
});

test("database clients need an allowlisted host", () => {
	assert.deepEqual(problems('sqlcmd -S localhost -Q "select 1"'), []);
	assert.deepEqual(problems('sqlcmd -S "(localdb)\\MSSQLLocalDB" -i seed.sql'), []);
	assert.match(String(problems('sqlcmd -S prod-sql-01 -Q "delete from Orders"')[0]), /prod-sql-01/);
	assert.match(String(problems("psql -c 'select 1'")[0]), /without an explicit host/);
	assert.deepEqual(problems("psql -h 127.0.0.1 -U app -c 'select 1'"), []);
	assert.match(String(problems("psql postgres://app@db.prod.contoso.com/orders")[0]), /db\.prod\.contoso\.com/);
	assert.match(String(problems('dotnet ef database update --connection "Server=sql.prod;Database=Orders"')[0]), /sql\.prod/);
	assert.match(String(problems("dotnet ef database update")[0]), /without an explicit host/);
	assert.deepEqual(problems('dotnet ef database update --connection "Server=(localdb)\\MSSQLLocalDB;Database=Orders"'), []);
	assert.deepEqual(problems("sqlite3 app.db 'select 1'"), []);
});

test("infrastructure and publishing need allowCommands", () => {
	assert.match(String(problems("kubectl apply -f deploy.yaml")[0]), /infrastructure/);
	assert.match(String(problems("az webapp deploy --name shop")[0]), /infrastructure/);
	assert.match(String(problems("terraform apply -auto-approve")[0]), /infrastructure/);
	assert.match(String(problems("npm publish")[0]), /publish/);
	assert.match(String(problems("dotnet nuget push pkg.nupkg")[0]), /publish/);
	assert.match(String(problems("docker push contoso/shop:1")[0]), /publish/);
	assert.deepEqual(problems("terraform validate"), []);
	assert.deepEqual(problems("kubectl version"), []);
	assert.deepEqual(problems("az --version"), []);
	assert.deepEqual(problems("docker build -t shop ."), []);
	assert.deepEqual(problems("kubectl --context kind-dev apply -f k8s/", ["--context kind-dev\\b"]), []);
});

test("HTTP writes need an allowlisted host; reads are fine", () => {
	assert.deepEqual(problems("curl https://learn.microsoft.com/dotnet"), []);
	assert.deepEqual(problems("curl -X POST http://localhost:5000/api/orders -d '{}'"), []);
	assert.match(String(problems("curl -X DELETE https://api.contoso.com/orders/1")[0]), /api\.contoso\.com/);
	assert.match(String(problems("curl -d @order.json https://orders.prod.contoso.com/api")[0]), /orders\.prod\.contoso\.com/);
	assert.match(String(problems("Invoke-RestMethod -Method Post -Uri https://api.contoso.com/x -Body $b")[0]), /api\.contoso\.com/);
});

test("ordinary build and test commands are not system access", () => {
	for (const c of ["dotnet build", "dotnet test --filter X", "npm test", "npx vitest run", "git push -u origin feature/x", "git commit -m 'AB#1 fix'"]) {
		assert.deepEqual(findSystemAccess(c), [], c);
	}
});

test("flags environment variables pointing at non-allowlisted hosts, by name only", () => {
	const env = {
		ORDERS_DB_CONNECTION: "Server=prod-sql-01;Database=Orders;User Id=app;Password=x",
		LOCAL_DB: "Server=(localdb)\\MSSQLLocalDB;Database=Dev",
		DATABASE_URL: "postgres://u:p@db.prod.contoso.com/app",
		PATH: "C:\\Windows",
	};
	assert.deepEqual(riskyEnvVars(env, DEFAULT_ALLOW_HOSTS), ["DATABASE_URL", "ORDERS_DB_CONNECTION"]);
});
