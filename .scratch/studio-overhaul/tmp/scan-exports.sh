#!/bin/bash
# 零引用导出扫描：提取 export 符号，grep 全仓引用
cd /root/projects/studio
SCOPE="$1"   # 如 packages/studio-shared/src 或 apps/api/src
EXCLUDE_DEFINING_ONLY=1
tmp=.scratch/studio-overhaul/tmp
grep -rhoE "^export (async )?(function|class|const|let|var|interface|type|enum) [A-Za-z0-9_]+" "$SCOPE" --include='*.ts' --include='*.tsx' \
  | awk '{print $NF}' | sort -u > $tmp/names1.txt
# 单行 export { a, b as c }
grep -rhE "^export \{[^}]+\}" "$SCOPE" --include='*.ts' --include='*.tsx' \
  | sed -E 's/^export \{//; s/\}.*//; s/,/\n/g; s/ as [A-Za-z0-9_]+//; s/ //g; s/type//' | grep -v '^$' | sort -u > $tmp/names2.txt
cat $tmp/names1.txt $tmp/names2.txt | sort -u > $tmp/names.txt
echo "total exported symbols: $(wc -l < $tmp/names.txt)"
while read -r name; do
  [ -z "$name" ] && continue
  # 找定义文件
  defhits=$(grep -rlE "export (async )?(function|class|const|let|var|interface|type|enum) $name\b|export \{[^}]*\b$name\b" "$SCOPE" --include='*.ts' --include='*.tsx' 2>/dev/null)
  # 全仓使用（含 packages/apps/scripts/tests），排除定义文件与测试
  usehits=$(grep -rlw "$name" apps packages scripts tests --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v node_modules)
  real=$(echo "$usehits" | grep -v __tests__ | grep -v '\.test\.' )
  for d in $defhits; do real=$(echo "$real" | grep -v "^$d$"); done
  # 排除 re-export barrel 命中（index.ts 纯转发不算消费）
  realnonbarrel=""
  for r in $real; do
    if grep -qE "^export .* from " "$r" && ! grep -qE "^import" "$r"; then continue; fi
    # barrel 文件里若有 import 该行符号再 export 也算转发；简化：检查是否有非 export 行使用该符号
    if grep -E "\b$name\b" "$r" | grep -vqE "^export |^import .* from |^\s*\*"; then
      realnonbarrel="$realnonbarrel $r"
    fi
  done
  if [ -z "$(echo $realnonbarrel | tr -d ' ')" ]; then
    echo "ZERO-REF: $name (def: $(echo $defhits | tr '\n' ' '))"
  fi
done < $tmp/names.txt
