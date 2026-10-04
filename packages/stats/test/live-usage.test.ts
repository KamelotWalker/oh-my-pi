import { afterEach, describe, expect, it } from "bun:test";
import { setStatsUsageProvider } from "@oh-my-pi/omp-stats/live-usage";
import { handleApi } from "@oh-my-pi/omp-stats/server";
import type { LiveUsageResponse } from "@oh-my-pi/omp-stats/shared-types";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-live-usage-");

afterEach(() => {
	setStatsUsageProvider(undefined);
});

async function fetchUsage(): Promise<{ status: number; body: unknown }> {
	const response = await handleApi(new Request("http://stats.test/api/usage"));
	return { status: response.status, body: await response.json() };
}

describe("GET /api/usage", () => {
	it("reports unavailable when no host usage provider is registered", async () => {
		expect(await fetchUsage()).toEqual({
			status: 200,
			body: { available: false, reports: [], fetchedAt: null },
		});
	});

	it("serves host reports without raw payloads and with resolved used fractions", async () => {
		const reports: UsageReport[] = [
			{
				provider: "anthropic",
				fetchedAt: 1_000,
				limits: [
					{
						id: "anthropic:5h",
						label: "Claude 5 Hour",
						scope: { provider: "anthropic" },
						window: { id: "5h", label: "5 Hour", resetsAt: 9_000 },
						amount: { used: 30, limit: 120, unit: "requests" },
					},
				],
				metadata: { email: "a@example.com" },
				raw: { secretPayload: true },
			},
			{ provider: "openai-codex", fetchedAt: 2_000, limits: [], raw: "unparsed" },
		];
		setStatsUsageProvider(async () => reports);

		const { status, body } = await fetchUsage();
		expect(status).toBe(200);
		const usage = body as LiveUsageResponse;
		expect(usage.available).toBe(true);
		expect(usage.fetchedAt).toBe(2_000);
		expect(usage.reports.map(report => "raw" in report)).toEqual([false, false]);
		expect(usage.reports[0]?.metadata).toEqual({ email: "a@example.com" });
		expect(usage.reports[0]?.limits[0]?.amount.usedFraction).toBe(0.25);
	});

	it("maps a provider failure to a JSON error response", async () => {
		setStatsUsageProvider(async () => {
			throw new Error("usage endpoint returned 429");
		});

		expect(await fetchUsage()).toEqual({
			status: 502,
			body: { error: "Usage fetch failed: usage endpoint returned 429" },
		});
	});
});
