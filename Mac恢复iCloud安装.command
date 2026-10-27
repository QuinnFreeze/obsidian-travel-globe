#!/bin/zsh
set -eu
setopt PIPE_FAIL
source_dir="${0:A:h}"
if (( $# == 1 )); then vault_dir="${1:A}"; else
 vault_dir=$(/usr/bin/osascript -e 'POSIX path of (choose folder with prompt "选择要恢复普通插件目录的 Obsidian 仓库")')
 vault_dir="${vault_dir:A}"
fi
target_dir="$vault_dir/.obsidian/plugins/travel-globe"
[[ -d "$vault_dir/.obsidian" && -L "$target_dir" ]] || { print -u2 '此仓库没有 Travel Globe 本地链接，无需恢复。'; exit 1; }
# Preserve current settings/cache, including changes since local installation.
original_local="${target_dir:A}"
staging_dir=$(/usr/bin/mktemp -d "$vault_dir/.obsidian/plugins/.travel-globe-restore.XXXXXX")
trap '/bin/rm -rf "$staging_dir"' EXIT
/usr/bin/ditto "${target_dir:A}" "$staging_dir"
(cd "$staging_dir" && LC_ALL=C /usr/bin/shasum -a 256 -c FILES.sha256)
/bin/rm "$target_dir" # Verified symlink only; never removes its local target.
if ! /bin/mv "$staging_dir" "$target_dir"; then
 /bin/ln -s "$original_local" "$target_dir"
 print -u2 '恢复失败，已重新连接本地插件。'; exit 1
fi
trap - EXIT
print '已恢复仓库内的普通插件目录。设置与卫星缓存保留；本地副本也保留。请重启 Obsidian。'
if (( $# == 0 )) && [[ -t 0 ]]; then read '?按回车关闭窗口。'; fi
