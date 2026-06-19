---
description: Консенсус-код-ревью (Opus-арбитр + codex + opencode) по 4 измерениям (архитектура/качество/impact/тесты) для PR или незакоммиченных изменений; находки P0–P2; режимы [sceptic] [codex-only]
argument-hint: "[<PR-url|owner/repo#N|#N>] [sceptic] [codex-only] [arch] [deep|minimal]"
---

Ты — **Opus-арбитр** консенсус-ревью. Ревью идёт по **измерениям** (что проверять)
силами **независимых** ревьюеров (кто проверяет): твои dimension-агенты + `codex` +
`opencode`. Сведи всё в единый консенсус-отчёт с находками P0–P2.
Это **read-only** ревью: ничего не чинить, не коммитить, не пушить, не комментить PR.
Единственная запись — markdown-файл отчёта.

Аргументы: `$ARGUMENTS`

## 0. Разбор аргументов
- PR-URL / `owner/repo#N` / `#N` в аргументах → **режим PR**. Иначе → **режим uncommitted**.
- `sceptic` (или `--sceptic`) → **sceptic ON**.
- `codex-only` (или `--codex-only`) → **codex-only ON**: opencode не используется (полезно, если он не установлен/не залогинен).
- `arch` (или `--arch`) → принудительно включить архитектурное измерение, даже если изменение не структурное.
- `deep` / `full` → принудительно максимальный тир (вся панель + оба консультанта), минуя авто-классификацию.
- `minimal` → принудительно минимальный тир (impact + codex), минуя авто-классификацию.

## 1. Резолв diff и контекста
Рабочая папка **вне репо**: `WD=$(mktemp -d)` (в `/tmp`, не под repo — иначе засоришь `git status`).

**Режим PR:**
- Разрешение репо для `gh`: полный URL самодостаточен. Для `owner/repo#N` и `#N` передавай `-R <owner/repo>` (иначе `gh pr diff` из не-git каталога падает «not a git repository»). Голый `#N` без owner/repo: попробуй вывести репо из git-remote cwd, иначе останови и попроси `owner/repo#N` или URL.
- `gh pr diff <target> [-R …] > "$WD/diff.patch"`
- `gh pr view <target> [-R …] --json title,baseRefName,headRefName,url` (только метаданные, **без** `body`).
- `REPO` = текущий клон, если соответствует PR; иначе **diff-only режим** (пометь в отчёте).

**Режим uncommitted:**
- `git diff HEAD > "$WD/diff.patch"`; untracked через `git status --porcelain`.
- Пусто и нет untracked → «Нет изменений для ревью» и **стоп**.
- `REPO` = корень текущего репозитория.

## 2. Pre-flight health-check
`codex --version`; если **codex-only OFF** — ещё `opencode --version`. Недоступный тул помечается `unavailable`, его lane пропускается (не жди таймаута). При codex-only opencode не проверяется (статус: `skipped (codex-only)`).

**Код-граф (если ревью в каталоге проекта).** Проверь наличие готового код-графа: `.codegraph/codegraph.db` (codegraph) или `graphify-out/graph.json` (graphify). Если есть — зафиксируй `CODE_GRAPH=codegraph|graphify` и используй его дальше (триаж blast-radius + бриф консультантам + dimension-агенты сами его подхватят). **Только детект-и-используй, граф НЕ строй** (построение graphify тратит токены). Нет графа → обычный grep, это не проблема.

## 3. Триаж: классификация изменения (ДО запуска ревьюеров)
Цель — не гонять всю панель там, где это не нужно (напр. PR на 2000 строк руками
добавленных Bruno-конфигов имеет нулевой code-impact). Размер сам по себе не сигнал —
важны «эффективный код» и blast radius.

