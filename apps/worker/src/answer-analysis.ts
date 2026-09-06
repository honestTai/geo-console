import { randomUUID } from "node:crypto";
import type { ExecutionActor } from "@geo/authorization";
import { type Database, type FrozenBatchConfig, readEncryptedCredential } from "@geo/core";
import {
	ANSWER_ANALYSIS_VERSION,
	type AnswerAnalysisContract,
	type AnswerAnalysisView,
	answerAnalysisContractSchema,
	segmentAnswer,
	validateAnswerAnalysis,
} from "@geo/evidence";
import { answerAnalysisOutput, answerAnalysisRequest } from "./answer-analysis-model";
import { AccessDeniedError, authorizeAction, withAuthorizedAction } from "./authorization";
import { parseActor } from "./authorization/execution";
import { getHRouterConfig } from "./hrouter";
import { HttpInputError, parseJsonColumn, sha256, stableJson } from "./utils";

type Run = {
	id: string;
	organization_id: string;
	project_id: string;
	batch_id: string;
	capture_id: string;
	contract: AnswerAnalysisContract;
	contract_hash: string;
	input_hash: string;
	execution_actor: ExecutionActor;
	status: Exclude<AnswerAnalysisView["status"], "not_generated">;
	created_at: string;
	error_message: string | null;
};
type CaptureInput = Awaited<ReturnType<typeof captureInput>>;
async function captureInput(database: Database, batchId: string, captureId: string) {
	const row = (
		await database.query<{
			organization_id: string;
			project_id: string;
			answer_text: string | null;
			prompt_id: string;
			status: string;
			capture_mode: string;
			config: FrozenBatchConfig;
		}>(
			`SELECT c.project_id,c.answer_text,c.prompt_id,c.status,c.capture_mode,p.organization_id,b.config
	 FROM query_captures c JOIN experiment_batches b ON b.id=c.batch_id AND b.project_id=c.project_id
	 JOIN projects p ON p.id=c.project_id WHERE c.id=$1 AND c.batch_id=$2`,
			[captureId, batchId],
		)
	).rows[0];
	if (!row) throw new HttpInputError("回答不属于此批次", 404);
	if (row.status !== "complete" || row.capture_mode !== "llm_search_api" || !row.answer_text?.trim())
		throw new HttpInputError("只能分析已有完整原文的 API 回答");
	const config = parseJsonColumn(row.config);
	const question = config.prompts.find((prompt) => prompt.id === row.prompt_id)?.question;
	if (!question) throw new HttpInputError("回答的问题不在冻结配置中", 409);
	const brands = [
		{ id: row.project_id, name: config.project.name, aliases: config.project.aliases },
		...config.competitors,
	];
	const answer = row.answer_text;
	return {
		organizationId: row.organization_id,
		projectId: row.project_id,
		answer,
		question,
		brands,
		inputHash: sha256(stableJson({ answer, question, brands })),
	};
}

export async function enqueueAnswerAnalysis(
	database: Database,
	batchId: string,
	captureId: string,
	actor: ExecutionActor,
) {
	const source = await captureInput(database, batchId, captureId);
	segmentAnswer(source.answer); // Fail before scheduling or charging; never silently truncate.
	return withAuthorizedAction(database, actor, "answer.analysis.execute", source, async (tx) => {
		await tx.query("SELECT id FROM query_captures WHERE id=$1 FOR UPDATE", [captureId]);
		const existing = (
			await tx.query<{ id: string }>(
				"SELECT id FROM answer_analysis_runs WHERE capture_id=$1 AND status IN ('queued','running')",
				[captureId],
			)
		).rows[0];
		if (existing) return existing;
		const model = await getHRouterConfig(tx, source.organizationId);
		if (!model.model || !(await readEncryptedCredential(tx, "hrouter_api_key", source.organizationId)))
			throw new HttpInputError("请先在平台设置配置语义模型和机构密钥");
		const contract = answerAnalysisContractSchema.parse({
			version: ANSWER_ANALYSIS_VERSION,
			promptVersion: "answer-analysis.grounded.v1",
			segmenterVersion: "answer-segments.utf16.v1",
			validatorVersion: "answer-analysis.evidence.v1",
			modelId: model.model,
			modelRevision: null,
			endpoint: model.baseUrl,
		});
		const id = randomUUID();
		await tx.query(
			`INSERT INTO answer_analysis_runs(id,organization_id,project_id,batch_id,capture_id,contract,contract_hash,input_hash,execution_actor)
		 VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb)`,
			[
				id,
				source.organizationId,
				source.projectId,
				batchId,
				captureId,
				JSON.stringify(contract),
				sha256(stableJson(contract)),
				source.inputHash,
				JSON.stringify(actor),
			],
		);
		await tx.query("INSERT INTO jobs(id,type,payload,max_attempts) VALUES($1,'answer_analysis',$2::jsonb,2)", [
			`answer-analysis:${id}`,
			JSON.stringify({ analysisId: id }),
		]);
		await tx.query(
			`INSERT INTO audit_logs(id,organization_id,actor_user_id,action,target_type,target_id,metadata)
		 VALUES($1,$2,$3,'answer_analysis.request','capture',$4,$5::jsonb)`,
			[
				randomUUID(),
				source.organizationId,
				actor.kind === "user" ? actor.userId : null,
				captureId,
				JSON.stringify({ runId: id, batchId, version: contract.version }),
			],
		);
		return { id };
	});
}

