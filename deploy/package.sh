#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
readonly OUTPUT_DIR="${1:-$REPO_DIR/dist}"
readonly SERVER_PLATFORM="${GEO_SERVER_PLATFORM:-linux/amd64}"
readonly WORKER_BASE_IMAGE="${GEO_WORKER_BASE_IMAGE:-geo-console-worker-base:node24-playwright1234}"
readonly REUSE_SERVER_BUNDLE="${GEO_REUSE_SERVER_BUNDLE:-}"

sha256_file() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{ print $1 }'
	else
		shasum -a 256 "$1" | awk '{ print $1 }'
	fi
}

manifest_value() {
	local manifest="$1"
	local key="$2"
	awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$manifest"
}

inside_work_tree="$(git -C "$REPO_DIR" rev-parse --is-inside-work-tree 2>/dev/null || true)"
repo_prefix="$(git -C "$REPO_DIR" rev-parse --show-prefix 2>/dev/null || true)"
[[ "$inside_work_tree" == "true" && -z "$repo_prefix" ]] || {
	printf 'deploy/package.sh must run from the local source checkout\n' >&2
	exit 1
}
[[ ! -e "$REPO_DIR/.geo-release" ]] || {
	printf 'Refusing to package from an extracted server release\n' >&2
	exit 1
}
command -v corepack >/dev/null 2>&1 || { printf 'corepack is required\n' >&2; exit 1; }
[[ "$SERVER_PLATFORM" =~ ^linux/(amd64|arm64)$ ]] || {
	printf 'GEO_SERVER_PLATFORM must be linux/amd64 or linux/arm64\n' >&2
	exit 1
}
if [[ -z "$REUSE_SERVER_BUNDLE" ]]; then
	command -v docker >/dev/null 2>&1 || { printf 'Docker is required to build Linux server artifacts locally\n' >&2; exit 1; }
	docker info >/dev/null 2>&1 || { printf 'Docker daemon is not available\n' >&2; exit 1; }
	docker buildx version >/dev/null 2>&1 || { printf 'Docker Buildx is required\n' >&2; exit 1; }
else
	[[ -f "$REUSE_SERVER_BUNDLE" ]] || { printf 'GEO_REUSE_SERVER_BUNDLE must name an existing .run file\n' >&2; exit 1; }
	[[ -f "$REUSE_SERVER_BUNDLE.sha256" ]] || { printf 'Reused release checksum file is missing\n' >&2; exit 1; }
fi
[[ "$WORKER_BASE_IMAGE" =~ ^[A-Za-z0-9._/-]+:[A-Za-z0-9._-]+$ ]] || {
	printf 'GEO_WORKER_BASE_IMAGE is invalid\n' >&2
	exit 1
}

stage_dir="$(mktemp -d)"
trap 'rm -rf -- "$stage_dir"' EXIT
mkdir -p "$stage_dir/payload" "$OUTPUT_DIR"

commit="$(git -C "$REPO_DIR" rev-parse --short=12 HEAD)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
release_id="$commit"
if [[ -n "$(git -C "$REPO_DIR" status --porcelain)" ]]; then release_id="$commit-dev-$timestamp"; fi

printf 'Building Web assets locally...\n'
(
	cd "$REPO_DIR"
	corepack pnpm --filter @geo/web build
)
[[ -s "$REPO_DIR/apps/web/dist/index.html" ]] || { printf 'Web dist is missing after build\n' >&2; exit 1; }

