#!/bin/bash
# 把 INTERNAL-ONLY 细分为 SELF-ONLY（仅定义文件内部使用）与 IMPORT-UNUSED（被 import 但从未在代码体使用）
cd /root/projects/studio
in="$1"
grep ^INTERNAL-ONLY "$in" | while read -r line; do
  def=$(echo "$line" | sed -E 's/.*\(def: ([^)]*)\).*/\1/' | tr ' ' '\n' | sort -u)
  refs=$(echo "$line" | sed -E 's/.*:: //' | tr ' ' '\n' | sort -u)
  extra=$(comm -13 <(echo "$def") <(echo "$refs") )
  if [ -z "$extra" ]; then echo "SELF-ONLY: $(echo "$line" | sed 's/^INTERNAL-ONLY: //')"; else echo "IMPORT-DEAD: $(echo "$line" | sed 's/^INTERNAL-ONLY: //')"; fi
done