export async function getAnswerAnalysis(
	database: Database,
	batchId: string,
	captureId: string,
	runId: string | null = null,
): Promise<AnswerAnalysisView> {
	const source = await captureInput(database, batchId, captureId);
	const latest = (
		await database.query<{ id: string }>(
			"SELECT id FROM answer_analysis_runs WHERE batch_id=$1 AND capture_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
			[batchId, captureId],
		)
	).rows[0];
	const row = (
		await database.query<
			Run & {
				result: AnswerAnalysisView["result"];
				validation: string[] | null;
				usage: AnswerAnalysisView["usage"];
				cost_micros: number | null;
			}
		>(
			`SELECT r.*,a.result,a.validation,a.usage,a.cost_micros FROM answer_analysis_runs r
		 LEFT JOIN answer_analysis_attempts a ON a.id=r.selected_attempt_id AND a.run_id=r.id
		 WHERE r.id=$1 AND r.batch_id=$2 AND r.capture_id=$3`,
			[runId ?? latest?.id ?? null, batchId, captureId],
		)
	).rows[0];
	if (runId && !row) throw new HttpInputError("分析记录不属于此回答", 404);
	const base = {
		question: source.question,
		answerHash: sha256(source.answer),
		brands: source.brands.map(({ id, name }) => ({ id, name })),
		latestRunId: latest?.id ?? null,
	};
	if (!row)
		return {
			...base,
			id: null,
			status: "not_generated",
			createdAt: null,
			contract: null,
			inputHash: null,
			result: null,
			issues: [],
			error: null,
			usage: null,
			costMicros: null,
			previousRunId: null,
		};
	const previous = (
		await database.query<{ id: string }>(
			"SELECT id FROM answer_analysis_runs WHERE capture_id=$1 AND (created_at,id)<($2::timestamptz,$3) ORDER BY created_at DESC,id DESC LIMIT 1",
			[captureId, row.created_at, row.id],
		)
	).rows[0];
	const { endpoint: _endpoint, ...contract } = answerAnalysisContractSchema.parse(parseJsonColumn(row.contract));
	const sameInput = source.inputHash === row.input_hash;
	return {
		...base,
		id: row.id,
		status: sameInput ? row.status : "failed",
		createdAt: row.created_at,
		contract,
		inputHash: row.input_hash,
		result: sameInput && row.result ? parseJsonColumn(row.result) : null,
		issues: row.validation ? parseJsonColumn(row.validation) : [],
		error: sameInput ? row.error_message : "分析输入与已存原文不一致，结果不可用",
		usage: row.usage ? parseJsonColumn(row.usage) : null,
		costMicros: row.cost_micros ?? null,
		previousRunId: previous?.id ?? null,
	};
}

function modelUsage(raw: Record<string, unknown>): AnswerAnalysisView["usage"] {
	if (!raw.usage || typeof raw.usage !== "object") return null;
	const usage = raw.usage as Record<string, unknown>;
	const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
	return {
		inputTokens: number(usage.input_tokens),
		outputTokens: number(usage.output_tokens),
		totalTokens: number(usage.total_tokens),
	};
}

async function authorizeRun(database: Database, run: Run, source: CaptureInput) {
	if (
		source.inputHash !== run.input_hash ||
		source.organizationId !== run.organization_id ||
		source.projectId !== run.project_id
	)
		throw new HttpInputError("分析输入或归属与冻结记录不一致", 409);
	return authorizeAction(database, parseActor(run.execution_actor), "answer.analysis.execute", source);
}

