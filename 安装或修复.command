#!/bin/zsh
# Recoverable file transaction, not an atomic directory swap. SIGKILL/power loss
# cannot run traps: retain the lock, originals, inventory and journal for review.
set -eu
setopt PIPE_FAIL
umask 077
source_dir="${0:A:h}"
if (( $# > 1 )); then print -u2 '用法：安装或修复.command [仓库目录]'; exit 1; fi
if (( $# == 1 )); then
  vault_dir="$1"
elif [[ "${source_dir:h:t}" == plugins && "${source_dir:h:h:t}" == .obsidian ]]; then
  vault_dir="${source_dir:h:h:h}"
else
  vault_dir=$(/usr/bin/osascript -e 'POSIX path of (choose folder with prompt "选择要安装 Travel Globe 的 Obsidian 仓库")')
fi
vault_dir="${vault_dir:A}"
[[ -d "$vault_dir/.obsidian" ]] || { print -u2 '所选目录没有 .obsidian，请选择现有 Obsidian 仓库。'; exit 1; }
parent_dir="$vault_dir/.obsidian/plugins"
target_dir="$parent_dir/travel-globe"
lock_dir="$parent_dir/.travel-globe-install.lock"
required=(main.js manifest.json styles.css LICENSE THIRD_PARTY_NOTICES.md 安装说明.md 安装或修复.command Mac本地安装.command Mac恢复iCloud安装.command)
typeset -a reply=() new_files=() all_files=() changed=() created_dirs=()
typeset -A new_set present
transaction_dir='' staging_dir='' journal=''
integer lock_owned=0 mutation_started=0 committed=0

fail() { print -u2 -r -- "$*"; exit 1; }
# The generated release inventory permits ONLY these regular files and asset
# leaves. Never let an old/corrupt manifest select settings, ../ or symlinks.
read_inventory() {
  local root="$1" line rel component
  local -A seen
  reply=()
  [[ -f "$root/FILES.sha256" && ! -L "$root/FILES.sha256" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ '^[0-9a-f]{64}  .+$' ]] || return 1
    rel="${line[67,-1]}"
    [[ "$rel" != *$'\n'* && "$rel" != *$'\r'* && "$rel" != *'\'* ]] || return 1
    if [[ "$rel" != runtime-assets/* ]]; then
      (( ${required[(Ie)$rel]} )) || return 1
    fi
    for component in "${(@s:/:)rel}"; do
      [[ -n "$component" && "$component" != . && "$component" != .. ]] || return 1
    done
    [[ -z "${seen[$rel]-}" ]] || return 1
    seen[$rel]=1
    reply+=("$rel")
  done < "$root/FILES.sha256"
  for rel in "${required[@]}"; do [[ -n "${seen[$rel]-}" ]] || return 1; done
  (( ${#reply} > ${#required} )) || return 1
}
validate_bundle() {
  local root="$1" allow_unknown="${2:-no}" rel entry
  local -A listed
  read_inventory "$root" || return 1
  for rel in "${reply[@]}"; do
    listed[$rel]=1
    [[ -f "$root/$rel" && ! -L "$root/$rel" ]] || return 1
  done
  [[ -d "$root/runtime-assets" && ! -L "$root/runtime-assets" ]] || return 1
  # Refuse unlisted assets and links (including links in ancestor directories).
  for entry in "$root/runtime-assets"/**/*(DN); do
    [[ ! -L "$entry" ]] || return 1
    if [[ ! -d "$entry" ]]; then
      rel="${entry#$root/}"
      [[ -f "$entry" && ( -n "${listed[$rel]-}" || "$allow_unknown" == yes ) ]] || return 1
    fi
  done
  (cd "$root" && LC_ALL=C /usr/bin/shasum -a 256 -c FILES.sha256)
}
log() { print -r -- "$*" >> "$journal"; }
# Check the complete destination chain before copying ANY originals or changing
# anything. A symlink or directory at a managed file name is not overwritten.
check_destination() {
  local rel="$1" cursor="$target_dir" component
  [[ ! -L "$cursor" && ( ! -e "$cursor" || -d "$cursor" ) ]] || return 1
  for component in "${(@s:/:)rel}"; do
    cursor="$cursor/$component"
    [[ ! -L "$cursor" ]] || return 1
    if [[ "$cursor" == "$target_dir/$rel" ]]; then
      [[ ! -e "$cursor" || -f "$cursor" ]] || return 1
    else
      [[ ! -e "$cursor" || -d "$cursor" ]] || return 1
    fi
  done
}
ensure_directory() {
  local dir="$1"
  [[ -d "$dir" && ! -L "$dir" ]] && return 0
  [[ ! -e "$dir" && ! -L "$dir" ]] || return 1
  [[ "$dir" == "$target_dir" || "$dir" == "$target_dir/"* ]] || return 1
  [[ "$dir" == "$target_dir" ]] || ensure_directory "${dir:h}" || return 1
  # Record intent BEFORE mkdir, just like file replacement intent before mv.
  created_dirs+=("$dir")
  log "MKDIR $dir" || return 1
  /bin/mkdir "$dir"
}
rollback() {
  local rel dir
  integer failed=0 i
  log 'ROLLBACK_BEGIN' || failed=1
  for (( i=${#changed}; i>=1; --i )); do
    rel="${changed[$i]}"
    if [[ "${present[$rel]}" == yes ]]; then
      # Copy, never consume originals: even a partial rollback retains evidence.
      if /bin/cp -p "$transaction_dir/originals/$rel" "$target_dir/$rel" &&
         /usr/bin/cmp -s "$transaction_dir/originals/$rel" "$target_dir/$rel"; then
        log "RESTORED $rel" || failed=1
      else
        print -u2 -r -- "无法还原：$rel"
        failed=1
      fi
    else
      /bin/rm -f "$target_dir/$rel" || failed=1
      [[ ! -e "$target_dir/$rel" && ! -L "$target_dir/$rel" ]] || failed=1
      log "REMOVED_NEW $rel" || failed=1
    fi
  done
  for (( i=${#created_dirs}; i>=1; --i )); do
    dir="${created_dirs[$i]}"
    if [[ -d "$dir" ]]; then /bin/rmdir "$dir" || failed=1; fi
  done
  if (( failed )); then log 'ROLLBACK_FAILED' || :; return 1; fi
  log 'ROLLED_BACK' || return 1
  return 0
}
finish() {
  local rc=$?
  integer recovery_failed=0
  trap - EXIT
  trap '' INT TERM
  set +e
  if (( rc != 0 && mutation_started && ! committed )); then
    if rollback; then
      print -u2 '安装失败，已整体还原原有受管发布文件；用户数据未改写。'
    else
      recovery_failed=1
      rc=70
      print -u2 '回滚未完成！不要继续安装。备份、存在标记和事务日志已保留，锁未释放。'
    fi
  fi
  if [[ -n "$transaction_dir" && $rc != 0 ]]; then
    print -u2 -r -- "恢复记录：$transaction_dir（originals / inventory.tsv / journal.log）"
  fi
  # Keep stage as well on rollback failure; never erase the only recovery copy.
  if (( ! recovery_failed )) && [[ -n "$staging_dir" ]]; then
    /bin/rm -rf "$staging_dir" || { print -u2 -r -- "暂存清理失败：$staging_dir"; rc=74; }
  fi
  if (( lock_owned && ! recovery_failed )); then
    /bin/rm -f "$lock_dir/owner" && /bin/rmdir "$lock_dir" || { print -u2 -r -- "锁清理失败：$lock_dir"; rc=74; }
  fi
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

print '正在完整读取并校验发布文件；iCloud 占位文件需先下载…'
allow_local_extras=no
[[ "$source_dir" != "$target_dir" ]] || allow_local_extras=yes
validate_bundle "$source_dir" "$allow_local_extras" || fail '发布包不完整或校验失败，未修改目标发布文件。'
new_files=("${reply[@]}" FILES.sha256)
for rel in "${new_files[@]}"; do new_set[$rel]=1; done
[[ ! -L "$vault_dir/.obsidian" && ! -L "$parent_dir" ]] || fail '拒绝通过符号链接安装。'
/bin/mkdir -p "$parent_dir"
if ! /bin/mkdir "$lock_dir" 2>/dev/null; then
  fail "同一目标已有安装锁（也可能上次被强制中断），未自动抢锁：$lock_dir"
fi
lock_owned=1
print -r -- "pid=$$" > "$lock_dir/owner"
transaction_dir=$(/usr/bin/mktemp -d "$parent_dir/.travel-globe-transaction.XXXXXX")
staging_dir="$transaction_dir/staged"
journal="$transaction_dir/journal.log"
print -r -- "transaction=$transaction_dir" >> "$lock_dir/owner"
/bin/mkdir "$staging_dir" "$transaction_dir/originals"
log "PREPARING target=$target_dir source=$source_dir"
# Freeze a fully verified source before touching target, also for self-repair.
for rel in "${new_files[@]}"; do
  /bin/mkdir -p "$staging_dir/${rel:h}"
  /bin/cp -p "$source_dir/$rel" "$staging_dir/$rel"
done
validate_bundle "$staging_dir" || fail '暂存发布包校验失败；目标发布文件未修改。'
all_files=("${new_files[@]}")
# Only syntactically trusted, allowlisted old inventory may retire stale assets.
# A damaged old inventory is repairable; unknown old assets stay untouched.
if read_inventory "$target_dir"; then
  for rel in "${reply[@]}"; do
    [[ -n "${new_set[$rel]-}" ]] || all_files+=("$rel")
  done
fi
for rel in "${all_files[@]}"; do
  check_destination "$rel" || fail "目标类型或链接不安全，未修改发布文件：$rel"
done
: > "$transaction_dir/inventory.tsv"
for rel in "${all_files[@]}"; do
  if [[ -e "$target_dir/$rel" ]]; then
    present[$rel]=yes
    /bin/mkdir -p "$transaction_dir/originals/${rel:h}"
    /bin/cp -p "$target_dir/$rel" "$transaction_dir/originals/$rel"
    /usr/bin/cmp -s "$target_dir/$rel" "$transaction_dir/originals/$rel"
  else
    present[$rel]=no
  fi
  print -r -- "${present[$rel]}"$'\t'"$rel" >> "$transaction_dir/inventory.tsv"
done
log 'BACKUP_COMPLETE'
# Every affected original is now backed up and byte-compared. No release file
# can be mutated before this boundary; all intents precede their I/O operation.
mutation_started=1
for rel in "${all_files[@]}"; do
  destination="$target_dir/$rel"
  ensure_directory "${destination:h}"
  changed+=("$rel")
  log "REPLACE $rel (original=${present[$rel]})"
  if [[ -n "${new_set[$rel]-}" ]]; then
    /bin/mv -f "$staging_dir/$rel" "$target_dir/$rel"
  else
    /bin/rm -f "$target_dir/$rel"
  fi
done
log 'CHMOD'
/bin/chmod +x "$target_dir/安装或修复.command"
log 'FINAL_VERIFY'
# Verify manifest hashes, not an inventory equality check: unknown target assets
# are deliberately preserved in place and are not copied/re-written.
(cd "$target_dir" && LC_ALL=C /usr/bin/shasum -a 256 -c FILES.sha256)
log 'COMMITTED'
committed=1
print '发布文件已校验并保存。脚本不会关闭 Obsidian；请自行重启并启用 Travel Globe。'
print -r -- "旅行笔记、照片、data.json、缓存及未知文件保留。发布文件备份与事务日志：$transaction_dir"
print 'SIGKILL／掉电不能保证自动回滚；若遗留安装锁，请先核对恢复记录，不要直接重试。'
if (( $# == 0 )) && [[ -t 0 ]]; then read '?按回车关闭窗口。' || :; fi
