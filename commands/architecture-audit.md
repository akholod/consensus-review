---
description: One-shot architecture audit — layers, slices, contracts, paradigms, complexity
---

# Architecture Audit

One-shot architecture audit of the entire codebase (not a line-by-line code review).
Stack-agnostic. Scope — always the whole project.

## Role and Lens

**Role:** architecture reviewer.

**Lens:**
- Horizontal layers (server / DB / network / business logic / UI)
  and vertical slices (capability) that cut across all layers.
- Analysis entry point: **User workflow → Use case → Business capability**.
  NOT screens, NOT tables, NOT endpoints.
- Look for abstraction leakage between layers and modules.
- Treat complexity as manageability of the system: can the team understand,
  estimate, and safely change the code without losing control over AI-generated
  or overengineered complexity.

## Operating Mode

- Single pass, single context, no delegation to sub-agents.
- Scope — always the whole project (`$ARGUMENTS` is ignored).
- Output — to chat, free-form; structure it however best conveys the essence
  of what was found.
- Diagrams (mermaid / C4-lite / ASCII) — at your discretion, when the
  architectural complexity warrants it.
- Ask clarifying questions **during the analysis**, as soon as facts from the
  code are insufficient. Do not accumulate them to the end.
- Output language: English by default. If the caller passes `lang=ua` (Ukrainian), write in Ukrainian. Identifiers, paths, and technical terms stay in their original form.

## Severity Scale (for the findings block in Phase 5)

- `P0` — invariant violation, abstraction leakage that blocks further development,
  or an architectural choice that will be expensive to untangle in the near term.
- `P1` — structural problem: blurred module boundaries, implicit contracts,
  paradigm mismatch with the nature of the task.
- `P2` — localized layer misalignment or minor architectural drift.

---

## Phase 1. Inventory

Answer from facts in the code. If a fact is missing — explicitly mark it as
**hypothesis** or ask a clarifying question.

1. What business entities exist?
2. What roles work with them?
3. What actions do the roles perform?
4. What states (lifecycle) do the entities go through?
5. What invariants must not be violated?
6. Where are the transaction boundaries?
7. Where is async behavior, queues, background processes?
8. Where are access permissions?
9. Where is audit, history, versioning?
10. Where are external integrations?

**Proposing solutions before this phase is complete is prohibited.**

---

## Phase 2. Reconstruction

1. Gather all product features.
2. Group them into business capabilities.
3. For each capability — domain entities + lifecycle.
4. Express use cases as user commands.
5. Role × action matrix → permissions.
6. State ownership: who owns which state.
7. Screen map from user intentions (not from routes).
8. Code layout by feature/domain modules: as-is vs to-be.
9. Shared layer: the "extract after 2–3 repetitions" principle. Premature
   generalizations and underused shared code — in findings.
10. Contracts between layers and modules: present / absent / violated.

---

## Phase 3. Paradigms

For each significant module, name the appropriate paradigm
(OOP / FP / state machine / actors / pipeline / event-sourcing / CRDT / …)
and justify the choice by the **nature of the module's task**, not team habit.
Separately flag modules where the current paradigm does not match the task.

---

## Phase 4. Complexity Management

Evaluate not only the structure but also the architecture's ability to bound
the future cost of change.

For each significant business capability or module, determine:

1. **Essential complexity** — complexity that stems from the domain, lifecycle,
   invariants, regulation, integration constraints, or real NFRs.
2. **Accidental complexity** — parasitic complexity from over-flexibility,
   leaky layers, premature shared code, scattered state, nested data structures,
   unpredictable dependencies, or AI-generated code that is larger than the task.
3. **Controllability** — can a senior/architect/agent understand,
   estimate, and change the module given the available docs, contracts, tests, and local code.
4. **Change-cost drivers** — volatility requirements, interface breadth,
   object shape, granularity, implicit contracts, transaction boundaries,
   async/concurrency, race conditions, hot paths, testability and observability gaps.
5. **Simplification levers** — which FR/NFR can be simplified, which flexibility
   can be removed, which state can be made explicit, which data structures can be
   simplified or flattened, where complexity should be hidden behind an interface,
   adapter, or facade.
6. **Complexity budget** — mark the module as `OK`, `Watch`, or `Critical`.
   For `Critical`, specify the smallest correction at the level of boundary, contract,
   module ownership, or paradigm.

Distinguish hiding complexity from spreading responsibility: a facade,
adapter, or interface is useful only when it reduces cognitive load and makes
ownership, side effects, and contracts explicit.

---

## Phase 5. Output

- Layer and slice map.
- Complexity registry: essential / accidental by capability or module.
- Complexity budget: `OK` / `Watch` / `Critical` with a brief explanation.
- Abstraction leakage with `file:line`.
- Contract registry: present / absent / violated.
- Findings table by severity:

  ```md
  | Severity | Location | Title | Risk & Correction |
  |---|---|---|---|
  | P0 | `file:line` | … | … |
  | P1 | `file:line` | … | … |
  ```

- Prioritized refactoring plan:
  `capability → module → contract → paradigm`.
- **RISKS** of the current architecture.
- **Invariants that MUST NOT be changed** during refactoring.
- Open questions and hypotheses.

---

## Rules

- Architectural level, not line-by-line remarks.
- Stack-agnostic: mention the stack only when it materially affects an
  architectural decision.
- Every claim is either a `file:line` reference or is explicitly marked
  as "hypothesis".
- Do not default to the "controller/service/repository" layout unless it
  follows naturally from the nature of the module.
- Do not propose solutions during Phase 1.

---

## Greenfield Mode

If there is no code yet:

- Phase 1 is conducted as a structured interview with the user.
- Phases 2–5 — as a design proposal, without `file:line` references.
- The "2–3 repetitions for shared" principle **does not apply** —
  at the design stage it is valid to plan future abstractions
  based on expected capabilities.
