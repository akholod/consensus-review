---
description: Ревью качества тестов через агента test-reviewer
argument-hint: "[<PR-url|git-range|path|пусто=working tree>]"
---

Запусти субагента `test-reviewer` через Task и верни его полный структурированный
результат без сокращений.

- `subagent_type: "test-reviewer"` (если как плагин и не резолвится — `consensus-review:test-reviewer`)
- Передай в промпт скоуп из аргументов ниже. Если пусто — тесты, связанные с текущим рабочим деревом; PR-ссылка/реф → этот PR; git range / path / glob — как есть.
- Это read-only ревью: ничего не редактируй и не коммить. После вывода результата остановись.

Скоуп: $ARGUMENTS
