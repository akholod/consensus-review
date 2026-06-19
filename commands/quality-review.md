---
description: Ревью поддерживаемости и качества кода через агента quality-reviewer
argument-hint: "[<PR-url|git-range|path|пусто=working tree>]"
---

Запусти субагента `quality-reviewer` через Task и верни его полный структурированный
результат без сокращений.

- `subagent_type: "quality-reviewer"` (если как плагин и не резолвится — `consensus-review:quality-reviewer`)
- Передай в промпт скоуп из аргументов ниже. Если пусто — текущее рабочее дерево (`git diff HEAD` + untracked); PR-ссылка/реф → этот PR; git range / path / glob — как есть.
- Это read-only ревью: ничего не редактируй и не коммить. После вывода результата остановись.

Скоуп: $ARGUMENTS
