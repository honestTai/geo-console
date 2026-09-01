import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { geoPaths } from "@geo/core";

type ArtifactBody = string | Uint8Array;

const mode = process.env.GEO_OBJECT_STORE?.trim().toLowerCase() === "s3" ? "s3" : "local";
const bucket = process.env.GEO_S3_BUCKET?.trim() || "";

function normalizedKey(key: string): string {
	const value = key.replaceAll("\\", "/").replace(/^\/+/, "");
	if (!value || value.split("/").some((part) => part === ".." || part === ".")) throw new Error("非法证据对象路径");
	return value;
}

function localPath(key: string): string {
	const root = resolve(geoPaths.artifacts);
	const absolute = resolve(root, normalizedKey(key));
	if (!absolute.startsWith(`${root}${sep}`)) throw new Error("非法证据对象路径");
	return absolute;
}

function s3Client(): S3Client {
	if (!bucket) throw new Error("GEO_OBJECT_STORE=s3 时必须配置 GEO_S3_BUCKET");
	const accessKeyId = process.env.GEO_S3_ACCESS_KEY_ID?.trim();
	const secretAccessKey = process.env.GEO_S3_SECRET_ACCESS_KEY?.trim();
	if (Boolean(accessKeyId) !== Boolean(secretAccessKey))
		throw new Error("S3 Access Key 与 Secret Key 必须同时配置，或同时省略以使用实例角色");
	return new S3Client({
		region: process.env.GEO_S3_REGION?.trim() || "auto",
		endpoint: process.env.GEO_S3_ENDPOINT?.trim() || undefined,
		forcePathStyle: process.env.GEO_S3_FORCE_PATH_STYLE === "true",
		credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
	});
}

export function artifactContentType(key: string): string {
	switch (extname(key).toLowerCase()) {
		case ".json":
			return "application/json; charset=utf-8";
		case ".html":
			return "text/html; charset=utf-8";
		case ".pdf":
			return "application/pdf";
		case ".docx":
			return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
		case ".png":
			return "image/png";
		default:
			return "application/octet-stream";
	}
}

export async function putArtifact(
	key: string,
	body: ArtifactBody,
	contentType = artifactContentType(key),
): Promise<string> {
	const objectKey = normalizedKey(key);
	if (mode === "s3") {
		await s3Client().send(
			new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: body, ContentType: contentType, IfNoneMatch: "*" }),
		);
		return objectKey;
	}
	const absolute = localPath(objectKey);
	await mkdir(dirname(absolute), { recursive: true });
	await writeFile(absolute, body, { flag: "wx" });
	return objectKey;
}

export async function readArtifact(
	key: string,
): Promise<{ body: Uint8Array; contentType: string; contentLength: number }> {
	const objectKey = normalizedKey(key);
	if (mode === "s3") {
		const result = await s3Client().send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
		if (!result.Body) throw new Error("证据对象没有正文");
		const body = await result.Body.transformToByteArray();
		return {
			body,
			contentType: result.ContentType ?? artifactContentType(objectKey),
			contentLength: result.ContentLength ?? body.byteLength,
		};
	}
	const absolute = localPath(objectKey);
	const [body, info] = await Promise.all([readFile(absolute), stat(absolute)]);
	return { body, contentType: artifactContentType(objectKey), contentLength: info.size };
}

export async function artifactExists(key: string): Promise<boolean> {
	const objectKey = normalizedKey(key);
	if (mode === "s3") {
		try {
			await s3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
			return true;
		} catch (error) {
			const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
			if (status === 404 || (error as { name?: string }).name === "NotFound") return false;
			throw error;
		}
	}
	try {
		await stat(localPath(objectKey));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export async function checkObjectStore(): Promise<{ mode: "local" | "s3"; ok: true }> {
	if (mode === "s3") await s3Client().send(new HeadBucketCommand({ Bucket: bucket }));
	else await mkdir(geoPaths.artifacts, { recursive: true });
	return { mode, ok: true };
}