export async function runOneAnswerAnalysisJob(database: Database, owner: string): Promise<boolean> {
	const job = (
		await database.query<{ id: string; attempts: number; max_attempts: number; payload: { analysisId: string } }>(
			`WITH candidate AS (SELECT id FROM jobs WHERE type='answer_analysis' AND attempts<max_attempts AND available_at<=now()
		 AND (status='pending' OR (status='leased' AND lease_expires_at<now())) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
		 UPDATE jobs SET status='leased',attempts=attempts+1,lease_owner=$1,lease_expires_at=now()+interval '5 minutes',updated_at=now()
		 WHERE id=(SELECT id FROM candidate) RETURNING id,attempts,max_attempts,payload`,
			[owner],
		)
	).rows[0];
	if (!job) return false;
	job.payload = parseJsonColumn(job.payload);
	const controller = new AbortController();
	const heartbeat = setInterval(
		() =>
			void database
				.query(
					"UPDATE jobs SET lease_expires_at=now()+interval '5 minutes' WHERE id=$1 AND lease_owner=$2 AND status='leased' AND lease_expires_at>now()",
					[job.id, owner],
				)
				.then((result) => {
					if (!result.affectedRows) controller.abort();
				})
				.catch(() => controller.abort()),
		30_000,
	);
	let run: Run | undefined;
	let raw: Record<string, unknown> = {};
	let requested = false;
	let recorded = false;
	const attemptId = randomUUID();
	const saveAttempt = async (validation: ReturnType<typeof validateAnswerAnalysis>) => {
		const attemptRun = run;
		if (!attemptRun) return;
		await database.transaction(async (tx) => {
			const inserted = await tx.query(
				`INSERT INTO answer_analysis_attempts(id,run_id,attempt,status,result,validation,raw_response,usage)
			 VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb) ON CONFLICT(run_id,attempt) DO NOTHING RETURNING id`,
				[
					attemptId,
					attemptRun.id,
					job.attempts,
					validation.status,
					JSON.stringify(validation.result),
					JSON.stringify(validation.issues),
					JSON.stringify(raw),
					JSON.stringify(modelUsage(raw)),
				],
			);
			if (inserted.affectedRows && requested)
				await tx.query(
					`INSERT INTO project_costs(id,project_id,batch_id,provider_id,operation,usage,cost_micros)
			 VALUES($1,$2,$3,'hrouter_gpt','answer_analysis',$4::jsonb,NULL)`,
					[randomUUID(), attemptRun.project_id, attemptRun.batch_id, JSON.stringify(modelUsage(raw))],
				);
		});
		recorded = true;
	};
	try {
		run = (await database.query<Run>("SELECT * FROM answer_analysis_runs WHERE id=$1", [job.payload.analysisId]))
			.rows[0];
		if (!run) throw new HttpInputError("分析任务不存在", 404);
		run.contract = answerAnalysisContractSchema.parse(parseJsonColumn(run.contract));
		if (sha256(stableJson(run.contract)) !== run.contract_hash) throw new HttpInputError("分析契约校验失败", 409);
		const source = await captureInput(database, run.batch_id, run.capture_id);
		await authorizeRun(database, run, source);
		const body = answerAnalysisRequest(run.contract, source.answer, source.question, source.brands);
		const key = await readEncryptedCredential(database, "hrouter_api_key", run.organization_id);
		if (!key) throw new HttpInputError("机构语义模型密钥不可用");
		await database.query(
			"UPDATE answer_analysis_runs SET status='running',updated_at=now() WHERE id=$1 AND status IN ('queued','running')",
			[run.id],
		);
		await authorizeRun(database, run, source);
		requested = true;
		const response = await fetch(`${run.contract.endpoint.replace(/\/$/, "")}/responses`, {
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
		});
		const value = await response.json();
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("模型未返回 JSON 对象");
		raw = value;
		if (!response.ok) throw new Error(`模型请求失败 HTTP ${response.status}`);
		const validation = validateAnswerAnalysis(answerAnalysisOutput(raw), source.answer, source.brands);
		await saveAttempt(validation);
		const completedRunId = run.id;
		await withAuthorizedAction(
			database,
			parseActor(run.execution_actor),
			"answer.analysis.execute",
			source,
			async (tx) => {
				const committed = await tx.query(
					"UPDATE jobs SET status='complete',lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=now() WHERE id=$1 AND lease_owner=$2 AND status='leased' AND lease_expires_at>now() RETURNING id",
					[job.id, owner],
				);
				if (!committed.affectedRows) throw new Error("分析任务租约已失效");
				await tx.query(
					"UPDATE answer_analysis_runs SET status=$2,selected_attempt_id=$3,error_message=NULL,completed_at=now(),updated_at=now() WHERE id=$1",
					[completedRunId, validation.status === "valid" ? "ready" : validation.status, attemptId],
				);
			},
		);
	} catch (error) {
		const detail =
			error instanceof HttpInputError ? error.message : "模型请求、结构化响应或执行租约失败；可重试完整分析";
		if (run && !recorded) await saveAttempt({ status: "failed", issues: [detail], result: null });
		const terminal =
			error instanceof HttpInputError || error instanceof AccessDeniedError || job.attempts >= job.max_attempts;
		await database.transaction(async (tx) => {
			const changed = await tx.query(
				`UPDATE jobs SET status=$3::job_status,lease_owner=NULL,lease_expires_at=NULL,last_error=$4,available_at=now()+interval '30 seconds',updated_at=now()
			 WHERE id=$1 AND lease_owner=$2 AND status='leased' AND lease_expires_at>now() RETURNING id`,
				[job.id, owner, terminal ? "failed" : "pending", detail],
			);
			if (changed.affectedRows && run)
				await tx.query(
					"UPDATE answer_analysis_runs SET status=$2,error_message=$3,completed_at=CASE WHEN $2='failed' THEN now() ELSE NULL END,updated_at=now() WHERE id=$1",
					[run.id, terminal ? "failed" : "queued", detail],
				);
		});
	} finally {
		clearInterval(heartbeat);
	}
	return true;
}
