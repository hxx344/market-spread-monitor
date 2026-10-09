#!/usr/bin/env bash
# Install or upgrade from a complete script, including when invoked with curl | bash.
set -Eeuo pipefail

# These functions are inlined into install.sh so curl | bash and sudo retain them.
# The journal contains only allowlisted event identifiers and integer timestamps.
profile_init() {
  profile_enabled=0
  profile_reported=0
  profile_incomplete=0
  profile_owner=$BASHPID
  profile_dir=''
  profile_events=''
  if ! profile_dir=$(umask 077; mktemp -d "${1:-/tmp}/market-spread-profile.XXXXXXXX" 2>/dev/null); then
    printf '%s\n' '无法创建部署计时目录；继续安装。' >&2 || true
    return 0
  fi
  profile_events="$profile_dir/events.tsv"
  if ! (umask 077; : > "$profile_events") 2>/dev/null; then
    printf '%s\n' '无法创建部署计时记录；继续安装。' >&2 || true
    return 0
  fi
  profile_enabled=1
  return 0
}

profile_clock() {
  [[ ${profile_enabled:-0} == 1 ]] || return 0
  profile_clock_ms=''
  local uptime fraction
  if ! { IFS=' ' read -r uptime _ < /proc/uptime; } 2>/dev/null; then return 0; fi
  [[ "$uptime" =~ ^([0-9]+)\.([0-9]+)$ ]] || return 0
  fraction="${BASH_REMATCH[2]}000"
  profile_clock_ms=$((10#${BASH_REMATCH[1]} * 1000 + 10#${fraction:0:3}))
  return 0
}

profile_event() {
  [[ ${profile_enabled:-0} == 1 ]] || return 0
  local kind=${1:-} id=${2:-} value=${3:-0}
  case "$id" in
    preflight|startup_cleanup|system_packages|source_identity|node_runtime|source_download|fingerprints|fast_probe|service_setup|space_check|source_copy|config_check|deps_copy|artifact_copy|compiler_cache|build_workspace|deps_install|next_build|build_validate|permissions|unit_prepare|service_switch|health_check|success_record|final_cleanup|describe|rollback|exit_cleanup) ;;
    *) return 0 ;;
  esac
  case "$kind" in
    phase)
      [[ "$value" =~ ^[0-9]{1,3}$ ]] || return 0
      (( 10#$value <= 255 )) || return 0
      value=$((10#$value))
      ;;
    skip)
      case "$value" in unchanged|reused|not_needed|cache_unavailable|space_low) ;; *) return 0 ;; esac
      ;;
    *) return 0 ;;
  esac
  profile_clock
  if [[ ! ${profile_clock_ms:-} =~ ^[0-9]+$ ]]; then profile_incomplete=1; return 0; fi
  # One append keeps child-shell records together without copying shell state.
  if ! { printf '%s\t%s\t%s\t%s\n' "$kind" "$profile_clock_ms" "$id" "$value" >> "$profile_events"; } 2>/dev/null; then
    profile_incomplete=1
  fi
  return 0
}

profile_phase() {
  [[ ${profile_enabled:-0} == 1 ]] || return 0
  profile_event phase "${1:-}" "${2:-0}"
  return 0
}

profile_skip() {
  [[ ${profile_enabled:-0} == 1 ]] || return 0
  profile_event skip "${1:-}" "${2:-}"
  return 0
}