**3.1. Раздели изменённые файлы на классы** (`git diff --numstat` / `gh pr diff` + имена; учитывай added/renamed/deleted):
- **non-code (нулевой/низкий impact)** — Bruno/Postman/HTTP (`*.bru`, `*.http`, `*.rest`, postman collections); lock-файлы (`*-lock.json`, `*.lock`, `pnpm-lock.yaml`, `yarn.lock`, `go.sum`, `Cargo.lock`, `poetry.lock`, `composer.lock`); доки (`*.md`, `*.mdx`, `*.rst`, `docs/**`, `LICENSE`); ассеты (изображения, шрифты, `*.svg`); данные/фикстуры (`*.csv`, `__snapshots__/`, `*.snap`, fixtures/); сгенерированное (`dist/`, `build/`, `*.min.*`, `*.generated.*`, `*.pb.go`); i18n (`locales/**`, `*.po`).
- **config-as-code (средний impact — рантайм/деплой)** — конфиги `*.json|*.yaml|*.toml`, `Dockerfile`, CI (`.github/workflows/**`), IaC (`*.tf`), env-шаблоны.
- **manifests зависимостей (impact + security)** — `package.json`, `go.mod`, `Cargo.toml`, `requirements.txt`, `pyproject.toml`, `pom.xml`, `build.gradle`.
- **migrations (высокий impact)** — `migrations/**`, `*.sql`.
- **tests** — пути по паттернам `*test*`, `*spec*`, `__tests__/`, `*.test.*`, `*.spec.*`, `*_test.go`, `test_*.py`, `*Test.*`.
- **source code** — остальной исполняемый код.

**3.2. Эффективный размер кода** — строки/файлы ТОЛЬКО в классах source/config-as-code/manifests/migrations/tests (non-code исключи из размера, но запомни для отчёта):
`none` (0 кода) / `small` (≲50 строк или ≲3 файлов) / `medium` (≲~400 строк или ≲~15 файлов) / `large` (больше).

**3.3. Blast radius** — насколько изменение аффектит остальной код:
- `wide` — затронуты manifests зависимостей, migrations, auth/permissions/security пути, публичный/экспортируемый API, shared/common/core/lib/packages модули, ИЛИ у изменённых модулей высокий fan-in. Fan-in оценивай через код-граф, если `CODE_GRAPH` есть: `codegraph impact <symbol>` / `codegraph callers <symbol>` или `graphify explain "<Symbol>"` / `graphify path`; иначе — `grep -r` по импортам (фолбэк).
- `isolated` — новый самодостаточный leaf-файл / тест / конфиг / док без потребителей.
- иначе `local`.

**3.4. Назначь тир** (флаги `deep`/`minimal` имеют приоритет над авто-классификацией):
- **T0 trivial** — `none` кода (только non-code).
- **T1 minimal** — `small` + `isolated`.
- **T2 standard** — `small`/`medium` + `local`, либо `medium` + `isolated`.
- **T3 deep** — `large`, ИЛИ `blast=wide` (при любом размере), ИЛИ структурное изменение.

**3.5. Маппинг тира → измерения и источники:**

| Тир | DIMS (Opus-агенты) | Консультанты | Sceptic |
|---|---|---|---|
| T0 trivial | — (полную панель не запускаем) | — | off |
| T1 minimal | impact | codex | off |
| T2 standard | impact + quality (+ tests если есть тесты) | codex + opencode | off |
| T3 deep | impact + quality + architecture (+ tests если есть тесты) | codex + opencode | off (sceptic по флагу) |

Модификаторы поверх тира:
- `arch`-флаг добавляет architecture в любом тире; tests добавляются только при наличии тест-файлов в diff.
- `codex-only` убирает opencode на любом тире; `sceptic` включает sceptic-проход (раздел 8) на любом тире.
- **T0:** не запускай агентов/консультантов. Сделай лёгкий проход сам (Opus): бегло проверь non-code на грубые ошибки (битый JSON/YAML, очевидные опечатки в конфигах) и выдай КОРОТКИЙ отчёт с классификацией и пометкой «no code-impacting changes — full panel skipped (override: `deep`)». Не молчи о пропущенном.

Зафиксируй `TIER`, `DIMS` и набор консультантов — они управляют разделом 5. Покажи классификацию пользователю до запуска (одной строкой).

