#!/usr/bin/env bash
# 前后端契约校验（首版仅做 SSE 事件类型校验）
#
# 规则：前端 SSEEventType 必须 ⊆ 后端 EventTypeXxx 常量值
# 不一致时输出 ⚠️ 清单，但 exit 0 不阻塞 CI（warning only）。
#
# 数据源：
#   后端：mooc-manus/internal/domains/models/events/constants.go
#         （仅取以 EventType 开头的常量字符串值）
#   前端：mooc-manus-web/src/types/sse.ts
#         （仅取 SSEEventType 联合类型的字符串字面量）
set -uo pipefail

BACK_FILE="${BACK_FILE:-mooc-manus/internal/domains/models/events/constants.go}"
FRONT_FILE="${FRONT_FILE:-mooc-manus-web/src/types/sse.ts}"

if [ ! -f "$BACK_FILE" ]; then
  echo "⚠️  后端事件源缺失: $BACK_FILE（跳过契约校验）"
  exit 0
fi
if [ ! -f "$FRONT_FILE" ]; then
  echo "⚠️  前端事件源缺失: $FRONT_FILE（跳过契约校验）"
  exit 0
fi

# 1. 提取后端事件值：行首匹配 EventType...= "value"
back_events=$(awk '
  /^[[:space:]]*EventType[A-Za-z0-9_]+[[:space:]]*=[[:space:]]*"[^"]+"/ {
    if (match($0, /"[^"]+"/)) {
      print substr($0, RSTART+1, RLENGTH-2)
    }
  }
' "$BACK_FILE" | sort -u)

# 2. 提取前端事件值：SSEEventType 联合类型的 | 'foo' 行
#    捕获从 `export type SSEEventType =` 起到分号止（含分号所在行）的所有字符串字面量
front_events=$(awk "
  /export type SSEEventType[[:space:]]*=/ {capture=1; next}
  capture {
    if (match(\$0, /'[^']+'/)) {
      print substr(\$0, RSTART+1, RLENGTH-2)
    }
    if (/;/) capture=0
  }
" "$FRONT_FILE" | sort -u)

if [ -z "$back_events" ]; then
  echo "⚠️  未从 $BACK_FILE 解析到后端事件常量（脚本逻辑或源文件结构变化？）"
  exit 0
fi
if [ -z "$front_events" ]; then
  echo "⚠️  未从 $FRONT_FILE 解析到前端 SSEEventType 联合（脚本逻辑或源文件结构变化？）"
  exit 0
fi

back_count=$(echo "$back_events" | wc -l | tr -d ' ')
front_count=$(echo "$front_events" | wc -l | tr -d ' ')

echo "ℹ️  后端事件 ${back_count} 种，前端订阅 ${front_count} 种"

# 3. 校验前端 ⊆ 后端
missing=""
while IFS= read -r ev; do
  [ -z "$ev" ] && continue
  if ! echo "$back_events" | grep -qxF "$ev"; then
    missing="${missing}${ev}\n"
  fi
done <<< "$front_events"

# 4. 同时给出后端独有事件（前端未订阅，仅 info）
only_back=""
while IFS= read -r ev; do
  [ -z "$ev" ] && continue
  if ! echo "$front_events" | grep -qxF "$ev"; then
    only_back="${only_back}${ev}\n"
  fi
done <<< "$back_events"

if [ -n "$missing" ]; then
  echo "⚠️  前端订阅但后端未定义的事件（违规）:"
  printf "$missing" | sed 's/^/    - /'
fi
if [ -n "$only_back" ]; then
  echo "ℹ️  后端定义但前端未订阅的事件（仅参考）:"
  printf "$only_back" | sed 's/^/    - /'
fi

if [ -z "$missing" ]; then
  echo "✅ SSE 事件契约：前端 ⊆ 后端"
fi

# warning only：永不阻塞 CI
exit 0
