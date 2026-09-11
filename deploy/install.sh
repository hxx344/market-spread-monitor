#!/usr/bin/env bash
# Install or upgrade from a complete script, including when invoked with curl | bash.
set -Eeuo pipefail

log() { printf '\n%s\n' "$*"; }
die() { printf '\n安装失败：%s\n' "$*" >&2; exit 1; }
download() { curl --fail --silent --show-error --location --retry 3 --connect-timeout 20 --max-time 300 "$1" -o "$2"; }
digest() { sha256sum "$1" | cut -d ' ' -f 1; }
unit_fingerprint() { systemctl cat --no-pager market-spread-monitor.service | sha256sum | cut -d ' ' -f 1; }

check_config() {
  systemd-run --quiet --wait --pipe --collect --unit="market-spread-monitor-config-$$" --property="EnvironmentFile=$config" "$runtime/bin/node" "$release/deploy/check-install.mjs" --config-only
}

probe_running() {
  local pid
  systemctl is-active --quiet market-spread-monitor.service || return 1
  [[ $(systemctl show --property=NeedDaemonReload --value market-spread-monitor.service) == no ]] || return 1
  pid=$(systemctl show --property=MainPID --value market-spread-monitor.service)
  [[ "$pid" =~ ^[1-9][0-9]*$ && $(readlink -f "/proc/$pid/cwd") == "$release" ]] || return 1
  systemd-run --quiet --wait --pipe --collect --unit="market-spread-monitor-probe-$$" --property="EnvironmentFile=$config" "$runtime/bin/node" "$release/deploy/check-install.mjs" --once --quiet
}

record_success() {
  printf '%s\n' "$release_id" > "$release/.install-source"
  printf '%s\n' "$dependency_key" > "$release/.install-dependencies"
  digest "$config" > "$release/.install-config"
  unit_fingerprint > "$release/.install-unit"
  touch "$release/.install-ready"
}

describe_install() {
  [[ ! -f "$base/.credentials-unshown" ]] || first_install=1
  systemd-run --quiet --wait --pipe --collect --unit="market-spread-monitor-info-$$" --property="EnvironmentFile=$config" "$runtime/bin/node" "$release/deploy/check-install.mjs" --describe "$first_install"
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
  local rollback_failed=0
  if (( status != 0 && switching )); then
    rollback || { rollback_failed=1; printf '自动恢复未完成，请查看 systemctl status market-spread-monitor。\n' >&2; }
  fi
  if (( status != 0 )); then
    printf '安装未完成；配置和告警数据已保留。日志：journalctl -u market-spread-monitor -n 50\n' >&2
    if (( ! rollback_failed )) && [[ -n "$release" && "$release" == "$base/releases/"* && $(readlink -f "$base/current") != "$release" ]]; then
      rm -rf -- "$release"
    fi
  fi
  if [[ -n "$scratch" && "$scratch" == /tmp/market-spread-install.* ]]; then rm -rf -- "$scratch"; fi
  exit "$status"
}

