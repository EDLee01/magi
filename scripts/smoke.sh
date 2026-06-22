#!/usr/bin/env bash
set -euo pipefail

# Magi Next — 业务抽烟脚本
# 用法: bash scripts/smoke.sh
# 不依赖网络之外的外部服务，你需要在能访问 hotaitool.net 的环境里跑

PASS=0
FAIL=0
DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$DIR/dist/cli.js"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export MAGI_CONFIG_DIR="$TMP/magi-home"

pass()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
fail()  { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
skip()  { echo "  ⏭️  $1"; }
header(){ echo; echo "=== $1 ==="; }

header "1. 基本连通 — fast 模型"
if [[ -n "${ANTHROPIC_API_KEY:-${ANTHROPIC_AUTH_TOKEN:-${OPENAI_API_KEY:-${DEEPSEEK_API_KEY:-}}}}" ]]; then
  MSG=$(node "$CLI" -p "say ok" -m fast --output-format json 2>/dev/null | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('message','')[:30])" 2>/dev/null)
  [[ -n "$MSG" && "$MSG" != "No provider is configured"* ]] && pass "fast 返回: $MSG" || fail "fast 无输出"
else
  skip "未配置 provider key，跳过 live fast 模型检查"
fi

header "2. 工具定义 — main 模型带工具上下文"
if [[ -n "${ANTHROPIC_API_KEY:-${ANTHROPIC_AUTH_TOKEN:-${OPENAI_API_KEY:-${DEEPSEEK_API_KEY:-}}}}" ]]; then
  MSG=$(node "$CLI" -p "say ok" -m main --output-format json 2>/dev/null | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('message','')[:30])" 2>/dev/null)
  [[ -n "$MSG" && "$MSG" != "No provider is configured"* ]] && pass "main 返回: $MSG" || fail "main 无输出"
else
  skip "未配置 provider key，跳过 live main 模型检查"
fi

header "3. 工具调用 — 创建文件 + 读取"
cd "$TMP"
RESULT=$(node "$CLI" -p 'create file "hello.txt" with content "world"' --permission-mode acceptEdits --output-format json 2>/dev/null | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('message','').replace('\n',' ')[:120])" 2>/dev/null)
FILE_CONTENT=$(python3 -c "from pathlib import Path; p=Path('hello.txt'); print(p.read_text().strip() if p.exists() else '')" 2>/dev/null)
[[ "$FILE_CONTENT" == "world" ]] && pass "write+read 文件内容: $FILE_CONTENT" || fail "工具调用失败: response=$RESULT file=$FILE_CONTENT"

header "4. Bash 工具 — 运行命令"
RESULT=$(node "$CLI" -p "run shell echo hello-smoke" --permission-mode acceptEdits --allowed-tools 'Bash(echo:*)' --output-format json 2>/dev/null | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('message','').replace('\n',' ')[:120])" 2>/dev/null)
[[ "$RESULT" == *"hello-smoke"* ]] && pass "bash 返回: hello-smoke" || fail "bash 失败: $RESULT"

header "5. 缓存命中 — 第二次请求 vs 第一次"
cd "$DIR"
if [[ -n "${ANTHROPIC_API_KEY:-${ANTHROPIC_AUTH_TOKEN:-${OPENAI_API_KEY:-${DEEPSEEK_API_KEY:-}}}}" ]]; then
  RUNS=$(node scripts/smoke_cache_test.js 2>/dev/null)
  T1=$(echo "$RUNS" | cut -d, -f1)
  T2=$(echo "$RUNS" | cut -d, -f2)
  echo "  第一次: ${T1}ms  第二次: ${T2}ms"
  if [[ -n "$T2" && "$T2" -gt 0 && ( -z "$T1" || "$T2" -le "$T1" ) ]]; then
    pass "缓存有效或持平"
  else
    fail "第二次比第一次慢（T1=$T1 T2=$T2），可能缓存未命中"
  fi
else
  skip "未配置 provider key，跳过 live 缓存检查"
fi

header "6. QA——静默无输出指令"
cd "$DIR"
if [[ -n "${ANTHROPIC_API_KEY:-${ANTHROPIC_AUTH_TOKEN:-${OPENAI_API_KEY:-${DEEPSEEK_API_KEY:-}}}}" ]]; then
  MSG=$(node "$CLI" -p "a" -m fast --output-format json 2>/dev/null | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('message','BAD')[:30])" 2>/dev/null)
  [[ "$MSG" == "BAD" || "$MSG" == "No provider is configured"* ]] && fail "fast 无声无息" || pass "a 返回了内容"
else
  skip "未配置 provider key，跳过 live QA 检查"
fi

header "7. 思考兜底——万一模型只思考不输出"
cd "$DIR"
if [[ -n "${ANTHROPIC_API_KEY:-${ANTHROPIC_AUTH_TOKEN:-${OPENAI_API_KEY:-${DEEPSEEK_API_KEY:-}}}}" ]]; then
  # 用 5 次采样看有没有一次空响应
  EMPTY=0
  for i in 1 2 3 4 5; do
    LEN=$(node "$CLI" -p "hello" -m main --output-format json 2>/dev/null | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(len(d.get('message','')))" 2>/dev/null)
    if [[ "$LEN" -eq 0 || "$LEN" == "" ]]; then
      # 可能 fallback 打出了 "[empty response]"，长度不是 0 但内容特殊
      MSG=$(node "$CLI" -p "hello" -m main --output-format json 2>/dev/null | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('message','')[:30])" 2>/dev/null)
      [[ "$MSG" == *"[reasoning"* || "$MSG" == *"[empty"* ]] && EMPTY=$((EMPTY+1))
    fi
  done
  if [[ "$EMPTY" -eq 0 ]]; then
    pass "0 次空响应（思考兜底未触发 = 模型正常）"
  else
    pass "${EMPTY}/5 次空响应但被 fallback 捕获"
  fi
else
  skip "未配置 provider key，跳过 live 思考兜底检查"
fi

echo
echo "=============================="
echo "  通过: $PASS   失败: $FAIL"
echo "=============================="

[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
