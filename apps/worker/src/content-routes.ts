import type { IncomingMessage, ServerResponse } from "node:http";
import type { Database } from "@geo/core";
import { enqueueArticleQuality, getArticleQuality, reviewArticle, reviewArticleQuality } from "./article-quality";
import { exportArticles } from "./articles";
import type { Identity } from "./auth";
import { actorFromIdentity } from "./authorization";
import {
	getCustomerKnowledge,
	listCustomerKnowledge,
	reviewCustomerKnowledge,
	saveCustomerKnowledge,
} from "./customer-knowledge";
import { routeMatch } from "./http-routes";
import { parsePagination } from "./pagination";
import { projectOperations } from "./project-operations";
import {
	createPublicationOrder,
	getPublicationOrder,
	listPublicationChannels,
	listPublicationOrders,
	publicationAssignees,
	savePublicationChannel,
	transitionPublication,
	updatePublicationAssignment,
} from "./publications";
import { HttpInputError, json, readJson } from "./utils";

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Explicit HTTP dispatch mirrors the registered resource policies; business rules remain in services.
export async function handleContentRoutes(
	database: Database,
	request: IncomingMessage,
	response: ServerResponse,
	path: string,
	identity: Identity,
): Promise<boolean> {
	const actor = actorFromIdentity(identity),
		method = request.method ?? "GET",
		url = new URL(request.url ?? path, "http://localhost");
	const project = routeMatch(
		path,
		/^\/api\/projects\/([^/]+)\/(knowledge-assets|publication-channels|publications|publication-assignees|operations)$/,
	);
	if (project) {
		const [projectId, kind] = project;
		if (method === "GET") {
			const pagination = parsePagination(url);
			const result =
				kind === "knowledge-assets"
					? await listCustomerKnowledge(database, projectId, pagination, url.searchParams.get("status"))
					: kind === "publication-channels"
						? await listPublicationChannels(database, projectId, pagination)
						: kind === "publications"
							? await listPublicationOrders(database, projectId, pagination, {
									status: url.searchParams.get("status"),
									channelId: url.searchParams.get("channelId"),
									articleId: url.searchParams.get("articleId"),
								})
							: kind === "publication-assignees"
								? await publicationAssignees(database, projectId)
								: await projectOperations(database, projectId, identity);
			json(response, 200, result);
			return true;
		}
		if (method === "POST" && ["knowledge-assets", "publication-channels", "publications"].includes(kind)) {
			const body = await readJson(request);
			const result =
				kind === "knowledge-assets"
					? await saveCustomerKnowledge(database, projectId, null, body, actor)
					: kind === "publication-channels"
						? await savePublicationChannel(database, projectId, null, body, actor)
						: await createPublicationOrder(database, projectId, body, actor);
			json(response, 201, result);
			return true;
		}
	}
	const knowledge = routeMatch(path, /^\/api\/knowledge-assets\/([^/]+)(?:\/(review))?$/);
	if (knowledge) {
		if (method === "GET" && !knowledge[1]) {
			json(response, 200, await getCustomerKnowledge(database, knowledge[0]));
			return true;
		}
		if (method === "PUT" && !knowledge[1]) {
			const asset = await getCustomerKnowledge(database, knowledge[0]);
			json(
				response,
				200,
				await saveCustomerKnowledge(database, asset.project_id, asset.id, await readJson(request), actor),
			);
			return true;
		}
		if (method === "POST" && knowledge[1] === "review") {
			json(response, 200, await reviewCustomerKnowledge(database, knowledge[0], await readJson(request), actor));
			return true;
		}
	}
	const channel = routeMatch(path, /^\/api\/publication-channels\/([^/]+)$/);
	if (channel && method === "PUT") {
		const row = (
			await database.query<{ project_id: string }>("SELECT project_id FROM publication_channels WHERE id=$1", [
				channel[0],
			])
		).rows[0];
		if (!row) throw new HttpInputError("渠道不存在", 404);
		json(
			response,
			200,
			await savePublicationChannel(database, row.project_id, channel[0], await readJson(request), actor),
		);
		return true;
	}
	const order = routeMatch(path, /^\/api\/publications\/([^/]+)(?:\/(transition))?$/);
	if (order) {
		if (method === "GET" && !order[1]) {
			json(response, 200, await getPublicationOrder(database, order[0]));
			return true;
		}
		if (method === "PUT" && !order[1]) {
			json(response, 200, await updatePublicationAssignment(database, order[0], await readJson(request), actor));
			return true;
		}
		if (method === "POST" && order[1] === "transition") {
			json(response, 200, await transitionPublication(database, order[0], await readJson(request), actor));
			return true;
		}
	}
	const article = routeMatch(path, /^\/api\/articles\/([^/]+)\/(quality|review)$/);
	if (article) {
		if (method === "GET" && article[1] === "quality") {
			json(response, 200, await getArticleQuality(database, article[0]));
			return true;
		}
		if (method === "POST") {
			json(
				response,
				article[1] === "quality" ? 202 : 200,
				article[1] === "quality"
					? await enqueueArticleQuality(database, article[0], await readJson(request), actor)
					: await reviewArticle(database, article[0], await readJson(request), actor),
			);
			return true;
		}
	}
	const quality = routeMatch(path, /^\/api\/article-quality\/([^/]+)\/review$/);
	if (quality && method === "POST") {
		json(response, 200, await reviewArticleQuality(database, quality[0], await readJson(request), actor));
		return true;
	}
	const exported = routeMatch(path, /^\/api\/projects\/([^/]+)\/articles\/export$/);
	if (exported && method === "GET") {
		json(
			response,
			200,
			await exportArticles(database, exported[0], { articleIds: url.searchParams.getAll("articleId") }),
		);
		return true;
	}
	return false;
}