## 4. Общий бриф (МИНИМАЛЬНЫЙ и НЕ наводящий)
Один бриф для codex/opencode (Opus-агенты получают свой scope отдельно). Сохраняет независимость: **не** перечисляй конкретные гипотезы и **не** давай примеров находок. Бриф содержит:
- Абсолютный путь к `$WD/diff.patch` + разрешение читать репо для контекста.
- Если `CODE_GRAPH` есть — укажи консультантам использовать его CLI для поиска связей/влияния вместо широкого grep: codegraph `callers`/`callees`/`impact`/`node`/`search`, либо graphify `explain`/`path`/`query` (матчинг подстрочный, без синонимов). Граф НЕ строить; для новых символов из diff — сам diff.
- **Только применимые измерения** из `DIMS` с краткой рубрикой каждого (1–3 строки сути):
  - *architecture* — границы шаров/модулей, протекание абстракций, соответствие парадигмы, управляемость сложности (essential vs accidental).
  - *quality* — конвенции проекта, дюпликация/reuse, AI-slop, целостность контрактов в production-коде, контроль скоупа.
  - *impact* — корректность, регрессии и влияние на смежные/зависимые части, безопасность, безопасность миграций/деплоя.
  - *tests* — защищают ли тесты критичное поведение, пропущенные сценарии, корректность mock/fixture, слой тестов.
- Рубрику severity: **P0** блокер (неверное поведение, безопасность, потеря данных, краш, breaking change); **P1** важное, не блокер; **P2** мелочи.
- Enum категорий: `security|correctness|perf|maintainability|tests|style`.
- Требование выдать находки строго по схеме (см. ниже), каждой проставить `dimension` из `DIMS`.

Схема находок (запиши в `$WD/findings.schema.json` для codex):
```json
{
  "type": "object",
  "properties": {
    "findings": { "type": "array", "items": {
      "type": "object",
      "properties": {
        "title": {"type": "string"},
        "file": {"type": "string"},
        "line": {"type": "string"},
        "severity": {"type": "string", "enum": ["P0","P1","P2"]},
        "dimension": {"type": "string", "enum": ["architecture","quality","impact","tests"]},
        "category": {"type": "string", "enum": ["security","correctness","perf","maintainability","tests","style"]},
        "rationale": {"type": "string"},
        "suggested_fix": {"type": "string"}
      },
      "required": ["title","file","severity","dimension","rationale"]
    }}
  },
  "required": ["findings"]
}
```

## 5. Запуск ревью (независимые источники, параллельно)

**Opus-лана — dimension-агенты.** Для КАЖДОГО измерения из `DIMS` запусти соответствующего субагента через Task (можно параллельно, в одном сообщении):
- architecture → `Task(subagent_type="arch-reviewer")`
- quality → `Task(subagent_type="quality-reviewer")`
- impact → `Task(subagent_type="impact-reviewer")`
- tests → `Task(subagent_type="test-reviewer")`
Примечание: при установке как плагин агенты могут быть namespaced — если bare-имя не резолвится, используй `consensus-review:arch-reviewer`, `consensus-review:quality-reviewer`, `consensus-review:impact-reviewer`, `consensus-review:test-reviewer`.
Передай каждому: путь к `$WD/diff.patch`, `REPO`, режим (PR/uncommitted/diff-only). Их структурированный вывод — это твоя (Opus) доля находок, каждая уже несёт своё `dimension`.

**Запускай только то, что назначено тиром (раздел 3.5):** T0 — ни агентов, ни консультантов (короткий отчёт); T1 — impact-агент + codex; T2/T3 — назначенные агенты + codex + opencode. `arch`/`tests`/`codex-only`/`sceptic` применяются как модификаторы.

**codex-лана** и **opencode-лана** (для T1 — только codex; для T2/T3 — оба; при `codex-only` opencode опусти) — ОДНИМ foreground Bash-вызовом (один shell владеет обоими процессами → `wait` валиден; раздельные background-вызовы не годятся, состояние shell не сохраняется).
```bash
timeout 240 codex exec -s read-only -C "$REPO" --skip-git-repo-check \
  --output-schema "$WD/findings.schema.json" -o "$WD/codex.json" "$BRIEF" </dev/null \
  > "$WD/codex.log" 2>&1 & C=$!
timeout 240 opencode run --format json --dir "$REPO" "$BRIEF_OC" \
  > "$WD/opencode.out" 2>&1 & O=$!
wait $C; codex_rc=$?      # 124 = timeout
wait $O; opencode_rc=$?
```
- codex: `</dev/null` обязателен (иначе виснет на stdin); diff — файлом, не stdin; `--json` не нужен (форму задаёт `--output-schema`, `-o` пишет финальное сообщение в файл).
- opencode: `-m` опусти (дефолт тула). В `BRIEF_OC` добавь: «Выведи находки строго JSON-массивом по схеме между маркерами `===FINDINGS_START===` и `===FINDINGS_END===`».

