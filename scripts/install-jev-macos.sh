#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  printf '%s\n' 'This installer supports macOS only.' >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
install_root=${JEV_INSTALL_ROOT:-"$HOME/.local/share/jev-bridge"}
bin_dir=${JEV_BIN_DIR:-"$HOME/.local/bin"}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-root) install_root=$2; shift 2 ;;
    --bin-dir) bin_dir=$2; shift 2 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

node_path=$(command -v node || true)
npm_path=$(command -v npm || true)
if [ -z "$node_path" ] || [ -z "$npm_path" ]; then
  printf '%s\n' 'Node.js 20+ and npm are required.' >&2
  exit 1
fi
node_major=$($node_path -p 'Number(process.versions.node.split(".")[0])')
if [ "$node_major" -lt 20 ]; then
  printf '%s\n' 'Node.js 20 or newer is required.' >&2
  exit 1
fi

parent_dir=$(dirname -- "$install_root")
target_name=$(basename -- "$install_root")
mkdir -p "$parent_dir" "$bin_dir"
stage_dir=$(mktemp -d "$parent_dir/.${target_name}.staging.XXXXXX")
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_root=''
backup_jev=''
backup_mcp=''
committed=0
swapped=0
jev_installed=0
mcp_installed=0
jev_temp=''
mcp_temp=''
smoke_output=''

cleanup() {
  status=$?
  if [ "$committed" -eq 0 ]; then
    if [ -d "$stage_dir" ]; then rm -rf -- "$stage_dir"; fi
    if [ -n "$jev_temp" ] && [ -L "$jev_temp" ]; then rm -f -- "$jev_temp"; fi
    if [ -n "$mcp_temp" ] && [ -L "$mcp_temp" ]; then rm -f -- "$mcp_temp"; fi
    if [ -n "$smoke_output" ] && [ -f "$smoke_output" ]; then rm -f -- "$smoke_output"; fi
    if [ "$swapped" -eq 1 ] && [ -e "$install_root" ]; then
      mv -- "$install_root" "${install_root}.failed-$$"
    fi
    if [ -n "$backup_root" ] && [ -d "$backup_root" ] && [ ! -e "$install_root" ]; then
      mv -- "$backup_root" "$install_root"
    fi
    if [ -n "$backup_jev" ] && [ -e "$backup_jev" ]; then mv -f -- "$backup_jev" "$bin_dir/jev"; fi
    if [ -n "$backup_mcp" ] && [ -e "$backup_mcp" ]; then mv -f -- "$backup_mcp" "$bin_dir/jev-mcp"; fi
    if [ "$jev_installed" -eq 1 ] && [ -z "$backup_jev" ] && [ -e "$bin_dir/jev" ]; then
      mv -- "$bin_dir/jev" "$bin_dir/jev.failed-$$"
    fi
    if [ "$mcp_installed" -eq 1 ] && [ -z "$backup_mcp" ] && [ -e "$bin_dir/jev-mcp" ]; then
      mv -- "$bin_dir/jev-mcp" "$bin_dir/jev-mcp.failed-$$"
    fi
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

for item in package.json package-lock.json LICENSE README.md SKILL.md scripts tests docs examples; do
  cp -R "$source_root/$item" "$stage_dir/$item"
done
chmod 755 "$stage_dir/scripts/jev-cli.mjs" "$stage_dir/scripts/jev-mcp-server.mjs"

"$npm_path" ci --ignore-scripts --prefix "$stage_dir"
"$npm_path" test --prefix "$stage_dir"

if [ -e "$install_root" ]; then
  backup_root="${install_root}.backup-${timestamp}"
  if [ -e "$backup_root" ]; then
    printf 'Backup already exists: %s\n' "$backup_root" >&2
    exit 1
  fi
  mv -- "$install_root" "$backup_root"
fi
mv -- "$stage_dir" "$install_root"
swapped=1

if [ -e "$bin_dir/jev" ] || [ -L "$bin_dir/jev" ]; then
  backup_jev="$bin_dir/jev.backup-${timestamp}"
  mv -- "$bin_dir/jev" "$backup_jev"
fi
if [ -e "$bin_dir/jev-mcp" ] || [ -L "$bin_dir/jev-mcp" ]; then
  backup_mcp="$bin_dir/jev-mcp.backup-${timestamp}"
  mv -- "$bin_dir/jev-mcp" "$backup_mcp"
fi
jev_temp="$bin_dir/.jev.new.$$"
mcp_temp="$bin_dir/.jev-mcp.new.$$"
if [ -e "$jev_temp" ] || [ -e "$mcp_temp" ]; then
  printf '%s\n' 'Temporary launcher path already exists.' >&2
  exit 1
fi
ln -s "$install_root/scripts/jev-cli.mjs" "$jev_temp"
ln -s "$install_root/scripts/jev-mcp-server.mjs" "$mcp_temp"
mv -- "$jev_temp" "$bin_dir/jev"
jev_installed=1
mv -- "$mcp_temp" "$bin_dir/jev-mcp"
mcp_installed=1

# Verify the same stable symlink entries clients will execute. The MCP smoke only
# lists tools, so installation never reads a credential or sends a model request.
help_output=$("$bin_dir/jev" help)
case "$help_output" in
  *'"help"'*) ;;
  *) printf '%s\n' 'The installed jev symlink did not start the CLI.' >&2; exit 1 ;;
esac
smoke_output="$parent_dir/.${target_name}.mcp-smoke.$$"
"$node_path" "$install_root/scripts/jev-mcp-smoke.mjs" \
  --server "$bin_dir/jev-mcp" --list-only --output "$smoke_output" >/dev/null
rm -f -- "$smoke_output"

committed=1
trap - EXIT HUP INT TERM
printf '{"status":"installed","installRoot":"%s","jev":"%s","mcp":"%s","backup":"%s","credentialChanged":false}\n' \
  "$install_root" "$bin_dir/jev" "$bin_dir/jev-mcp" "$backup_root"
