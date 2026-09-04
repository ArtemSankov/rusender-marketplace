#!/usr/bin/env bash
# Проверяет сценарии уроков на соответствие протоколу курса.
# Запуск:  ${CLAUDE_PLUGIN_ROOT}/skills/rusender-course/scripts/lint-lesson.sh              — все модули
#          ${CLAUDE_PLUGIN_ROOT}/skills/rusender-course/scripts/lint-lesson.sh modules/3-domain/GUIDE.md
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

RED=$'\033[31m'; YEL=$'\033[33m'; GRN=$'\033[32m'; DIM=$'\033[2m'; OFF=$'\033[0m'
errors=0; warnings=0

# Обороты, по которым текст опознаётся как машинный
SLOP=(
  "важно понимать" "стоит отметить" "в современном мире" "давайте разберёмся"
  "ключевой момент" "важный нюанс" "идеально подходит для" "позволяет значительно"
  "в первую очередь стоит" "на самом деле всё просто" "не просто "
)
# Термины, которых не должно быть в уроке ни в речи, ни в инструкциях
TECH=( "public_" "withStats" "limit:" "JSON" "эндпоинт" "пагинац" "пейлоад" )

check_file () {
  local f="$1" problems=0
  echo "${DIM}── $f${OFF}"

  # 1. Обязательные секции
  for sec in "## Твоя роль" "## Цели модуля" "## Ход обучения" "## Важные заметки для Claude" "## Критерии успеха"; do
    grep -q "^$sec" "$f" || { echo "  ${RED}нет секции:${OFF} $sec"; problems=1; }
  done

  # 2. Интерактивность: без СТОП урок превращается в лекцию
  local stops; stops=$(grep -c "СТОП" "$f")
  if [ "$stops" -lt 2 ]; then
    echo "  ${RED}точек СТОП: $stops${OFF} — урок не ждёт человека"; problems=1
  fi
  grep -q "СКАЖИ" "$f" || { echo "  ${RED}нет блоков СКАЖИ${OFF}"; problems=1; }

  # 3. Переход в следующий модуль и его существование
  local next; next=$(grep -oE '/rusender-course [0-9]+' "$f" | tail -1 | grep -oE '[0-9]+$')
  if [ -z "$next" ]; then
    grep -qi "курс закончен\|курс пройден\|курс завершён\|сборка заканчивается" "$f" \
      || { echo "  ${RED}нет перехода${OFF} в следующий модуль"; problems=1; }
  else
    ls -d modules/${next}-* >/dev/null 2>&1 \
      || { echo "  ${RED}переход на несуществующий модуль:${OFF} $next"; problems=1; }
  fi

  # 4. Нейрослоп
  for p in "${SLOP[@]}"; do
    if grep -qi -- "$p" "$f"; then
      echo "  ${RED}оборот из стоп-листа:${OFF} «$p»  ${DIM}$(grep -in -m1 -- "$p" "$f" | cut -c1-90)${OFF}"
      problems=1
    fi
  done

  # 5. Технические термины
  for p in "${TECH[@]}"; do
    if grep -q -- "$p" "$f"; then
      echo "  ${YEL}технический термин:${OFF} «$p»  ${DIM}$(grep -n -m1 -- "$p" "$f" | cut -c1-90)${OFF}"
      warnings=$((warnings+1))
    fi
  done

  # 6. Запасной путь для пустого аккаунта
  grep -qE "пуст|нет данных|нечего показать|демо|Путь Б|ещё не" "$f" \
    || { echo "  ${YEL}не видно запасного пути${OFF} для пустого аккаунта"; warnings=$((warnings+1)); }

  # 7. Эмодзи как маркеры разделов (в заголовках)
  local bad_head
  bad_head=$(grep -E "^#{2,3} .*(🎉|🚀|✨|🎯|🔥|📊|💪|👍|📈|🏆|😀|🙂|🥳)" "$f" 2>/dev/null | grep -v "⚠️\|🔒\|💡" || true)
  if [ -n "$bad_head" ]; then
    echo "  ${YEL}эмодзи в заголовке раздела:${OFF} ${DIM}$(echo "$bad_head" | head -1 | cut -c1-60)${OFF}"
    warnings=$((warnings+1))
  fi

  if [ "$problems" -eq 0 ]; then echo "  ${GRN}ок${OFF}"; else errors=$((errors+1)); fi
}

if [ $# -gt 0 ]; then
  for f in "$@"; do check_file "$f"; done
else
  for f in modules/*/GUIDE.md; do check_file "$f"; done
fi

echo
if [ "$errors" -gt 0 ]; then
  echo "${RED}Файлов с ошибками: $errors${OFF}, предупреждений: $warnings"
  exit 1
else
  echo "${GRN}Все проверки пройдены${OFF}, предупреждений: $warnings"
fi
