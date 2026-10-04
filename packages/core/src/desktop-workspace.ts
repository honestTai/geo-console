import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const workspaceManifestSchema = z
	.object({
		format: z.literal("geo.desktop-workspace.sqlite.v1"),
		files: z
			.array(
				z.object({
					path: z
						.string()
						.max(1024)
						.refine(
							(path) =>
								(path === "workspace.sqlite" || path.startsWith("artifacts/")) &&
								!/[\\:*?"<>|]/.test(path) &&
								![...path].some((character) => character.charCodeAt(0) < 32) &&
								path
									.split("/")
									.every(
										(p) =>
											p !== ".." &&
											p !== "." &&
											p !== "" &&
											!/[. ]$/.test(p) &&
											!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
									),
						),
					size: z
						.number()
						.int()
						.min(0)
						.max(512 * 1024 * 1024),
					chunks: z.array(digest).max(512),
				}),
			)
			.min(1)
			.max(10_000),
	})
	.strict()
	.superRefine((value, ctx) => {
		const names = value.files.map((file) => file.path.normalize("NFC").toLowerCase());
		if (new Set(names).size !== names.length || !names.includes("workspace.sqlite"))
			ctx.addIssue({ code: "custom", message: "工作区清单必须有唯一数据库与文件路径" });
		if (value.files.reduce((total, file) => total + file.size, 0) > 10 * 1024 ** 3)
			ctx.addIssue({ code: "custom", message: "工作区超过 10 GiB 上限" });
	});
export type WorkspaceManifest = z.infer<typeof workspaceManifestSchema>;
