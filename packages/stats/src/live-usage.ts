/**
 * Live provider quota for the Providers page (`GET /api/usage`).
 *
 * The omp host registers a provider through `startServer` that reads its
 * session's cached `/usage` path; standalone `omp-stats` has none and reports
 * `available: false`. The dashboard never forces a refresh: caching, failure
 * backoff and in-flight dedupe stay with the host's usage layer.
 */
import { resolveUsedFraction, type UsageReport } from "@oh-my-pi/pi-ai/usage";
import type { LiveUsageLimit, LiveUsageReport, LiveUsageResponse } from "./shared-types";

/**
 * Host usage source. Resolves `null` when the host has no usage reporting
 * configured; must honor `signal` where it can (the dashboard stops waiting
 * on abort either way).
 */
export type StatsUsageProvider = (signal: AbortSignal) => Promise<UsageReport[] | null>;

/** Longest a dashboard request waits on the host before answering with a timeout. */
export const LIVE_USAGE_TIMEOUT_MS = 5_000;

let usageProvider: StatsUsageProvider | undefined;

/** Register (or replace) the host usage source. Called by `startServer`. */
export function setStatsUsageProvider(provider: StatsUsageProvider | undefined): void {
	usageProvider = provider;
}

/**
 * Read live quota through the registered provider, giving up after
 * `timeoutMs` or when `signal` aborts. Rejects with the abort reason (a
 * `TimeoutError` `DOMException` on timeout) or the provider's own error.
 */
export async function getLiveUsage(
	signal?: AbortSignal,
	timeoutMs = LIVE_USAGE_TIMEOUT_MS,
): Promise<LiveUsageResponse> {
	const provider = usageProvider;
	if (!provider) return { available: false, reports: [], fetchedAt: null };

	const timeout = AbortSignal.timeout(timeoutMs);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	combined.throwIfAborted();
	// The provider may share one in-flight fetch across callers and ignore our
	// signal, so stop waiting on abort instead of relying on it to reject.
	const aborted = Promise.withResolvers<never>();
	const onAbort = () => aborted.reject(combined.reason);
	combined.addEventListener("abort", onAbort, { once: true });
	const pending = provider(combined);
	// A provider failure that lands after we stopped waiting has no listener left.
	pending.catch(() => {});
	let reports: UsageReport[] | null;
	try {
		reports = await Promise.race([pending, aborted.promise]);
	} catch (error) {
		// Abort-aware providers reject with their own error; report the timeout uniformly.
		if (timeout.aborted) throw timeout.reason;
		throw error;
	} finally {
		combined.removeEventListener("abort", onAbort);
	}

	if (!reports) return { available: false, reports: [], fetchedAt: null };
	// Whitelist display fields: drops the provider's `raw` payload and reset-credit internals.
	const live = reports.map((report): LiveUsageReport => ({
		provider: report.provider,
		fetchedAt: report.fetchedAt,
		limits: report.limits.map((limit): LiveUsageLimit => ({
			...limit,
			amount: { ...limit.amount, usedFraction: resolveUsedFraction(limit) },
		})),
		...(report.notes ? { notes: report.notes } : {}),
		...(report.metadata ? { metadata: report.metadata } : {}),
	}));
	const fetchedAt = live.length > 0 ? Math.max(...live.map(report => report.fetchedAt)) : null;
	return { available: true, reports: live, fetchedAt };
}
