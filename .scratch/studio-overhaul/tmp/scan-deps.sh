#!/bin/bash
# 冗余依赖扫描：对每个 package.json 的依赖，检查全仓是否有 import/require/字符串使用
cd /root/projects/studio
for pj in package.json apps/*/package.json packages/*/package.json; do
  dir=$(dirname "$pj")
  deps=$(node -e "const p=require('./$pj'); console.log(Object.keys({...p.dependencies,...p.devDependencies}).join('\n'))")
  echo "=== $pj ==="
  while read -r dep; do
    [ -z "$dep" ] && continue
    case "$dep" in @dommaker/*) continue;; esac   # workspace 包单独人工查
    # 源码/脚本/测试/配置中的 import/require/字符串引用
    hits=$(grep -rn --include='*.ts' --include='*.tsx' --include='*.mts' --include='*.cts' --include='*.js' --include='*.mjs' --include='*.cjs' --include='*.json' --include='*.yaml' --include='*.yml' \
      -e "from '$dep" -e "from \"$dep" -e "require('$dep" -e "require(\"$dep" -e "import('$dep" -e "import(\"$dep" \
      apps packages scripts tests bin *.config.* *.json .github 2>/dev/null | grep -v node_modules | grep -v package.json | grep -v pnpm-lock | grep -v dist/ | head -3)
    if [ -z "$hits" ]; then
      # 配置文件字符串形式（vite/eslint/postcss/tailwind 插件等）
      cfg=$(grep -rn "$dep" vite.config.* vitest*.config.* postcss.config.* tailwind.config.* eslint.config.* playwright.config.* .eslintrc* 2>/dev/null | grep -v node_modules | head -2)
      if [ -z "$cfg" ]; then echo "UNUSED-DEP: $dep"; else echo "CFG-ONLY: $dep :: $(echo "$cfg" | head -1)"; fi
    fi
  done <<< "$deps"
done
