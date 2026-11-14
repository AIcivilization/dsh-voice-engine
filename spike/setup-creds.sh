#!/bin/sh
# 把讯飞凭据写进本机文件（权限 600）。输入时不回显，也不进 shell 历史。
set -eu

dir="${DSH_HOME:-$HOME/.dsh}/dsh-xfyun"
file="$dir/credentials.json"

printf 'AppID（控制台应用详情里的字母数字，不是邮箱）: '
IFS= read -r app_id
# 提问顺序和控制台的显示顺序一致（APPID、APISecret、APIKey），否则很容易填反
printf 'APISecret（输入不显示；用 ak- 密钥时直接回车跳过）: '
stty -echo
IFS= read -r api_secret
stty echo
printf '\nAPIKey（输入不显示）: '
stty -echo
IFS= read -r api_key
stty echo
printf '\n'

mkdir -p "$dir"
chmod 700 "$dir"
umask 077
spike_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
XF_APP_ID="$app_id" XF_API_KEY="$api_key" XF_API_SECRET="$api_secret" XF_LIB="$spike_dir/xf.mjs" node --input-type=module -e '
  import { writeFileSync } from "node:fs"
  const { credentialProblem } = await import(process.env.XF_LIB)
  const { XF_APP_ID: appId, XF_API_KEY: apiKey, XF_API_SECRET: apiSecret } = process.env
  const problem = credentialProblem({ appId, apiKey, apiSecret })
  if (problem) { console.error(problem + "，没有保存。"); process.exit(1) }
  writeFileSync(process.argv[1], JSON.stringify({ appId, apiKey, apiSecret }, null, 2) + "\n", { mode: 0o600 })
' "$file"
chmod 600 "$file"
echo "已保存到 $file"
