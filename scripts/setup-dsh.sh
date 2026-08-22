#!/usr/bin/env bash
# 一键准备 dsh 依赖：clone 公开仓库到本仓库同级目录，checkout 锁定 commit 并构建。
# 本项目以 pnpm link: 引用 ../deepseek-harness（原因见 README「依赖 dsh 的方式」）。
set -euo pipefail

DSH_REPO="${DSH_REPO:-https://github.com/deepseek-ai/deepseek-harness.git}"
DSH_COMMIT="${DSH_COMMIT:-47f943859b}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
parent_dir="$(cd "$script_dir/../.." && pwd)"
dsh_dir="$parent_dir/deepseek-harness"

if [ ! -d "$dsh_dir/.git" ]; then
  echo "==> clone $DSH_REPO -> $dsh_dir"
  git clone "$DSH_REPO" "$dsh_dir"
fi

cd "$dsh_dir"

current="$(git rev-parse HEAD)"
if [ "${current#"$DSH_COMMIT"}" = "$current" ]; then
  echo "==> checkout 锁定 commit $DSH_COMMIT（当前 ${current:0:10}）"
  git fetch origin
  git checkout "$DSH_COMMIT"
else
  echo "==> 已在锁定 commit $DSH_COMMIT"
fi

echo "==> pnpm install && pnpm build"
pnpm install
pnpm build

echo "==> dsh 就绪。回到项目目录执行：pnpm install && pnpm test"
