#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
readonly OUTPUT_DIR="${1:-$REPO_DIR/dist}"

stage_dir="$(mktemp -d)"
trap 'rm -rf -- "$stage_dir"' EXIT
mkdir -p "$stage_dir/payload" "$OUTPUT_DIR"

commit="$(git -C "$REPO_DIR" rev-parse --short=12 HEAD)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
release_id="$commit"
if [[ -n "$(git -C "$REPO_DIR" status --porcelain)" ]]; then release_id="$commit-dev-$timestamp"; fi

(
	cd "$REPO_DIR"
	git ls-files --cached --others --exclude-standard -z -- . ':(exclude)apps/desktop/**' | COPYFILE_DISABLE=1 tar --null -T - -cf -
) | tar -xf - -C "$stage_dir/payload"

# Windows checkouts may use CRLF. Release entrypoints run under Linux and must be LF.
for script in deploy/install.sh deploy/package.sh deploy/geo-console; do
	file="$stage_dir/payload/$script"
	[[ -f "$file" ]] || continue
	awk '{ sub(sprintf("%c", 13) "$", ""); print }' "$file" >"$file.lf"
	mv "$file.lf" "$file"
done

cat >"$stage_dir/payload/.geo-release" <<EOF
RELEASE_ID=$release_id
GIT_COMMIT=$commit
BUILT_AT=$timestamp
EOF

[[ ! -e "$stage_dir/payload/.env" ]] || { printf 'Refusing to package .env\n' >&2; exit 1; }
[[ ! -e "$stage_dir/payload/secrets" ]] || { printf 'Refusing to package secrets\n' >&2; exit 1; }
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
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$bundle_name" >"$bundle_name.sha256"
	else
		shasum -a 256 "$bundle_name" >"$bundle_name.sha256"
	fi
)

printf 'Release bundle: %s\n' "$bundle_path"
printf 'Checksum:       %s.sha256\n' "$bundle_path"
printf '\nUpload:\n  scp %q %q root@SERVER:/tmp/\n' "$bundle_path" "$bundle_path.sha256"
printf '\nInstall:\n  sudo bash /tmp/%q --domain demo.example.com --admin-email admin@example.com\n' "$bundle_name"
