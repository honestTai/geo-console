type ApprovedDraft = { batchId: string | null; purpose: string };
type Continuation<T> =
	| { status: "skipped"; workflow: null }
	| { status: "advanced"; workflow: T }
	| { status: "blocked"; workflow: null; error: unknown };

/** Approval is already committed. A separately authorized follow-up may fail, but must not turn approval into a false HTTP failure. */
export async function continueApprovedReport<T>(
	approved: ApprovedDraft,
	advance: (batchId: string) => Promise<T>,
): Promise<Continuation<T>> {
	if (!approved.batchId || !["report_narrative", "quality_review"].includes(approved.purpose))
		return { status: "skipped", workflow: null };
	try {
		return { status: "advanced", workflow: await advance(approved.batchId) };
	} catch (error) {
		return { status: "blocked", workflow: null, error };
	}
}