## 6. Сбор и нормализация
- dimension-агенты: возьми их структурированные находки, приведи к общей схеме (поле `dimension` уже известно по агенту), `source = opus`.
- codex: прочитай `$WD/codex.json` (валидный JSON по схеме). `codex_rc`: 124 → `timeout`, ≠0 → `failed`.
- opencode (если не codex-only): распарси `$WD/opencode.out` как JSONL → собери `part.text` ВСЕХ событий `type:"text"` по порядку → склей → возьми **последний** блок между маркерами. Не распарсилось — `unparseable`, сохрани raw.
- Каждой находке проставь `source` (`opus`/`codex`/`opencode`) и `dimension`.
- **Floor-кейс:** если все внешние консультанты недоступны/упали (при codex-only — если упал codex) — строй отчёт только из Opus dimension-агентов с пометкой «single-source (Opus-only)», не прерывайся.

## 7. Синтез консенсуса (ты — арбитр)
- **Дедуп** пересечений по (file, окрестность line, смысл) — в т.ч. между разными источниками И между измерениями (одна и та же проблема может всплыть как impact и как quality — слей, оставь более точное `dimension`). При сомнении не склеивай, помечай related.
- **Agreement-бейдж** `[opus|codex|opencode]` — кто нашёл (слитые дубликаты объединяют источники).
- Назначь **финальную severity** по impact-рубрике (решение за тобой; согласие источников влияет на уверенность).
- Minority/спорные (1 источник) сохраняй с аннотацией, не выкидывай молча.

## 8. Sceptic-проход (только если sceptic ON)
По умолчанию **Opus-only** (без повторного обращения к консультантам):
- Пытайся **опровергнуть** каждую находку (нет `file:line`, нет конкретного сценария вреда, нет репро).
- **P0-guard:** P0 **никогда** не дропается жёстко — максимум понижение с аннотацией `disputed: unverified` (в приложение minority). Дропать можно только P1/P2.
- **Без молчаливых дропов:** каждый отброшенный/пониженный пункт логируй в приложении.
- Выжившие → `survived skeptic`.

## 9. Отчёт
Отсортируй P0→P1→P2 (внутри — по agreement desc, затем по dimension/файлу). Вывод в терминал **и** файл `<cwd>/.omc/reviews/review-<slug>-<YYYY-MM-DD>.md` (создай каталог; для remote-PR diff-only — в `.omc/reviews/` текущего каталога).

Формат:
```
# Consensus Review — <таргет: PR #N url | uncommitted in <repo>>
base→head: <…> | дата: <…> | sceptic: ON/OFF | codex-only: ON/OFF
Классификация: tier=<T0..T3> | эффективный код: <~N строк / M файлов> | non-code исключено: <K строк (.bru/lock/docs)> | blast: <isolated|local|wide> | основания: <кратко>
Измерения: <architecture? quality impact tests?>  (применённые / пропущенные с причиной)
Источники: codex=<ok|timeout|failed|unavailable>, opencode=<ok|…|unparseable|skipped>, opus=ok
Код-граф: <codegraph|graphify|нет> (использован для навигации/blast-radius)
Итого: P0=<n> P1=<n> P2=<n>

## P0
### <title>  `file:line`  [opus|codex|opencode]  (dimension/category)<, survived skeptic>
<rationale>
**Fix:** <suggested_fix>
...
## P1
## P2

## Сводка по измерениям
| Измерение | Статус | P0 | P1 | P2 |
|---|---|---|---|---|
| architecture | применено/пропущено(причина) | n | n | n |
| quality | … | | | |
| impact | … | | | |
| tests | применено/пропущено(нет тестов) | | | |

## Minority / Disputed
<находки из 1 источника + пониженные/спорные, с аннотацией>

## Dropped / Downgraded (sceptic)
<что отброшено/понижено и почему — только при sceptic ON>

## Доступность источников
<timeout/failed/unavailable/unparseable/skipped, diff-only режим и т.п.>
```

## Жёсткие правила
- **Read-only:** не редактируй код, не коммить, не пушь, не комменти PR, не запускай фиксы. Единственная запись — файл отчёта в `.omc/reviews/`.
- Рабочие файлы — только в `$WD` (mktemp вне репо).
- Никогда не «теряй» источник или измерение молча — пропуски и недоступность всегда в отчёте (раздел «Сводка по измерениям» и «Доступность источников»).