main() {
  set -Eeuo pipefail
  umask 022
  base=/opt/market-spread-monitor
  config=/etc/market-spread-monitor.env
  unit=/etc/systemd/system/market-spread-monitor.service
  local source_dir='' requested_port='' architecture node_name runtime release_id first_install=0 rebuild=0 dependency_key='' candidate='' reused=0
  scratch='' release='' switching=0 old_current='' was_active=0

  while (( $# )); do
    case "$1" in
      --source-dir) [[ $# -ge 2 ]] || die '--source-dir 缺少目录'; source_dir=$(realpath "$2"); shift 2 ;;
      --port) [[ $# -ge 2 ]] || die '--port 缺少端口'; requested_port=$2; shift 2 ;;
      --rebuild) rebuild=1; shift ;;
      --help|-h) printf '用法：bash install.sh [--port 3000] [--rebuild] [--source-dir /path/to/source]\n已有配置始终保留；--port 仅用于首次安装；--rebuild 强制重新安装依赖并构建。\n'; return ;;
      *) die "未知参数：$1" ;;
    esac
  done
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
  scratch=$(mktemp -d /tmp/market-spread-install.XXXXXXXX)
  trap finish EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  log '正在检查版本和运行环境。'
  export DEBIAN_FRONTEND=noninteractive
  local package missing=0
  for package in ca-certificates curl xz-utils python3 util-linux passwd iproute2; do
    [[ $(dpkg-query -W -f='${Status}' "$package" 2>/dev/null) == 'install ok installed' ]] || missing=1
  done
  if (( missing )); then
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl xz-utils python3 util-linux passwd iproute2
  fi
  mkdir -p "$base/releases" "$base/runtimes"
  node_name="node-v24.15.0-linux-$architecture"
  runtime="$base/runtimes/$node_name"

  if [[ -z "$source_dir" ]]; then
    download 'https://api.github.com/repos/hxx344/market-spread-monitor/commits/main' "$scratch/commit.json"
    release_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha"])' "$scratch/commit.json")
    [[ "$release_id" =~ ^[0-9a-f]{40}$ ]] || die 'GitHub 未返回有效的提交号'
  else
    # Content-based identity: touching a file or running a previous build is not an upgrade.
    tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -czf "$scratch/source.tar.gz" --exclude='./.git' --exclude='./node_modules' --exclude='./.next' --exclude='./dist' --exclude='./.vinext' --exclude='./.sites-runtime' --exclude='./.wrangler' --exclude='./.env*' --exclude='./runtime-data' --exclude='./.codex' --exclude='./.agents' --exclude='./output' --exclude='./outputs' --exclude='./.playwright-cli' --exclude='./.runtime' --exclude='./.install-*' --exclude='*.tsbuildinfo' -C "$source_dir" .
    release_id="local-$(digest "$scratch/source.tar.gz")"
  fi

  if [[ ! -x "$runtime/bin/node" ]]; then
    log '首次准备专用 Node.js，后续升级会复用。'
    download "https://nodejs.org/dist/v24.15.0/$node_name.tar.xz" "$scratch/$node_name.tar.xz"
    download 'https://nodejs.org/dist/v24.15.0/SHASUMS256.txt' "$scratch/SHASUMS256.txt"
    (cd "$scratch"; awk -v archive="$node_name.tar.xz" '$2 == archive { print; found=1 } END { if (!found) exit 1 }' SHASUMS256.txt > selected.sha256; sha256sum --check selected.sha256)
    tar -xJf "$scratch/$node_name.tar.xz" -C "$scratch"
    mv "$scratch/$node_name" "$runtime"
  fi
  [[ $("$runtime/bin/node" --version) == v24.15.0 ]] || die '专用 Node.js 版本不匹配'

  if [[ -L "$base/current" ]]; then candidate=$(readlink -f "$base/current"); fi
  if (( ! rebuild )) && [[ -n "$candidate" && -f "$candidate/.install-ready" && -f "$candidate/.next/BUILD_ID" && -d "$candidate/node_modules" && -f "$config" && -f "$unit" && $(readlink -f "$candidate/.runtime") == "$runtime" && $(cat "$candidate/.install-source") == "$release_id" ]]; then
    release=$candidate
    dependency_key=$(cat "$candidate/.install-dependencies")
    check_config
    if [[ $(cat "$release/.install-config") == "$(digest "$config")" && $(cat "$release/.install-unit") == "$(unit_fingerprint)" ]] && probe_running; then
      systemctl is-enabled --quiet market-spread-monitor.service || systemctl enable market-spread-monitor.service
      log '当前已是最新版本，服务健康；跳过源码下载、依赖安装、构建和重启。'
    else
      log '版本未变，仅应用配置或恢复服务；跳过源码下载、依赖安装和构建。'
      systemctl daemon-reload
      systemctl restart market-spread-monitor.service
      systemd-run --quiet --wait --pipe --collect --unit="market-spread-monitor-check-$$" --property="EnvironmentFile=$config" "$runtime/bin/node" "$release/deploy/check-install.mjs"
      probe_running || die '服务恢复后未通过检查'
      systemctl enable market-spread-monitor.service
      record_success
    fi
    describe_install
    return
  fi

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
      printf 'ALERT_DATA_DIR=/var/lib/market-spread-monitor\nOIL_FEISHU_WEBHOOK_URL=\nOIL_FEISHU_WEBHOOK_SECRET=\nOIL_POLL_INTERVAL_SECONDS=30\n'
    } > "$config"
    install -m 0600 /dev/null "$base/.credentials-unshown"
  elif [[ -n "$requested_port" ]]; then
    log '检测到已有配置，保留原端口；如需更改，请编辑 /etc/market-spread-monitor.env。'
  fi

  log '检测到需要部署的版本，正在准备源码；新版本准备完成后才会切换服务。'
  if [[ -z "$source_dir" ]]; then
    download "https://codeload.github.com/hxx344/market-spread-monitor/tar.gz/$release_id" "$scratch/source.tar.gz"
  fi
  release=$(mktemp -d "$base/releases/${release_id:0:12}-XXXXXXXX")
  chmod 0755 "$release"
  if [[ -z "$source_dir" ]]; then
    tar -xzf "$scratch/source.tar.gz" --strip-components=1 -C "$release"
  else
    tar -xzf "$scratch/source.tar.gz" -C "$release"
  fi
  [[ -f "$release/deploy/check-install.mjs" && -f "$release/deploy/install-inputs.mjs" && -f "$release/deploy/market-spread-monitor.service" && -f "$release/server/entrypoint.sh" ]] || die '发布文件不完整'
  check_config
  ln -s "$runtime" "$release/.runtime"
  dependency_key=$("$runtime/bin/node" "$release/deploy/install-inputs.mjs" "$release" "$release_id" v24.15.0 "$("$runtime/bin/node" "$runtime/lib/node_modules/npm/bin/npm-cli.js" --version)" "$architecture")
  if (( ! rebuild )) && [[ -n "$candidate" && -f "$candidate/.install-ready" && -f "$candidate/.install-dependencies" && $(cat "$candidate/.install-dependencies") == "$dependency_key" && -d "$candidate/node_modules" && ! -L "$candidate/node_modules" ]]; then
    log '依赖未变，复用已安装依赖的独立副本。'
    if cp -a --reflink=auto "$candidate/node_modules" "$release/node_modules" && [[ -x "$release/node_modules/.bin/next" && -f "$release/node_modules/.package-lock.json" ]] && (cd "$release"; "$runtime/bin/node" -e "require('next'); require('react')"); then
      reused=1
      if [[ -d "$candidate/.next/cache" ]]; then
        mkdir -p "$release/.next"
        cp -a --reflink=auto "$candidate/.next/cache" "$release/.next/cache" || rm -rf -- "$release/.next/cache"
      fi
    else
      log '依赖副本不完整，自动重新安装。'
      rm -rf -- "$release/node_modules"
    fi
  fi
  chown -R spread-monitor:spread-monitor "$release"
  (
    cd "$release"
    if (( ! reused )); then
      log '依赖发生变化或尚无缓存，正在安装依赖。'
      runuser -u spread-monitor -- env PATH="$runtime/bin:$PATH" NODE_ENV=development NEXT_TELEMETRY_DISABLED=1 npm_config_cache=/var/cache/market-spread-monitor npm ci --include=dev --include=optional --prefer-offline --no-audit --no-fund
    fi
    log '正在构建变更后的代码。'
    runuser -u spread-monitor -- env PATH="$runtime/bin:$PATH" NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 npm run build:linux
  )
  [[ -f "$release/.next/BUILD_ID" ]] || die '构建未生成可启动版本'
  sed -e "s|^WorkingDirectory=.*|WorkingDirectory=$base/current|" -e "s|^ExecStart=.*|ExecStart=/bin/bash $base/current/server/entrypoint.sh|" "$release/deploy/market-spread-monitor.service" > "$scratch/market-spread-monitor.service"
  systemd-analyze verify "$scratch/market-spread-monitor.service" 2> "$scratch/unit-check.log" || {
    # The current symlink is intentionally not switched yet. Verify using the prepared release.
    sed "s|$base/current|$release|g" "$scratch/market-spread-monitor.service" > "$scratch/check.service"
    systemd-analyze verify "$scratch/check.service" || die 'systemd 服务文件校验失败'
  }

  [[ ! -L "$base/current" ]] || old_current=$(readlink "$base/current")
  [[ ! -f "$unit" ]] || cp -p "$unit" "$scratch/previous.service"
  if systemctl is-active --quiet market-spread-monitor.service; then was_active=1; fi
  switching=1
  systemctl stop market-spread-monitor.service 2>/dev/null || { (( ! was_active )) || die '无法停止原服务'; }
  ln -s "$release" "$base/current.next"
  mv -Tf "$base/current.next" "$base/current"
  install -m 0644 "$scratch/market-spread-monitor.service" "$unit"
  systemctl daemon-reload
  systemctl start market-spread-monitor.service
  # Read EnvironmentFile through systemd itself; never execute or echo an existing config.
  systemd-run --quiet --wait --pipe --collect --unit="market-spread-monitor-check-$$" --property="EnvironmentFile=$config" "$runtime/bin/node" "$release/deploy/check-install.mjs"
  systemctl is-active --quiet market-spread-monitor.service || die '服务未保持运行'
  local main_pid
  main_pid=$(systemctl show --property=MainPID --value market-spread-monitor.service)
  [[ "$main_pid" =~ ^[1-9][0-9]*$ && $(readlink -f "/proc/$main_pid/cwd") == "$release" ]] || die '运行进程与新版本不一致'
  systemctl enable market-spread-monitor.service
  switching=0
  record_success

  log '部署完成，已启用开机启动和原油与海力士后台告警检查。'
  describe_install
}

if (( EUID != 0 )); then
  command -v sudo >/dev/null || die '请使用 root 运行，或先安装 sudo'
  # Pass the fully parsed functions, not stdin or $0: both differ under curl | bash.
  sudo bash -c "$(declare -f)"$'\nmain "$@"' -- "$@"
else
  main "$@"
fi
