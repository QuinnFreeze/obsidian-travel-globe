#!/bin/zsh
# Mac-only storage migration. Notes stay in the existing vault.
set -eu
setopt PIPE_FAIL
source_dir="${0:A:h}"
if (( $# > 1 )); then print -u2 '用法：Mac本地安装.command [仓库目录]'; exit 1; fi
if (( $# == 1 )); then
 vault_dir="${1:A}"
elif [[ "${source_dir:h:t}" == plugins && "${source_dir:h:h:t}" == .obsidian ]]; then
 vault_dir="${source_dir:h:h:h}"
else
 vault_dir=$(/usr/bin/osascript -e 'POSIX path of (choose folder with prompt "选择要保留旅行笔记的现有 Obsidian 仓库")')
 vault_dir="${vault_dir:A}"
fi
[[ -d "$vault_dir/.obsidian" ]] || { print -u2 '目录没有 .obsidian，请选择现有仓库。'; exit 1; }
(cd "$source_dir" && LC_ALL=C /usr/bin/shasum -a 256 -c FILES.sha256)
# A stable vault-specific directory; never place executable files in iCloud.
vault_key=$(print -rn -- "$vault_dir" | LC_ALL=C /usr/bin/shasum -a 256 | /usr/bin/cut -c 1-16)
local_dir="${TRAVEL_GLOBE_LOCAL_ROOT:-$HOME/Library/Application Support/Travel Globe}/$vault_key/travel-globe"
target_dir="$vault_dir/.obsidian/plugins/travel-globe"
/bin/mkdir -p "$local_dir" "$vault_dir/.obsidian/plugins"
files=(main.js manifest.json styles.css LICENSE THIRD_PARTY_NOTICES.md 安装说明.md 安装或修复.command Mac本地安装.command Mac恢复iCloud安装.command FILES.sha256 runtime-assets)
# Existing settings/cache are read before replacing the directory, and remain in the cloud backup.
if [[ -d "$target_dir" && "${target_dir:A}" != "${local_dir:A}" ]]; then
 if [[ -f "$target_dir/data.json" ]]; then /bin/cp "$target_dir/data.json" "$local_dir/data.json"; fi
 if [[ -d "$target_dir/satellite-cache" ]]; then /usr/bin/ditto "$target_dir/satellite-cache" "$local_dir/satellite-cache"; fi
fi
for file in "${files[@]}"; do
 if [[ "${source_dir:A}" != "${local_dir:A}" ]]; then /usr/bin/ditto "$source_dir/$file" "$local_dir/$file"; fi
done
/bin/chmod +x "$local_dir/"*.command
(cd "$local_dir" && LC_ALL=C /usr/bin/shasum -a 256 -c FILES.sha256)
if [[ -L "$target_dir" && "${target_dir:A}" == "${local_dir:A}" ]]; then
 print '已校验现有 Mac 本地安装。'
else
 backup_dir="$vault_dir/.obsidian/travel-globe-install-backups/$(/bin/date +%Y%m%d-%H%M%S)-$$"
 /bin/mkdir -p "$backup_dir"
 if [[ -e "$target_dir" || -L "$target_dir" ]]; then /bin/mv "$target_dir" "$backup_dir/travel-globe"; fi
 # Only this plugin gets a link; the rest of Obsidian and the vault remain unchanged.
 if ! /bin/ln -s "$local_dir" "$target_dir"; then
  if [[ -e "$backup_dir/travel-globe" || -L "$backup_dir/travel-globe" ]]; then /bin/mv "$backup_dir/travel-globe" "$target_dir"; fi
  print -u2 '链接创建失败，已恢复原插件目录。'; exit 1
 fi
fi
print 'Travel Globe 已保存在本机；请重启 Obsidian。旅行笔记与照片仍在原仓库。'
print '手机需单独安装普通插件目录；本机链接不能当作手机安装包。'
print "本地目录：$local_dir"
if (( $# == 0 )) && [[ -t 0 ]]; then read '?按回车关闭窗口。'; fi