profile_report() {
  [[ ${profile_enabled:-0} == 1 && ${profile_reported:-0} == 0 ]] || return 0
  [[ ${profile_owner:-} == "$BASHPID" ]] || return 0
  profile_reported=1
  local status=${1:-0} end_ms summary="$profile_dir/summary.txt"
  [[ "$status" =~ ^[0-9]{1,3}$ ]] && (( 10#$status <= 255 )) || status=1
  status=$((10#$status))
  profile_clock
  end_ms=${profile_clock_ms:-}
  profile_enabled=0
  if [[ ! "$end_ms" =~ ^[0-9]+$ ]] || ! { printf 'end\t%s\t%s\t0\n' "$end_ms" "$status" >> "$profile_events"; } 2>/dev/null; then
    printf '%s\n' '无法完成部署计时记录；部署退出状态保持不变。' >&2 || true
    return 0
  fi
  if ! (umask 077; LC_ALL=C awk -F '\t' -v incomplete="${profile_incomplete:-0}" '
    function add(id, label) { order[++count] = id; names[id] = label }
    function close_phase(stamp, status, delta) {
      if (active == "") return
      delta = stamp - previous
      if (delta < 0) { delta = 0; incomplete = 1 }
      elapsed[active] += delta
      if (status != 0) { failed[active] = status; has_failure = 1 }
    }
    function state(id, text) {
      if (failed[id]) return "失败（退出码 " failed[id] "）"
      if (seen[id]) {
        text = "完成"
        if (skipped[id] != "") text = text "；部分跳过（" reasons[skipped[id]] "）"
        return text
      }
      if (skipped[id] != "") return "跳过（" reasons[skipped[id]] "）"
      return "未执行"
    }
    BEGIN {
      add("preflight", "参数与环境检查")
      add("startup_cleanup", "启动时清理")
      add("system_packages", "系统依赖")
      add("source_identity", "版本查询/本地源码打包")
      add("node_runtime", "Node.js 准备/校验")
      add("source_download", "源码下载/解包")
      add("fingerprints", "指纹/现有产物检查")
      add("fast_probe", "快速更新检查")
      add("service_setup", "服务账户与目录")
      add("space_check", "可用空间检查")
      add("source_copy", "源码复制")
      add("config_check", "配置检查")
      add("deps_copy", "依赖复制")
      add("artifact_copy", "构建产物复制")
      add("compiler_cache", "编译缓存恢复")
      add("build_workspace", "构建目录准备")
      add("deps_install", "项目依赖安装")
      add("next_build", "Next.js 构建（含类型检查）")
      add("build_validate", "构建结果验证")
      add("permissions", "文件权限设置")
      add("unit_prepare", "服务定义准备")
      add("service_switch", "服务切换与启动")
      add("health_check", "健康检查")
      add("success_record", "成功记录/容量统计")
      add("final_cleanup", "完成后清理")
      add("describe", "部署结果说明")
      add("rollback", "失败回退")
      add("exit_cleanup", "退出时清理")
      reasons["unchanged"] = "内容未变"
      reasons["reused"] = "已复用"
      reasons["not_needed"] = "无需执行"
      reasons["cache_unavailable"] = "无可用缓存"
      reasons["space_low"] = "空间不足"
    }
    $1 == "phase" && $2 ~ /^[0-9]+$/ && ($3 in names) && $4 ~ /^[0-9]+$/ {
      if (!started) { first = $2; started = 1 }
      close_phase($2, $4)
      active = $3; previous = $2; seen[active] = 1
      next
    }
    $1 == "skip" && ($3 in names) && ($4 in reasons) { skipped[$3] = $4; next }
    $1 == "end" && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ {
      exit_status = $3
      # Cleanup can succeed after an earlier phase failed. Preserve that label.
      close_phase($2, has_failure ? 0 : exit_status)
      total = started ? $2 - first : 0
      if (total < 0) { total = 0; incomplete = 1 }
      ended = 1
      active = ""
      next
    }
    END {
      if (!ended) exit 1
      print "部署阶段耗时（排他计时）"
      printf "总耗时：%.3f 秒\n", total / 1000
      printf "部署退出码：%d\n", exit_status
      if (incomplete) print "提示：部分计时记录不可用，耗时可能不完整。"
      print "秒数\t占比\t状态\t阶段"
      # There are only 28 fixed phases; stable selection avoids sort processes.
      for (row = 1; row <= count; row++) {
        best = ""
        for (i = 1; i <= count; i++) {
          id = order[i]
          if (!emitted[id] && (best == "" || elapsed[id] > elapsed[best])) best = id
        }
        if (row == 1) top = best
        emitted[best] = 1
        percent = total > 0 ? elapsed[best] * 100 / total : 0
        printf "%.3f\t%.2f%%\t%s\t%s [%s]\n", elapsed[best] / 1000, percent, state(best), names[best], best
      }
      if (started) printf "主要耗时：%s [%s]（%.3f 秒，%.2f%%）\n", names[top], top, elapsed[top] / 1000, (total > 0 ? elapsed[top] * 100 / total : 0)
      else print "主要耗时：无可用阶段记录"
    }
  ' "$profile_events" > "$summary") 2>/dev/null; then
    printf '%s\n' '无法生成部署计时汇总；部署退出状态保持不变。' >&2 || true
    return 0
  fi
  cat -- "$summary" || true
  printf '计时报告：%s\n' "$summary" || true
  return 0
}

log() { printf '\n%s\n' "$*"; }
die() { printf '\n安装失败：%s\n' "$*" >&2; exit 1; }
download() { curl --fail --silent --show-error --location --retry 3 --connect-timeout 20 --max-time 300 "$1" -o "$2"; }
digest() { sha256sum "$1" | cut -d ' ' -f 1; }
unit_fingerprint() { systemctl cat --no-pager market-spread-monitor.service | sha256sum | cut -d ' ' -f 1; }

reload_service_definition() {
  local changed=${1:-0}
  if (( changed )) || [[ $(systemctl show --property=NeedDaemonReload --value market-spread-monitor.service 2>/dev/null || true) != no ]]; then
    systemctl daemon-reload
  fi
}

enable_service() {
  # enabled-runtime also exits successfully, but does not survive a reboot.
  [[ $(systemctl is-enabled market-spread-monitor.service 2>/dev/null || true) == enabled ]] || systemctl enable market-spread-monitor.service
}

install_project_dependencies() {
  local profile=root-v1 status=0
  if [[ -f "$release/deploy/linux-dependencies.mjs" ]]; then
    profile=$("$runtime/bin/node" "$release/deploy/linux-dependencies.mjs" "$release" --kind)
  fi
  case "$profile" in
    linux-v1)
      log '安装 Linux 所需依赖；跳过其他平台的构建和开发工具。'
      # Keep source manifests unchanged for fingerprints and the original build
      # recipe. The reduced files exist at the project root only during npm ci.
      cp -p -- "$release/package.json" "$release/.install-source-package.json"
      cp -p -- "$release/package-lock.json" "$release/.install-source-package-lock.json"
      cp -- "$release/deploy/linux/package.json" "$release/package.json"
      cp -- "$release/deploy/linux/package-lock.json" "$release/package-lock.json"
      ;;
    root-v1) log '依赖包含完整安装要求，使用原项目依赖清单。' ;;
    *) die '依赖安装方案无效' ;;
  esac
  if runuser -u spread-monitor -- env PATH="$runtime/bin:$PATH" NODE_ENV=development NEXT_TELEMETRY_DISABLED=1 npm_config_cache=/var/cache/market-spread-monitor npm ci --include=dev --include=optional --prefer-offline --no-audit --no-fund; then
    status=0
  else status=$?; fi
  if [[ "$profile" == linux-v1 ]]; then
    mv -f -- "$release/.install-source-package.json" "$release/package.json"
    mv -f -- "$release/.install-source-package-lock.json" "$release/package-lock.json"
  fi
  return "$status"
}

# Next includes its absolute installation path in Webpack's cache version.
# Build every candidate at the same path, then move it into its final release.
# This is a temporary candidate, never a third persistent dependency tree.
managed_build_workspace() {
  local path="$base/build"
  [[ -d "$path" && ! -L "$path" && $(readlink -f "$path") == "$path" &&
      -f "$path/.install-build-workspace" && ! -L "$path/.install-build-workspace" &&
      $(cat "$path/.install-build-workspace") == v1 && -f "$path/.install-owned" ]]
}

cleanup_build_workspace() {
  local path="$base/build"
  [[ -e "$path" || -L "$path" ]] || return 0
  managed_build_workspace || die "$path 已存在且不属于本安装器的构建目录，请保留并移开后重试"
  read_storage_protection
  protects_path "$path" && die '构建目录包含运行版本、源码或数据，保留该目录并停止安装'
  rm -rf --one-file-system -- "$path"
  log '已回收上次中断留下的临时构建目录。'
}

restore_build_workspace() {
  [[ -n "${building_release:-}" ]] || return 0
  managed_build_workspace && [[ "$building_release" == "$new_release" &&
      "${building_release%/*}" == "$base/releases" && ! -e "$building_release" && ! -L "$building_release" ]] || return 1
  mv -T -- "$base/build" "$building_release" || return 1
  release=$building_release
  building_release=''
  rm -f -- "$release/.install-build-workspace"
}

# Only installer-owned, real first-level directories are eligible for deletion.
managed_release() {
  local path=$1 name=${1##*/}
  [[ "$name" =~ ^([0-9a-f]{12}|local-[0-9a-f]{6})-[A-Za-z0-9]{8}$ ]] || return 1
  [[ -d "$path" && ! -L "$path" && "${path%/*}" == "$base/releases" && $(readlink -f "$path") == "$path" ]] || return 1
  [[ -f "$path/.install-owned" || ( -f "$path/package-lock.json" && -f "$path/server/linux.mjs" ) ]]
}

protects_path() {
  local directory=$1 protected
  # Never remove anything inside the data root, or an ancestor containing it.
  if [[ "$storage_data_dir" == / || ( -n "$storage_data_dir" && ( "$directory" == "$storage_data_dir" || "$directory" == "$storage_data_dir/"* ) ) ]]; then return 0; fi
  for protected in "$storage_current" "$storage_running" "$storage_data_dir" "${source_dir:-}"; do
    [[ -z "$protected" || ( "$protected" != "$directory" && "$protected" != "$directory/"* ) ]] || return 0
  done
  return 1
}

read_storage_protection() {
  local pid data_path stamp
  storage_current=$(readlink -f "$base/current" 2>/dev/null || true)
  storage_running=''
  pid=$(systemctl show --property=MainPID --value market-spread-monitor.service 2>/dev/null || true)
  if [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
    storage_running=$(readlink -f "/proc/$pid/cwd") || die '无法确认运行中服务目录，暂不清理版本。'
  fi
  if [[ -f "$config" ]]; then
    stamp=$(digest "$config")
    if [[ "$stamp" != "${storage_config_stamp:-}" ]]; then
      # Reuse only the parsed data path while the actual config is unchanged.
      # Current/MainPID are always reread after a service switch or rollback.
      data_path=$(systemd-run --quiet --wait --pipe --collect --unit="market-spread-monitor-storage-$$" --property="EnvironmentFile=$config" /usr/bin/printenv ALERT_DATA_DIR) || die '无法确认数据目录，暂不清理版本。'
      [[ "$data_path" == /* ]] || die 'ALERT_DATA_DIR 必须为绝对路径，确认前不清理版本。'
      storage_data_dir=$(realpath -m -- "$data_path")
      storage_config_stamp=$stamp
    fi
  else storage_data_dir=/var/lib/market-spread-monitor; storage_config_stamp=''; fi
}

prune_releases() {
  local path keep='' newest=-1 modified removed=0
  read_storage_protection
  [[ -d "$base/releases" && ! -L "$base/releases" && $(readlink -f "$base/releases") == "$base/releases" ]] || return 0
  if [[ -n "${old_current:-}" ]]; then
    if [[ "$old_current" == /* ]]; then keep=$(realpath -m -- "$old_current"); else keep=$(realpath -m -- "$base/$old_current"); fi
    if ! managed_release "$keep" || [[ ! -f "$keep/.install-ready" || "$keep" == "$storage_current" ]]; then keep=''; fi
  fi
  if [[ -z "$keep" ]]; then
    for path in "$base"/releases/*; do
      managed_release "$path" || continue
      [[ "$path" != "$storage_current" && -f "$path/.install-ready" ]] || continue
      modified=$(stat -c %Y -- "$path/.install-ready")
      if (( modified > newest )); then newest=$modified; keep=$path; fi
    done
  fi
  for path in "$base"/releases/*; do
    managed_release "$path" || continue
    [[ "$path" != "$keep" && "$path" != "${new_release:-}" ]] || continue
    protects_path "$path" && continue
    rm -rf --one-file-system -- "$path"
    removed=$((removed + 1))
  done
  if (( removed )); then log "已回收 $removed 个旧版或未完成版本；保留当前、成功回退及受保护目录。"; fi
}

storage_stats() {
  local path=$1
  while [[ ! -e "$path" && "$path" != / ]]; do path=${path%/*}; [[ -n "$path" ]] || path=/; done
  storage_free_kb=$(df -Pk -- "$path" | awk 'END {print $4}')
  storage_free_inodes=$(df -Pi -- "$path" | awk 'END {print $4}')
  [[ "$storage_free_kb" =~ ^[0-9]+$ && ( "$storage_free_inodes" =~ ^[0-9]+$ || "$storage_free_inodes" == - ) ]] || die "无法读取 $path 的剩余空间。"
}

reclaim_caches() {
  local path directory removed=0
  for path in /var/cache/market-spread-monitor/_cacache /var/cache/market-spread-monitor/_logs /var/cache/market-spread-monitor/_npx; do
    [[ -d "$path" && ! -L "$path" && $(readlink -f "$path") == "$path" ]] || continue
    protects_path "$path" && continue
    rm -rf --one-file-system -- "$path"; removed=$((removed + 1))
  done
  for directory in "$base"/releases/*; do
    managed_release "$directory" || continue
    # Webpack compilation cache only; keep runtime images/fetch caches intact.
    path="$directory/.next/cache/webpack"
    [[ -d "$path" && ! -L "$path" && $(readlink -f "$path") == "$path" ]] || continue
    protects_path "$path" && continue
    rm -rf --one-file-system -- "$path"; removed=$((removed + 1))
  done
  if (( removed )); then log "已清理 $removed 处可重建的下载或编译缓存，保留配置、数据和可启动版本。"; fi
}

require_space() {
  local path=$1 required_kb=$2 required_inodes=$3
  storage_stats "$path"
  if (( storage_free_kb < required_kb )) || { [[ "$storage_free_inodes" != - ]] && (( storage_free_inodes < required_inodes )); }; then
    reclaim_caches
    storage_stats "$path"
  fi
  (( storage_free_kb >= required_kb )) || die "空间不足：$path 所在分区剩余 $((storage_free_kb / 1024)) MiB，本阶段至少需要 $((required_kb / 1024)) MiB；原服务未切换。请释放该分区空间或扩容后重试。"
  [[ "$storage_free_inodes" == - ]] || (( storage_free_inodes >= required_inodes )) || die "inode不足：$path 所在分区剩余 $storage_free_inodes 个，至少需要 $required_inodes 个；原服务未切换。"
}

check_build_space() {
  local dependency_kb=1048576 dependency_inodes=100000 build_kb=524288 build_inodes=10000 value
  if [[ -n "$candidate_sizes" ]]; then
    read -r dependency_kb dependency_inodes build_kb build_inodes <<< "$candidate_sizes"
    (( build_kb >= 524288 )) || build_kb=524288
    (( build_inodes >= 10000 )) || build_inodes=10000
  elif [[ -n "$candidate" && -d "$candidate/node_modules" ]]; then
    dependency_kb=$(du -sk -- "$candidate/node_modules" | awk '{print $1}')
    dependency_inodes=$(du --inodes -s -- "$candidate/node_modules" | awk '{print $1}')
  fi
  if [[ -z "$candidate_sizes" && -n "$candidate" && -d "$candidate/.next" ]]; then
    value=$(du -sk --exclude=cache -- "$candidate/.next" | awk '{print $1}')
    (( value <= build_kb )) || build_kb=$value
    value=$(du --inodes -s --exclude=cache -- "$candidate/.next" | awk '{print $1}')
    (( value <= build_inodes )) || build_inodes=$value
  fi
  build_required_kb=$((build_kb + 262144))
  build_required_inodes=$((build_inodes + 5000))
  # Budget for ordinary copies, without assuming filesystem reflink support.
  require_space "$base/releases" "$((dependency_kb + build_kb + 262144 + 524288 + 131072))" "$((dependency_inodes + build_inodes + 10000))"
  require_space /tmp 131072 1024
  require_space /var/cache/market-spread-monitor 524288 5000
}

check_config() {
  systemd-run --quiet --wait --pipe --collect --unit="market-spread-monitor-config-$$" --property="EnvironmentFile=$config" "$runtime/bin/node" "$release/deploy/check-install.mjs" --config-only
}

probe_running() {
  local pid
  systemctl is-active --quiet market-spread-monitor.service || return 1
  [[ $(systemctl show --property=NeedDaemonReload --value market-spread-monitor.service) == no ]] || return 1
  pid=$(systemctl show --property=MainPID --value market-spread-monitor.service)
  [[ "$pid" =~ ^[1-9][0-9]*$ && $(readlink -f "/proc/$pid/cwd") == "$release" ]] || return 1
  systemd-run --quiet --wait --pipe --collect --unit="market-spread-monitor-probe-$$" --property="EnvironmentFile=$config" "$runtime/bin/node" "$release/deploy/check-install.mjs" --once --quiet --describe-after-check "$first_install" || return 1
  install_described=1
}

atomic_marker() { printf '%s\n' "$2" > "$1.tmp-$$"; mv -f -- "$1.tmp-$$" "$1"; }

record_success() {
  local dependency_kb dependency_inodes build_kb build_inodes
  if [[ "$release" == "$new_release" ]]; then
    atomic_marker "$release/.install-source" "$release_id"
    atomic_marker "$release/.install-build-source" "$build_source"
  fi
  atomic_marker "$release/.install-checked-source" "$release_id"
  atomic_marker "$release/.install-dependencies" "$dependency_key"
  atomic_marker "$release/.install-runtime" "$runtime_key"
  atomic_marker "$release/.install-build" "$build_key"
  atomic_marker "$release/.install-config" "$(digest "$config")"
  atomic_marker "$release/.install-unit" "$(unit_fingerprint)"
  if [[ -n "$candidate_sizes" ]]; then read -r dependency_kb dependency_inodes build_kb build_inodes <<< "$candidate_sizes"; fi
  if (( ! reused )) || [[ -z "$candidate_sizes" ]]; then
    dependency_kb=$(du -sk -- "$release/node_modules" | awk '{print $1}')
    dependency_inodes=$(du --inodes -s -- "$release/node_modules" | awk '{print $1}')
  fi
  if (( ! reused_build )) || [[ -z "$candidate_sizes" ]]; then
    build_kb=$(du -sk --exclude=cache -- "$release/.next" | awk '{print $1}')
    build_inodes=$(du --inodes -s --exclude=cache -- "$release/.next" | awk '{print $1}')
  fi
  atomic_marker "$release/.install-storage.json" "{\"dependencies\":\"$dependency_key\",\"build\":\"$build_key\",\"dependencyKB\":$dependency_kb,\"dependencyInodes\":$dependency_inodes,\"buildKB\":$build_kb,\"buildInodes\":$build_inodes}"
  touch "$release/.install-root-owned"
  touch "$release/.install-ready"
}

describe_install() {
  [[ ! -f "$base/.credentials-unshown" ]] || first_install=1
  if (( ! install_described )); then
    systemd-run --quiet --wait --pipe --collect --unit="market-spread-monitor-info-$$" --property="EnvironmentFile=$config" "$runtime/bin/node" "$release/deploy/check-install.mjs" --describe "$first_install"
  fi
  rm -f -- "$base/.credentials-unshown"
  printf '配置文件：%s\n服务日志：sudo journalctl -u market-spread-monitor -f\n升级：再次运行相同的安装命令。\n' "$config"
}

rollback() {
  log '启动未通过检查，正在恢复原服务。'
  systemctl stop market-spread-monitor.service || return 1
  if [[ -n "$old_current" ]]; then
    ln -s "$old_current" "$base/current.rollback"
    mv -Tf "$base/current.rollback" "$base/current" || return 1
  else
    rm -f -- "$base/current"
  fi
  if [[ -f "$scratch/previous.service" ]]; then
    cp -p "$scratch/previous.service" "$unit" || return 1
  else
    rm -f -- "$unit"
  fi
  systemctl daemon-reload || return 1
  if (( was_active )); then systemctl start market-spread-monitor.service || return 1; fi
}

finish() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  profile_phase exit_cleanup "$status"
  local rollback_failed=0 rollback_status=0
  if ! restore_build_workspace; then
    printf '临时构建目录已保留；下次部署会检查并回收。\n' >&2
  fi
  if (( status != 0 && switching )); then
    profile_phase rollback
    rollback || { rollback_status=$?; rollback_failed=1; printf '自动恢复未完成，请查看 systemctl status market-spread-monitor。\n' >&2; }
    profile_phase exit_cleanup "$rollback_status"
  fi
  if (( status != 0 )); then
    printf '安装未完成；配置和告警数据已保留。日志：journalctl -u market-spread-monitor -n 50\n' >&2
    if (( ! rollback_failed )) && [[ -n "$new_release" && "$new_release" == "$release" ]] && managed_release "$new_release"; then
      # Failure to inspect protection must not abort the rest of EXIT cleanup.
      if ( read_storage_protection && ! protects_path "$new_release" ); then rm -rf --one-file-system -- "$new_release"; fi
    fi
  fi
  if [[ -n "$scratch" && "$scratch" == /tmp/market-spread-install.* ]]; then rm -rf -- "$scratch"; fi
  profile_report "$status"
  exit "$status"
}

profile_early_finish() {
  local status=$?
  trap - EXIT INT TERM
  profile_phase exit_cleanup "$status"
  profile_report "$status"
  exit "$status"
}

main() {
  set -Eeuo pipefail
  umask 022
  base=/opt/market-spread-monitor
  config=/etc/market-spread-monitor.env
  unit=/etc/systemd/system/market-spread-monitor.service
  local source_dir='' requested_port='' architecture node_name runtime release_id first_install=0 rebuild=0 cleanup_only=0 profile_requested=0 dependency_key='' candidate='' reused=0
  local input_dir='' runtime_key='' build_key='' build_source='' reused_build=0 candidate_sizes='' candidate_valid=0 candidate_dependencies_valid=0 candidate_source_valid=1 install_described=0 npm_version unit_changed=0 phase
  scratch='' release='' new_release='' building_release='' switching=0 old_current='' was_active=0
  storage_current='' storage_running='' storage_data_dir='' storage_config_stamp='' storage_free_kb=0 storage_free_inodes=0
  build_required_kb=786432 build_required_inodes=15000
  profile_enabled=0

  while (( $# )); do
    case "$1" in
      --source-dir) [[ $# -ge 2 ]] || die '--source-dir 缺少目录'; source_dir=$(realpath "$2"); shift 2 ;;
      --port) [[ $# -ge 2 ]] || die '--port 缺少端口'; requested_port=$2; shift 2 ;;
      --rebuild) rebuild=1; shift ;;
      --cleanup) cleanup_only=1; shift ;;
      --profile) profile_requested=1; shift ;;
      --help|-h) printf '用法：bash install.sh [--port 3000] [--rebuild] [--cleanup] [--profile] [--source-dir /path/to/source]\n已有配置始终保留；--port 仅用于首次安装；--rebuild 强制重新安装依赖并构建；--cleanup 仅回收旧版和可重建缓存，不安装、不重启；--profile 输出分阶段耗时报告。\n'; return ;;
      *) die "未知参数：$1" ;;
    esac
  done
  if (( profile_requested )); then
    profile_init /tmp
    trap profile_early_finish EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    profile_phase preflight
  fi
  [[ -z "$requested_port" || "$requested_port" =~ ^[0-9]{1,5}$ ]] || die '端口必须是 1–65535 的数字'
  if [[ -n "$requested_port" ]]; then (( 10#$requested_port > 0 && 10#$requested_port <= 65535 )) || die '端口必须是 1–65535'; fi
  [[ $(uname -s) == Linux && -f /etc/os-release ]] || die '仅支持 Linux'
  # This is the OS-owned metadata file, never an application configuration file.
  # shellcheck source=/dev/null
  . /etc/os-release
  case "${ID:-}:${VERSION_ID:-}" in
    ubuntu:22.04|ubuntu:24.04|debian:12|debian:13) ;;
    *) die '当前支持 Ubuntu 22.04 / 24.04、Debian 12 / 13' ;;
  esac
  [[ -d /run/systemd/system ]] || die '需要正在运行 systemd 的服务器'
  case "$(uname -m)" in
    x86_64) architecture=x64 ;;
    aarch64|arm64) architecture=arm64 ;;
    *) die '仅支持 x86_64 或 ARM64' ;;
  esac
  if [[ -n "$source_dir" ]]; then
    [[ -f "$source_dir/package-lock.json" && -f "$source_dir/server/linux.mjs" ]] || die '源码目录缺少项目文件'
  fi
  if [[ -e "$base/current" && ! -L "$base/current" ]]; then die "$base/current 必须是安装器管理的符号链接"; fi
  [[ ! -L "$config" && ! -L "$unit" ]] || die '配置或服务文件是符号链接，请使用常规文件后重试'

  mkdir -p /run/lock
  exec 9>/run/lock/market-spread-monitor-install.lock
  flock -n 9 || die '已有部署正在运行，请等待结束'
  profile_phase startup_cleanup
  cleanup_build_workspace
  # Runs before mktemp/downloads, including when /tmp shares a full root filesystem.
  prune_releases
  if (( cleanup_only )); then
    reclaim_caches
    df -h -- /opt /tmp /var
    df -i -- /opt /tmp /var
    log '清理完成；当前服务、回退版本、配置和行情数据已保留。'
    return
  fi
  require_space /tmp 16384 128
  scratch=$(mktemp -d /tmp/market-spread-install.XXXXXXXX)
  trap finish EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  log '正在检查版本和运行环境。'
  profile_phase system_packages
  export DEBIAN_FRONTEND=noninteractive
  local package missing=0
  for package in ca-certificates curl xz-utils python3 util-linux passwd iproute2; do
    [[ $(dpkg-query -W -f='${Status}' "$package" 2>/dev/null) == 'install ok installed' ]] || missing=1
  done
  if (( missing )); then
    require_space /var 524288 5000
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl xz-utils python3 util-linux passwd iproute2
  fi
  mkdir -p "$base/releases" "$base/runtimes"
  node_name="node-v24.15.0-linux-$architecture"
  runtime="$base/runtimes/$node_name"

  profile_phase source_identity
  if [[ -z "$source_dir" ]]; then
    download 'https://api.github.com/repos/hxx344/market-spread-monitor/commits/main' "$scratch/commit.json"
    release_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha"])' "$scratch/commit.json")
    [[ "$release_id" =~ ^[0-9a-f]{40}$ ]] || die 'GitHub 未返回有效的提交号'
  else
    # Content-based identity: touching a file or running a previous build is not an upgrade.
    local source_kb
    source_kb=$(du -sk --exclude='.git' --exclude='node_modules' --exclude='.next' --exclude='dist' --exclude='.vinext' --exclude='.sites-runtime' --exclude='.wrangler' --exclude='.env*' --exclude='runtime-data' --exclude='.codex' --exclude='.agents' --exclude='output' --exclude='outputs' --exclude='.playwright-cli' --exclude='.runtime' --exclude='.install-*' --exclude='*.tsbuildinfo' -- "$source_dir" | awk '{print $1}')
    require_space /tmp "$((source_kb + 16384))" 128
    tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -czf "$scratch/source.tar.gz" --exclude='./.git' --exclude='./node_modules' --exclude='./.next' --exclude='./dist' --exclude='./.vinext' --exclude='./.sites-runtime' --exclude='./.wrangler' --exclude='./.env*' --exclude='./runtime-data' --exclude='./.codex' --exclude='./.agents' --exclude='./output' --exclude='./outputs' --exclude='./.playwright-cli' --exclude='./.runtime' --exclude='./.install-*' --exclude='*.tsbuildinfo' -C "$source_dir" .
    release_id="local-$(digest "$scratch/source.tar.gz")"
  fi

  profile_phase node_runtime
  if [[ ! -x "$runtime/bin/node" ]]; then
    log '首次准备专用 Node.js，后续升级会复用。'
    require_space "$base/runtimes" 524288 10000
    require_space /tmp 393216 10000
    download "https://nodejs.org/dist/v24.15.0/$node_name.tar.xz" "$scratch/$node_name.tar.xz"
    download 'https://nodejs.org/dist/v24.15.0/SHASUMS256.txt' "$scratch/SHASUMS256.txt"
    (cd "$scratch"; awk -v archive="$node_name.tar.xz" '$2 == archive { print; found=1 } END { if (!found) exit 1 }' SHASUMS256.txt > selected.sha256; sha256sum --check selected.sha256)
    tar -xJf "$scratch/$node_name.tar.xz" -C "$scratch"
    mv "$scratch/$node_name" "$runtime"
  fi
  [[ $("$runtime/bin/node" --version) == v24.15.0 ]] || die '专用 Node.js 版本不匹配'

  if [[ -L "$base/current" ]]; then candidate=$(readlink -f "$base/current"); fi
  [[ ! -f "$base/.credentials-unshown" ]] || first_install=1
  # A checked commit may contain only docs/tests. It is deliberately separate
  # from the source commit that actually produced the running release.
  if (( ! rebuild )) && [[ -n "$candidate" && -f "$candidate/.install-ready" && -f "$candidate/.install-runtime" &&
      -f "$candidate/.install-build" && -f "$candidate/.install-root-owned" &&
      $(cat "$candidate/.install-checked-source" 2>/dev/null || true) == "$release_id" ]]; then
    input_dir=$candidate
    profile_skip source_download unchanged
  else
    profile_phase source_download
    if [[ -z "$source_dir" ]]; then download "https://codeload.github.com/hxx344/market-spread-monitor/tar.gz/$release_id" "$scratch/source.tar.gz"; fi
    mkdir "$scratch/source"
    if [[ -z "$source_dir" ]]; then tar -xzf "$scratch/source.tar.gz" --strip-components=1 -C "$scratch/source";
    else tar -xzf "$scratch/source.tar.gz" -C "$scratch/source"; fi
    input_dir=$scratch/source
  fi
  profile_phase fingerprints
  [[ -f "$input_dir/deploy/check-install.mjs" && -f "$input_dir/deploy/install-inputs.mjs" && -f "$input_dir/deploy/market-spread-monitor.service" && -f "$input_dir/server/entrypoint.sh" ]] || die '发布文件不完整'
  npm_version=$("$runtime/bin/node" "$runtime/lib/node_modules/npm/bin/npm-cli.js" --version)
  local fingerprints
  fingerprints=$("$runtime/bin/node" "$input_dir/deploy/install-inputs.mjs" "$input_dir" "$release_id" v24.15.0 "$npm_version" "$architecture" --all)
  mapfile -t keys <<< "$fingerprints"
  [[ ${#keys[@]} == 3 && ${keys[0]} =~ ^[a-f0-9]{64}$ && ${keys[1]} =~ ^[a-f0-9]{64}$ && ${keys[2]} =~ ^[a-f0-9]{64}$ ]] || die '安装输入摘要无效'
  dependency_key=${keys[0]}; runtime_key=${keys[1]}; build_key=${keys[2]}
  if [[ "$input_dir" == "$candidate" && $(cat "$candidate/.install-runtime") != "$runtime_key" ]]; then
    profile_phase source_download
    # Root-local edits/damage cannot be relabelled as the checked Git commit.
    if [[ -z "$source_dir" ]]; then download "https://codeload.github.com/hxx344/market-spread-monitor/tar.gz/$release_id" "$scratch/source.tar.gz"; fi
    mkdir "$scratch/source"
    if [[ -z "$source_dir" ]]; then tar -xzf "$scratch/source.tar.gz" --strip-components=1 -C "$scratch/source";
    else tar -xzf "$scratch/source.tar.gz" -C "$scratch/source"; fi
    input_dir=$scratch/source
    profile_phase fingerprints
    fingerprints=$("$runtime/bin/node" "$input_dir/deploy/install-inputs.mjs" "$input_dir" "$release_id" v24.15.0 "$npm_version" "$architecture" --all)
    mapfile -t keys <<< "$fingerprints"
    [[ ${#keys[@]} == 3 && ${keys[0]} =~ ^[a-f0-9]{64}$ && ${keys[1]} =~ ^[a-f0-9]{64}$ && ${keys[2]} =~ ^[a-f0-9]{64}$ ]] || die '安装输入摘要无效'
    dependency_key=${keys[0]}; runtime_key=${keys[1]}; build_key=${keys[2]}
    # The source marker describes the original immutable source, not the edit.
    candidate_source_valid=0
  fi
  if [[ -n "$candidate" && -f "$candidate/.install-ready" && -f "$candidate/.install-root-owned" &&
      -d "$candidate/node_modules" && ! -L "$candidate/node_modules" && -x "$candidate/node_modules/.bin/next" &&
      -f "$candidate/node_modules/.package-lock.json" && $(readlink -f "$candidate/.runtime") == "$runtime" ]] &&
      (cd "$candidate"; "$runtime/bin/node" -e "require('next'); require('react')"); then
    candidate_dependencies_valid=1
    if "$runtime/bin/node" "$input_dir/deploy/install-inputs.mjs" "$candidate" --valid-build; then candidate_valid=1; fi
    candidate_sizes=$("$runtime/bin/node" "$input_dir/deploy/install-inputs.mjs" "$candidate" --sizes)
  fi
  profile_phase fast_probe
  if (( ! rebuild && candidate_valid && candidate_source_valid )) && [[ -f "$config" && -f "$unit" &&
      $(cat "$candidate/.install-runtime" 2>/dev/null || true) == "$runtime_key" &&
      $(cat "$candidate/.install-build" 2>/dev/null || true) == "$build_key" ]]; then
    release=$candidate; reused=1; reused_build=1
    profile_skip deps_install reused
    profile_skip next_build reused
    for phase in deps_copy artifact_copy compiler_cache build_workspace build_validate permissions unit_prepare source_copy service_setup space_check; do profile_skip "$phase" not_needed; done
    if [[ $(cat "$release/.install-config") == "$(digest "$config")" && $(cat "$release/.install-unit") == "$(unit_fingerprint)" ]] && probe_running; then
      profile_skip service_switch unchanged
      profile_skip health_check not_needed
      enable_service
      atomic_marker "$release/.install-checked-source" "$release_id"
      if [[ "$input_dir" == "$candidate" ]]; then log '当前已核对最新版本，服务健康；跳过源码下载、依赖安装、构建和重启。';
      else log '已核对新提交，运行和构建内容未变；跳过依赖安装、构建和重启。'; fi
    else
      profile_phase config_check
      check_config
      log '运行内容未变，仅应用配置或恢复服务；跳过依赖安装和构建。'
      profile_phase service_switch
      reload_service_definition
      systemctl restart market-spread-monitor.service
      profile_phase health_check
      systemd-run --quiet --wait --pipe --collect --unit="market-spread-monitor-check-$$" --property="EnvironmentFile=$config" "$runtime/bin/node" "$release/deploy/check-install.mjs" --describe-after-check "$first_install"
      install_described=1
      local recovered_pid
      recovered_pid=$(systemctl show --property=MainPID --value market-spread-monitor.service)
      [[ "$recovered_pid" =~ ^[1-9][0-9]*$ && $(readlink -f "/proc/$recovered_pid/cwd") == "$release" ]] || die '服务恢复后版本目录不一致'
      enable_service
      profile_phase success_record
      record_success
    fi
    profile_phase describe
    describe_install
    return
  fi

  profile_phase service_setup
  if ! id spread-monitor >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$base" --shell /usr/sbin/nologin spread-monitor
  fi
  getent group spread-monitor >/dev/null || die '已有 spread-monitor 用户缺少同名用户组'
  install -d -m 0700 -o spread-monitor -g spread-monitor /var/cache/market-spread-monitor
  if [[ ! -e "$config" ]]; then
    first_install=1
    install -m 0600 /dev/null "$config"
    {
      printf 'NODE_ENV=production\nHOST=0.0.0.0\nPORT=%s\nAPP_USERNAME=admin\n' "${requested_port:-3000}"
      printf 'APP_PASSWORD=%s\n' "$("$runtime/bin/node" -e "console.log(require('node:crypto').randomBytes(18).toString('hex'))")"
      printf 'ALERT_DATA_DIR=/var/lib/market-spread-monitor\nOIL_POLL_INTERVAL_SECONDS=30\n'
    } > "$config"
    install -m 0600 /dev/null "$base/.credentials-unshown"
  elif [[ -n "$requested_port" ]]; then
    log '检测到已有配置，保留原端口；如需更改，请编辑 /etc/market-spread-monitor.env。'
  fi

  log '检测到需要部署的版本，正在准备源码；新版本准备完成后才会切换服务。'
  profile_phase space_check
  check_build_space
  profile_phase source_copy
  release=$(mktemp -d "$base/releases/${release_id:0:12}-XXXXXXXX")
  new_release=$release
  touch "$release/.install-owned"
  chmod 0755 "$release"
  # Only source files enter a candidate; generated/runtime trees are never copied here.
  tar --exclude='./node_modules' --exclude='./.next' --exclude='./.runtime' --exclude='./.install-*' -C "$input_dir" -cf - . | tar -xf - -C "$release"
  [[ -f "$release/deploy/check-install.mjs" && -f "$release/deploy/install-inputs.mjs" && -f "$release/deploy/market-spread-monitor.service" && -f "$release/server/entrypoint.sh" ]] || die '发布文件不完整'
  profile_phase config_check
  check_config
  ln -s "$runtime" "$release/.runtime"
  if (( ! rebuild && candidate_dependencies_valid )) && [[ -f "$candidate/.install-dependencies" && $(cat "$candidate/.install-dependencies") == "$dependency_key" ]]; then
    log '依赖未变，复用已安装依赖的独立副本。'
    profile_phase deps_copy
    if cp -a --reflink=auto "$candidate/node_modules" "$release/node_modules" && [[ -x "$release/node_modules/.bin/next" && -f "$release/node_modules/.package-lock.json" ]] && (cd "$release"; "$runtime/bin/node" -e "require('next'); require('react')"); then
      reused=1
      profile_skip deps_install reused
      if (( candidate_valid )) && [[ $(cat "$candidate/.install-build") == "$build_key" ]]; then
        log 'Next 构建输入未变，复用已验证的独立构建副本。'
        profile_phase artifact_copy
        mkdir "$release/.next"
        local artifact
        for artifact in "$candidate/.next"/* "$candidate/.next"/.[!.]*; do
          [[ -e "$artifact" && ${artifact##*/} != cache ]] || continue
          cp -a --reflink=auto "$artifact" "$release/.next/"
        done
        if "$runtime/bin/node" "$release/deploy/install-inputs.mjs" "$release" --valid-build; then reused_build=1;
        else rm -rf -- "$release/.next"; fi
      else profile_skip artifact_copy not_needed; fi
      # Copy only compilation caches. .rscinfo preserves Next's own expiring
      # build salt (part of the Webpack key); .tsbuildinfo enables incremental
      # type checking. Never copy runtime image/fetch caches or fix the salt.
      if [[ -d "$candidate/.next/cache" && ! -L "$candidate/.next/cache" ]]; then
        profile_phase compiler_cache
        local cache_kb=0 cache_inodes=0 cache_entry
        local -a compiler_caches=()
        for cache_entry in webpack .rscinfo .tsbuildinfo; do
          [[ -e "$candidate/.next/cache/$cache_entry" && ! -L "$candidate/.next/cache/$cache_entry" ]] || continue
          compiler_caches+=("$candidate/.next/cache/$cache_entry")
          cache_kb=$((cache_kb + $(du -sk -- "$candidate/.next/cache/$cache_entry" | awk '{print $1}')))
          cache_inodes=$((cache_inodes + $(du --inodes -s -- "$candidate/.next/cache/$cache_entry" | awk '{print $1}')))
        done
        if (( ${#compiler_caches[@]} )); then
          storage_stats "$base/releases"
          if (( storage_free_kb >= cache_kb + build_required_kb + 262144 )) && { [[ "$storage_free_inodes" == - ]] || (( storage_free_inodes >= cache_inodes + build_required_inodes )); }; then
            mkdir -p "$release/.next/cache"
            if cp -a --reflink=auto -- "${compiler_caches[@]}" "$release/.next/cache/"; then
              log '已复制 Webpack 与 TypeScript 编译缓存，构建时按内容校验复用。'
            else rm -rf -- "$release/.next/cache"; fi
          else log '剩余空间较少，跳过可选编译缓存副本。'; fi
        fi
      else profile_skip compiler_cache cache_unavailable; fi
    else
      log '依赖副本不完整，自动重新安装。'
      rm -rf -- "$release/node_modules"
    fi
  else
    profile_skip deps_copy not_needed
    profile_skip artifact_copy not_needed
    profile_skip compiler_cache cache_unavailable
  fi
  # Reused dependencies are already immutable and retain root ownership. Next
  # writes to the candidate/.next, not into an existing dependency installation.
  profile_phase build_workspace
  require_space "$base/releases" "$build_required_kb" "$build_required_inodes"
  if (( ! reused || ! reused_build )); then
    find "$release" -path "$release/node_modules" -prune -o -exec chown -h spread-monitor:spread-monitor {} +
    [[ ! -e "$base/build" && ! -L "$base/build" ]] || die '临时构建目录已被占用'
    read_storage_protection
    protects_path "$base/build" && die '临时构建路径与配置的数据或源码目录重合，原服务未切换'
    printf 'v1\n' > "$release/.install-build-workspace"
    building_release=$release
    mv -T -- "$release" "$base/build"
    release=$base/build
    log '在固定目录执行构建，复用跨版本增量编译结果。'
  fi
  (
    cd "$release"
    if (( ! reused )); then
      log '依赖发生变化或尚无缓存，正在安装依赖。'
      profile_phase deps_install
      install_project_dependencies
    fi
    if (( ! reused_build )); then
      log '正在构建变更后的代码（包含 Next 类型检查）。'
      profile_phase next_build
      runuser -u spread-monitor -- env PATH="$runtime/bin:$PATH" NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 npm run build:linux
    else profile_skip next_build reused; fi
  )
  profile_phase build_validate
  restore_build_workspace || die '无法将构建结果移入版本目录'
  # A reused artifact was already checked after copying; only a new build needs
  # verification here after moving back from the stable compilation directory.
  if (( ! reused_build )); then
    "$runtime/bin/node" "$release/deploy/install-inputs.mjs" "$release" --valid-build || die '构建未生成完整可启动版本'
  fi
  build_source=$release_id
  if (( reused_build )); then build_source=$(cat "$candidate/.install-build-source"); fi
  # Source and dependencies are root-owned and read-only to the service. Only
  # Next's runtime cache remains writable. Avoid traversing copied dependencies.
  profile_phase permissions
  find "$release" \( -path "$release/node_modules" -o -path "$release/.next/cache" \) -prune -o \
    \( -exec chown -h root:root {} + \( -type f -exec chmod a+r,go-w {} + -o -type d -exec chmod a+rx,go-w {} + \) \)
  if (( ! reused )); then chown -R root:root "$release/node_modules"; chmod -R a+rX,go-w "$release/node_modules"; fi
  install -d -m 0700 -o spread-monitor -g spread-monitor "$release/.next/cache"
  chown -R spread-monitor:spread-monitor "$release/.next/cache"
  profile_phase unit_prepare
  sed -e "s|^WorkingDirectory=.*|WorkingDirectory=$base/current|" -e "s|^ExecStart=.*|ExecStart=/bin/bash $base/current/server/entrypoint.sh|" "$release/deploy/market-spread-monitor.service" > "$scratch/market-spread-monitor.service"
  if ! cmp -s -- "$scratch/market-spread-monitor.service" "$unit"; then
    unit_changed=1
    # Check the prepared version directly; current still refers to the old one.
    sed "s|$base/current|$release|g" "$scratch/market-spread-monitor.service" > "$scratch/check.service"
    systemd-analyze verify "$scratch/check.service" || die 'systemd 服务文件校验失败'
  else log '服务定义未变，跳过重复写入和校验。'; fi

  profile_phase service_switch
  [[ ! -L "$base/current" ]] || old_current=$(readlink "$base/current")
  [[ ! -f "$unit" ]] || cp -p "$unit" "$scratch/previous.service"
  if systemctl is-active --quiet market-spread-monitor.service; then was_active=1; fi
  switching=1
  systemctl stop market-spread-monitor.service 2>/dev/null || { (( ! was_active )) || die '无法停止原服务'; }
  ln -s "$release" "$base/current.next"
  mv -Tf "$base/current.next" "$base/current"
  if (( unit_changed )); then install -m 0644 "$scratch/market-spread-monitor.service" "$unit"; fi
  reload_service_definition "$unit_changed"
  systemctl start market-spread-monitor.service
  # Read EnvironmentFile through systemd itself; never execute or echo an existing config.
  profile_phase health_check
  systemd-run --quiet --wait --pipe --collect --unit="market-spread-monitor-check-$$" --property="EnvironmentFile=$config" "$runtime/bin/node" "$release/deploy/check-install.mjs" --describe-after-check "$first_install"
  install_described=1
  systemctl is-active --quiet market-spread-monitor.service || die '服务未保持运行'
  local main_pid
  main_pid=$(systemctl show --property=MainPID --value market-spread-monitor.service)
  [[ "$main_pid" =~ ^[1-9][0-9]*$ && $(readlink -f "/proc/$main_pid/cwd") == "$release" ]] || die '运行进程与新版本不一致'
  enable_service
  switching=0
  profile_phase success_record
  record_success
  profile_phase final_cleanup
  prune_releases

  log '部署完成，已启用开机启动和原油与海力士后台告警检查。'
  profile_phase describe
  describe_install
}

if (( EUID != 0 )); then
  command -v sudo >/dev/null || die '请使用 root 运行，或先安装 sudo'
  # Pass the fully parsed functions, not stdin or $0: both differ under curl | bash.
  sudo bash -c "$(declare -f)"$'\nmain "$@"' -- "$@"
else
  main "$@"
fi
