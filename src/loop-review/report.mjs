// Renders a run into the report. Presentation only — it never changes a verdict or a state.

import { TERMINAL, ACTIONABLE, isReportable, safeString } from "./schema.mjs"

const HEADLINE = {
  [TERMINAL.CLEAN]: "No confirmed findings within the reviewed scope.",
  [TERMINAL.FINDINGS]: "Confirmed findings present.",
  [TERMINAL.INCONCLUSIVE]: "Inconclusive — the run could not establish coverage.",
  [TERMINAL.ESCALATE]: "Escalated — human review required.",
}

/** Every value that reaches the report goes through here: it may have come from a model. */
const text = (value, max = 500) => safeString(value).replace(/\s+/g, " ").trim().slice(0, max)
const CATEGORY = (f) => text(f.category ?? "uncategorised", 40)

const bySeverity = (findings, severity) =>
  findings.filter((f) => f.severity === severity && isReportable(f))

export function renderReport(run, { target, generatedAt = "" } = {}) {
  const out = []
  const confirmed = run.findings.filter(isReportable)
  const unconfirmed = run.findings.filter((f) => !isReportable(f) && f.verdict !== "refuted")
  const refuted = run.findings.filter((f) => f.verdict === "refuted")

  out.push(`# Loop Review — ${target ?? run.target}`)
  out.push("")
  out.push(`**${run.terminal}** — ${HEADLINE[run.terminal] ?? ""}`)
  if (run.terminalReasons?.length) {
    for (const reason of run.terminalReasons) out.push(`- ${reason}`)
  }
  out.push("")
  out.push(
    `diff: \`${run.diffHash}\` | passes: ${run.passes.length}/${run.minPasses} min, ${run.maxPasses} max` +
    ` | calls: ${run.spent.calls} | tokens: ${run.spent.tokens}` +
    (run.spent.cost_usd ? ` | cost: $${run.spent.cost_usd.toFixed(4)}` : "") +
    (generatedAt ? ` | ${generatedAt}` : "")
  )
  out.push("")
  out.push(`Totals: P0=${bySeverity(run.findings, "P0").length} P1=${bySeverity(run.findings, "P1").length} P2=${bySeverity(run.findings, "P2").length}`)
  out.push("")

  for (const severity of ["P0", "P1", "P2"]) {
    const items = bySeverity(run.findings, severity)
    if (!items.length) continue
    out.push(`## ${severity}`)
    for (const f of items) {
      // Rejected findings are retained so they can block CLEAN, which means hostile field values
      // reach the renderer. Interpolating them raw threw and lost the whole report.
      const line = f.line == null ? "" : `:${text(f.line, 40)}`
      out.push(`### ${text(f.title, 200)}  \`${text(f.file, 200)}${line}\`  (${CATEGORY(f)}${f.verdict === "reduced" ? ", reduced" : ""})`)
      if (f.rationale) out.push(text(f.rationale, 2000))
      if (f.failure_scenario) out.push(`**Failure scenario:** ${text(f.failure_scenario, 2000)}`)
      if (f.evidence) out.push(`**Verifier evidence:** ${text(f.evidence, 2000)}`)
      if (f.suggested_fix) out.push(`**Fix:** ${text(f.suggested_fix, 2000)}`)
      out.push("")
    }
  }

  out.push("## Coverage")
  out.push("")
  out.push("| Cell | Mandatory | Covered | Independently verified | Evidence |")
  out.push("|---|---|---|---|---|")
  for (const c of run.cells) {
    const rejectedAttempts = (c.evidenceHistory ?? []).filter((h) => h.problems?.length).length
    const ev = c.evidence?.rejected
      ? `rejected: ${c.evidence.rejected.join("; ")}`
      : c.evidence
        ? `${(c.evidence.checks ?? []).length} check(s)` + (rejectedAttempts ? ` (after ${rejectedAttempts} rejected attempt(s))` : "")
        : "—"
    out.push(`| \`${c.id}\` | ${c.mandatory ? "yes" : "no"} | ${c.covered ? "yes" : "**no**"} | ${c.verifiedIndependently ? "yes" : "**no**"} | ${ev} |`)
  }
  out.push("")

  out.push("## Passes")
  out.push("")
  out.push("| # | State | New findings | Detail |")
  out.push("|---|---|---|---|")
  for (const p of run.passes) {
    out.push(`| ${p.index} | ${p.state} | ${p.newFindings} | ${(p.detail ?? "").slice(0, 120) || "—"} |`)
  }
  out.push("")

  if (unconfirmed.length) {
    out.push("## Unverified — needs confirmation")
    out.push("")
    for (const f of unconfirmed) {
      const why = f.problems?.length ? ` — did not clear the bar: ${text(f.problems.join("; "), 300)}` : ""
      out.push(`- **${text(f.severity, 8)}** ${text(f.title, 200)} \`${text(f.file, 200)}\`${why}`)
    }
    out.push("")
  }

  if (refuted.length) {
    out.push("## Refuted (dropped)")
    out.push("")
    for (const f of refuted) out.push(`- ${text(f.title, 200)} \`${text(f.file, 200)}\` — ${text(f.evidence ?? "refuted by the verifier", 500)}`)
    out.push("")
  }

  out.push("## Source availability")
  out.push("")
  const runners = [...new Set(run.passes.map((p) => `${p.runnerId ?? "?"}/${p.modelId ?? "?"}`))]
  out.push(`- runner(s): ${runners.join(", ") || "none"}`)
  const failed = run.passes.filter((p) => p.state !== "ok")
  out.push(failed.length
    ? `- **${failed.length} pass(es) did not return usable output:** ${failed.map((p) => `#${p.index} ${p.state}`).join(", ")}`
    : "- all passes returned usable output")
  const verifications = run.verifications ?? []
  if (verifications.length) {
    const runners = [...new Set(verifications.map((v) => `${v.runnerId ?? "?"}/${v.modelId ?? "?"}`))]
    out.push(`- verifier: ${runners.join(", ")} — ${verifications.length} call(s), ${verifications.reduce((n, v) => n + v.verdicts, 0)} verdict(s), ${verifications.reduce((n, v) => n + v.cellVerdicts, 0)} cell verdict(s)`)
    const unusable = verifications.filter((v) => v.state !== "ok")
    if (unusable.length) out.push(`- **${unusable.length} verification call(s) returned nothing usable**`)
  } else {
    out.push("- verifier: not run")
  }
  const verified = run.cells.filter((c) => c.mandatory && c.verifiedIndependently).length
  const mandatory = run.cells.filter((c) => c.mandatory).length
  out.push(`- high-risk cells independently verified: ${verified}/${mandatory}`)
  out.push(`- budget spent: ${run.spent.calls} call(s), ${run.spent.tokens} token(s)${run.spent.ms ? `, ${run.spent.ms}ms` : ""}`)
  out.push("")

  if (run.escalations?.length) {
    out.push("## Escalations")
    out.push("")
    for (const e of run.escalations) out.push(`- ${e}`)
    out.push("")
  }

  return out.join("\n")
}

export function summaryLine(run) {
  const confirmed = run.findings.filter(isReportable)
  const actionable = confirmed.filter((f) => ACTIONABLE.includes(f.severity))
  return `${run.terminal} — ${confirmed.length} confirmed (${actionable.length} actionable) over ${run.passes.length} pass(es)`
}
