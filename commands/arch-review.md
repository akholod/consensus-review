---
description: Архитектурное ревью изменения (impact, diff-scoped) через агента arch-reviewer
argument-hint: "[<PR-url|git-range|path|пусто=working tree>]"
---

Запусти субагента `arch-reviewer` через Task и верни его полный структурированный
результат без сокращений.

- `subagent_type: "arch-reviewer"` (если как плагин и не резолвится — `consensus-review:arch-reviewer`)
- Передай в промпт скоуп из аргументов ниже. Если пусто — текущее рабочее дерево (`git diff HEAD` + untracked); PR-ссылка/реф → этот PR; git range / path / glob — как есть.
- Это read-only ревью: ничего не редактируй и не коммить. После вывода результата остановись.

Скоуп: $ARGUMENTS
