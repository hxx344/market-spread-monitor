#!/usr/bin/env bash
# Run the normal installer with opt-in stage timings; never capture its output.
set -Eeuo pipefail

if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  printf '用法：bash profile-install.sh [--rebuild] [--port 3000] [--source-dir /path/to/source]\n实际执行一次正常增量部署并输出耗时排序；--rebuild 会重新安装依赖并构建。\n报告仅保存阶段、耗时与状态，不保存安装输出或配置。\n'
  exit 0
fi
[[ $(uname -s) == Linux ]] || { printf '请在需要诊断的 Linux 服务器运行。\n' >&2; exit 1; }

bootstrap_dir=$(mktemp -d /tmp/market-spread-profile-bootstrap.XXXXXXXX)
cleanup_bootstrap() {
  local status=$?
  trap - EXIT
  if [[ -d "$bootstrap_dir" && ! -L "$bootstrap_dir" && "$bootstrap_dir" == /tmp/market-spread-profile-bootstrap.* ]]; then
    rm -rf -- "$bootstrap_dir" || true
  fi
  exit "$status"
}
trap cleanup_bootstrap EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

download_start=''
download_end=''
{ read -r download_start _ < /proc/uptime; } 2>/dev/null || true
download_status=0
curl --fail --silent --show-error --location --retry 3 --connect-timeout 20 --max-time 300 \
  https://raw.githubusercontent.com/hxx344/market-spread-monitor/main/deploy/install.sh \
  -o "$bootstrap_dir/install.sh" || download_status=$?
{ read -r download_end _ < /proc/uptime; } 2>/dev/null || true
if [[ "$download_start" =~ ^[0-9]+\.[0-9]+$ && "$download_end" =~ ^[0-9]+\.[0-9]+$ ]]; then
  awk -v start="$download_start" -v end="$download_end" 'BEGIN { printf "部署脚本下载：%.3f 秒（单独计时，不含在后续部署阶段内）\n", end-start }' || true
else printf '部署脚本下载计时不可用；继续按下载结果执行。\n' >&2 || true; fi
(( download_status == 0 )) || exit "$download_status"

printf '将实际执行一次部署；默认保留增量复用规则。\n' || true
# A separate Bash process retains the installer's errexit and EXIT rollback.
# No pipe or tee: passwords printed by a first install never enter the report.
bash "$bootstrap_dir/install.sh" --profile "$@"