build_args=()
if [[ -n "${GEO_BUILD_PROXY:-}" ]]; then
	[[ "$GEO_BUILD_PROXY" =~ ^https?://[^[:space:]]+$ ]] || {
		printf 'GEO_BUILD_PROXY must be an HTTP(S) URL without whitespace\n' >&2
		exit 1
	}
	build_args+=(--build-arg "HTTP_PROXY=$GEO_BUILD_PROXY" --build-arg "HTTPS_PROXY=$GEO_BUILD_PROXY")
fi

server_artifact="$stage_dir/payload/server-runtime.tar"
if [[ -n "$REUSE_SERVER_BUNDLE" ]]; then
	runtime_paths=(
		package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json
		apps/worker/package.json apps/worker/tsconfig.json apps/worker/src
		apps/log-service/package.json apps/log-service/tsconfig.json apps/log-service/src
		packages/core/package.json packages/core/tsconfig.json packages/core/src packages/core/migrations
		packages/evidence/package.json packages/evidence/tsconfig.json packages/evidence/src
		packages/logging/package.json packages/logging/tsconfig.json packages/logging/src
		packages/metrics/package.json packages/metrics/tsconfig.json packages/metrics/src
		packages/search-providers/package.json packages/search-providers/tsconfig.json packages/search-providers/src
	)
	[[ -z "$(git -C "$REPO_DIR" status --porcelain -- "${runtime_paths[@]}")" ]] || {
		printf 'Refusing to reuse a server artifact because runtime inputs differ from HEAD\n' >&2
		exit 1
	}
	expected_bundle_sha256="$(awk 'NR == 1 { print $1 }' "$REUSE_SERVER_BUNDLE.sha256")"
	[[ "$expected_bundle_sha256" =~ ^[0-9a-f]{64}$ ]] || { printf 'Reused release checksum is invalid\n' >&2; exit 1; }
	[[ "$(sha256_file "$REUSE_SERVER_BUNDLE")" == "$expected_bundle_sha256" ]] || {
		printf 'Reused release bundle checksum does not match\n' >&2
		exit 1
	}
	reuse_archive_line="$(awk '/^__ARCHIVE_BELOW__$/ { print NR + 1; exit }' "$REUSE_SERVER_BUNDLE")"
	[[ -n "$reuse_archive_line" ]] || { printf 'Reused release payload marker is missing\n' >&2; exit 1; }
	mkdir -p "$stage_dir/reused"
	tail -n +"$reuse_archive_line" "$REUSE_SERVER_BUNDLE" | tar -xzf - -C "$stage_dir/reused"
	reuse_manifest="$stage_dir/reused/payload/.geo-release"
	reuse_artifact="$stage_dir/reused/payload/server-runtime.tar"
	[[ -f "$reuse_manifest" && -s "$reuse_artifact" ]] || { printf 'Reused release is missing its manifest or server artifact\n' >&2; exit 1; }
	[[ "$(manifest_value "$reuse_manifest" PACKAGE_MODE)" == "local-server-artifacts" ]] || { printf 'Reused release package mode is invalid\n' >&2; exit 1; }
	[[ "$(manifest_value "$reuse_manifest" SERVER_IMAGE_ACTION)" == "reconstruct" ]] || { printf 'Reused release image action is invalid\n' >&2; exit 1; }
	[[ "$(manifest_value "$reuse_manifest" GIT_COMMIT)" == "$commit" ]] || { printf 'Reused release was not built from the current Git commit\n' >&2; exit 1; }
	[[ "$(manifest_value "$reuse_manifest" SERVER_PLATFORM)" == "$SERVER_PLATFORM" ]] || { printf 'Reused release platform does not match the target\n' >&2; exit 1; }
	[[ "$(manifest_value "$reuse_manifest" WORKER_BASE_IMAGE)" == "$WORKER_BASE_IMAGE" ]] || { printf 'Reused release Worker base does not match\n' >&2; exit 1; }
	server_artifact_sha256="$(sha256_file "$reuse_artifact")"
	[[ "$server_artifact_sha256" == "$(manifest_value "$reuse_manifest" SERVER_ARTIFACT_SHA256)" ]] || {
		printf 'Reused server artifact checksum does not match its manifest\n' >&2
		exit 1
	}
	cp "$reuse_artifact" "$server_artifact"
	printf 'Reused verified %s server artifact from release %s.\n' "$SERVER_PLATFORM" "$(manifest_value "$reuse_manifest" RELEASE_ID)"
else
	printf 'Building Linux server packages locally for %s...\n' "$SERVER_PLATFORM"
	docker buildx build \
		--platform "$SERVER_PLATFORM" \
		--file "$REPO_DIR/docker/Dockerfile.artifacts" \
		--target export \
		--output "type=tar,dest=$server_artifact" \
		${build_args[@]+"${build_args[@]}"} \
		"$REPO_DIR"
	[[ -s "$server_artifact" ]] || { printf 'Linux server artifact is missing\n' >&2; exit 1; }
	server_artifact_sha256="$(sha256_file "$server_artifact")"
fi

(
	cd "$REPO_DIR"
	git ls-files --cached --others --exclude-standard -z -- \
		compose.yaml \
		deploy/install.sh \
		deploy/geo-console \
		docker/Dockerfile \
		docker/caddy \
		landing \
		LICENSE.md \
		THIRD_PARTY_NOTICES.md \
		| COPYFILE_DISABLE=1 tar --null -T - -cf -
) | tar -xf - -C "$stage_dir/payload"

mkdir -p "$stage_dir/payload/apps/web"
cp -R "$REPO_DIR/apps/web/dist" "$stage_dir/payload/apps/web/dist"

for script in deploy/install.sh deploy/geo-console; do
	file="$stage_dir/payload/$script"
	awk '{ sub(sprintf("%c", 13) "$", ""); print }' "$file" >"$file.lf"
	mv "$file.lf" "$file"
done

cat >"$stage_dir/payload/.geo-release" <<EOF
RELEASE_ID=$release_id
GIT_COMMIT=$commit
BUILT_AT=$timestamp
PACKAGE_MODE=local-server-artifacts
SERVER_IMAGE_ACTION=reconstruct
SERVER_PLATFORM=$SERVER_PLATFORM
SERVER_ARTIFACT=server-runtime.tar
SERVER_ARTIFACT_SHA256=$server_artifact_sha256
WORKER_BASE_IMAGE=$WORKER_BASE_IMAGE
EOF

[[ ! -e "$stage_dir/payload/.env" ]] || { printf 'Refusing to package .env\n' >&2; exit 1; }
[[ ! -e "$stage_dir/payload/secrets" ]] || { printf 'Refusing to package secrets\n' >&2; exit 1; }
[[ ! -e "$stage_dir/payload/.agents" ]] || { printf 'Refusing to package project skills\n' >&2; exit 1; }
[[ ! -e "$stage_dir/payload/deploy/package.sh" ]] || { printf 'Refusing to expose the local packager\n' >&2; exit 1; }
chmod +x "$stage_dir/payload/deploy/geo-console" "$stage_dir/payload/deploy/install.sh"

payload_archive="$stage_dir/payload.tar.gz"
COPYFILE_DISABLE=1 tar -czf "$payload_archive" -C "$stage_dir" payload

bundle_name="geo-console-$release_id.run"
bundle_path="$OUTPUT_DIR/$bundle_name"
cp "$stage_dir/payload/deploy/install.sh" "$bundle_path"
cat "$payload_archive" >>"$bundle_path"
chmod 700 "$bundle_path"

(
	cd "$OUTPUT_DIR"
	printf '%s  %s\n' "$(sha256_file "$bundle_path")" "$bundle_name" >"$bundle_name.sha256"
)

printf 'Release ID:      %s\n' "$release_id"
printf 'Server platform: %s\n' "$SERVER_PLATFORM"
printf 'Release bundle:  %s\n' "$bundle_path"
printf 'Checksum:        %s.sha256\n' "$bundle_path"
