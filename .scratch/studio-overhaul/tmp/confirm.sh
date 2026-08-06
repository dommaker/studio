#!/bin/bash
# 二次确认：对 ZERO-REF 候选分类 TOTALLY-DEAD / INTERNAL-ONLY / TEST-ONLY
cd /root/projects/studio
in="$1"; out="$2"
: > "$out"
grep ZERO-REF "$in" | sort -u | while read -r line; do
  name=$(echo "$line" | sed -E 's/ZERO-REF: ([A-Za-z0-9_]+).*/\1/')
  def=$(echo "$line" | sed -E 's/.*\(def: (.*) \)/\1/')
  # 所有出现（排除 export 声明行、node_modules）
  all=$(grep -rn "\b$name\b" apps packages scripts tests --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v node_modules | grep -vE ":\s*export (async )?(function|class|const|let|var|interface|type|enum) $name\b" | grep -vE ":\s*export \{[^}]*\b$name\b[^}]*\}")
  # 排除 export ... from 转发行
  all=$(echo "$all" | grep -vE ":\s*export \* from|:\s*export \{[^}]*\} from" )
  nontest=$(echo "$all" | grep -v __tests__ | grep -v '\.test\.')
  if [ -z "$(echo "$all" | tr -d '[:space:]')" ]; then
    echo "DEAD-TOTAL: $name (def: $def)" >> "$out"
  elif [ -z "$(echo "$nontest" | tr -d '[:space:]')" ]; then
    echo "TEST-ONLY: $name (def: $def) :: $(echo "$all" | cut -d: -f1 | sort -u | tr '\n' ' ')" >> "$out"
  else
    echo "INTERNAL-ONLY: $name (def: $def) :: $(echo "$nontest" | cut -d: -f1 | sort -u | tr '\n' ' ')" >> "$out"
  fi
done
sort "$out" -o "$out"
