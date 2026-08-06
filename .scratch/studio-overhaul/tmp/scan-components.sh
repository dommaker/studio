#!/bin/bash
# 扫描 apps/web 的 components/pages/hooks/stores/utils/api 文件是否被引用
cd /root/projects/studio
SEARCH_DIRS="apps/web/src apps/api/src packages scripts tests"
for f in $(find apps/web/src/components apps/web/src/pages apps/web/src/hooks apps/web/src/stores apps/web/src/utils apps/web/src/contexts -name '*.ts' -o -name '*.tsx' | grep -v __tests__ | grep -v '\.test\.' | grep -v '\.d\.ts'); do
  stem=$(basename "$f" | sed 's/\.tsx\?$//')
  # 引用判定：其它文件中出现该 stem（import 路径或标识符）
  hits=$(grep -rln --include='*.ts' --include='*.tsx' -w "$stem" $SEARCH_DIRS 2>/dev/null | grep -v "^$f$" | grep -v node_modules)
  # 排除自身目录下 __tests__ 命中后判断是否还有真实消费方
  real=$(echo "$hits" | grep -v __tests__ | grep -v '\.test\.')
  if [ -z "$real" ]; then
    echo "CANDIDATE: $f"
    echo "  test-only hits: $(echo "$hits" | grep -v '^$' | tr '\n' ' ')"
  fi
done
