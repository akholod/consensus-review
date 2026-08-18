// The discovery loop. Owns pass sequencing, the negative-space handoff, coverage bookkeeping,
// verification and the stopping rule. All review reasoning happens in the prompts, not here.

import {
  PASS_STATE, PASS_STATE_OK, TERMINAL,
  fingerprint, validateEvidence, validateFinding, normalizeVerdict,
  newRunState, evaluateTerminal, budgetExhausted, ACTIONABLE, isUnresolvedActionable,
  evidenceSubstantiates, parseAnchor, validAnchor,
} from "./schema.mjs"

/**
 * What a later pass is allowed to know. Deliberately only three things: what has already been
 * claimed (as structured fingerprints), what has been refuted, and which cells are still open.
 *
 * The prior pass's *reasoning* is structurally absent — there is no field that could carry it —
 * because persuasive context is what makes a later pass repeat the dominant theme instead of
 * looking elsewhere. This is the whole mechanism against hyperfocus.
 */
export function buildNegativeSpace(run) {
  return {
    already_reported: run.findings.map((f) => f.fingerprint),
    refuted: run.refuted.slice(),
    uncovered_cells: run.cells.filter((c) => !c.covered).map((c) => ({ id: c.id, files: c.files, mandatory: c.mandatory })),
  }
}

export function renderNegativeSpace(ns) {
  if (!ns.already_reported.length && !ns.refuted.length && !ns.uncovered_cells.length) return ""
  const out = ["<already_covered>"]
  out.push("These claims are already recorded. Do not restate them; look elsewhere.")
  for (const fp of ns.already_reported) out.push(`- ${fp}`)
  out.push("</already_covered>")
  if (ns.refuted.length) {
    out.push("<refuted>")
    out.push("These were checked and found not to hold. Do not raise them again.")
    for (const fp of ns.refuted) out.push(`- ${fp}`)
    out.push("</refuted>")
  }
  if (ns.uncovered_cells.length) {
    out.push("<uncovered_cells>")
    out.push("These areas still have no evidence recorded. Direct your attention here.")
    for (const c of ns.uncovered_cells) out.push(`- ${c.id}${c.mandatory ? " (mandatory)" : ""}: ${c.files.join(", ")}`)
    out.push("</uncovered_cells>")
  }
  return out.join("\n")
}

export function buildPassPrompt({ staticPrefix, instructions, negativeSpace }) {
  // The static prefix comes first and byte-identically on every pass; only the tail varies.
  const tail = renderNegativeSpace(negativeSpace)
  return [staticPrefix, tail, instructions].filter(Boolean).join("\n\n")
}

/** Apply one pass's payload to the run: record findings, validate evidence, mark coverage. */
export function applyPass(run, pass, payload) {
  let added = 0
  const seen = new Set(run.findings.map((f) => f.fingerprint))

  const rawFindings = Array.isArray(payload?.findings) ? payload.findings : []
  for (const raw of rawFindings) {
    const problems = validateFinding(raw)
    if (problems.length) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue // nothing to record
      // A finding that cannot clear the structural bar is kept as an unverified hypothesis,
      // never silently dropped and never promoted.
      run.findings.push({ ...raw, fingerprint: fingerprint(raw), verdict: "unconfirmed", unverified: true, problems, foundInPass: pass.index })
      continue
    }
    const fp = fingerprint(raw)
    if (seen.has(fp)) continue
    seen.add(fp)
    run.findings.push({ ...raw, fingerprint: fp, verdict: null, foundInPass: pass.index })
    added++
  }

  const rawCells = Array.isArray(payload?.cells) ? payload.cells : []
  for (const record of rawCells) {
    const cell = run.cells.find((c) => c.id === record?.cell)
    if (!cell) {
      // The pass emitted a record for a cell that does not exist — a typo'd id, or an invented
      // one. That is not the same as staying silent about a covered cell: something was asserted
      // and it does not correspond to anything, so the run cannot claim a clean bill of health.
      run.rejections.push(`pass ${pass.index} emitted a record for unknown cell ${JSON.stringify(record?.cell ?? null)}`)
      continue
    }
    const problems = validateEvidence(record, cell)
    if (problems.length) {
      cell.evidence = { ...record, rejected: problems }
      cell.evidenceHistory = [...(cell.evidenceHistory ?? []), { pass: pass.index, record, problems }]
      // A rejected record does not merely fail to add coverage — it withdraws whatever an
      // earlier pass had established, together with its verification.
      cell.covered = false
      cell.verifiedIndependently = false
      continue
    }
    cell.evidenceHistory = [...(cell.evidenceHistory ?? []), { pass: pass.index, record, problems }]
    cell.evidence = record
    cell.evidenceVersion = (cell.evidenceVersion ?? 0) + 1
    // Verification approves one specific record. New evidence invalidates the old approval,
    // otherwise replacement evidence inherits an approval nobody gave it.
    if (cell.verifiedFor !== cell.evidenceVersion) cell.verifiedIndependently = false
    // `inconclusive` means the pass looked but could not tell — that is explicitly not coverage,
    // and `reported` only counts if this pass actually admitted a finding in the cell's files.
    const admittedHere = run.findings.some(
      (f) => !f.unverified && f.foundInPass === pass.index && cell.files.includes(f.file)
    )
    const dispositionSupportsCoverage =
      record.disposition === "none" || (record.disposition === "reported" && admittedHere)

    if (record.status === "covered" && record.context_complete && dispositionSupportsCoverage) {
      cell.covered = true
    } else {
      // A later pass retracting coverage must actually retract it, and its verification with it.
      cell.covered = false
      cell.verifiedIndependently = false
    }
    if (record.status === "covered" && !record.context_complete && cell.mandatory) {
      run.escalations.push(`incomplete context on mandatory cell ${cell.id}`)
    }
  }

  // Omission is deliberately NOT retraction. A later pass is told what is already covered
  // precisely so it looks elsewhere, so requiring it to re-affirm settled cells would fight the
  // design and turn ordinary terseness into a failed run. Coverage stands on the last VALID
  // record; a rejected or retracting record withdraws it (handled above). A cell never covered
  // by any pass simply stays uncovered, which already blocks CLEAN.

  pass.newFindings = added
  return added
}

/** Verify actionable findings in one batch, then apply the verdicts. */
export function applyVerdicts(run, verdicts) {
  const list = Array.isArray(verdicts) ? verdicts : []
  for (const v of list) {
    if (!v || typeof v !== "object") continue
    const finding = run.findings.find((f) => f.fingerprint === v.id || f.fingerprint === v.fingerprint)
    if (!finding) continue
    // Refuting a finding removes it from the report, so it demands evidence that actually points
    // at the code. A length threshold alone let "not a real issue" erase a real P1.
    const grounded = evidenceSubstantiates(v.evidence, finding.file)
    if ((v.verdict === "refuted" || v.verdict === "confirmed") && !grounded) continue
    const { verdict } = normalizeVerdict(v.verdict, finding.severity, v.suggested_severity)
    finding.verdict = verdict
    finding.evidence = v.evidence ?? null
    if (verdict === "reduced" && v.suggested_severity) finding.severity = v.suggested_severity
    if (verdict === "refuted") run.refuted.push(finding.fingerprint)
  }
  return run
}

/** Findings still awaiting a verdict. */
export const pendingActionable = (run) =>
  run.findings.filter((f) => ACTIONABLE.includes(f.severity) && !f.unverified && f.verdict === null)

export function spend(run, usage, ms) {
  run.spent.calls += 1
  run.spent.ms += ms ?? 0
  run.spent.tokens += (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0)
  run.spent.cost_usd = (run.spent.cost_usd ?? 0) + (usage?.cost_usd ?? 0)
  return run.spent
}

/**
 * Should another discovery pass run?
 * Below the policy minimum it is mandatory. Between the minimum and the ceiling it runs only
 * while there is something left to look for. At the ceiling the run stops looping.
 */
export function shouldContinue(run) {
  if (run.passes.length >= run.maxPasses) return false
  if (budgetExhausted(run)) return false
  if (run.passes.length < run.minPasses) return true
  const lastPass = run.passes[run.passes.length - 1]
  if (lastPass && lastPass.newFindings > 0) return true
  return run.cells.some((c) => c.mandatory && !c.covered)
}

/**
 * Drive the loop. `runner` and `verifier` are injected so the whole sequence can be replayed
 * from recorded transcripts without touching a live model.
 */
export async function runLoop({ ctx, runner, verifier, discoveryInstructions, currentDiffHash, budget = {} }) {
  const run = newRunState({
    target: ctx.target,
    diffHash: ctx.diffHash,
    cells: ctx.cells,
    trivial: ctx.trivial,
    highRisk: ctx.highRisk,
    budget,
  })

  // A diff whose sections could not be resolved is not an empty diff. Without this the run
  // reviewed nothing and reported CLEAN.
  if (ctx.unparsed) run.rejections.push(ctx.unparsed)

  while (shouldContinue(run) || run.passes.length === 0) {
    if (run.trivial && run.passes.length >= run.maxPasses) break
    const index = run.passes.length + 1
    const prompt = buildPassPrompt({
      staticPrefix: ctx.staticPrefix,
      instructions: discoveryInstructions,
      negativeSpace: buildNegativeSpace(run),
    })
    const result = await runner({ prompt, passIndex: index })
    const pass = { index, state: result.state, newFindings: 0, detail: result.detail ?? "", usage: result.usage, modelId: result.modelId ?? null, runnerId: result.runnerId ?? null }
    spend(run, result.usage, result.ms)

    if (result.state === PASS_STATE_OK) {
      applyPass(run, pass, result.payload)
    } else {
      // A failed pass yields no coverage and no findings, and permanently blocks CLEAN.
      pass.newFindings = 0
      if (result.state === PASS_STATE.TIMEOUT || result.state === PASS_STATE.FAILED) {
        run.escalations.push(`runner ${result.state} on pass ${index}`)
      }
    }
    run.passes.push(pass)
    if (result.state !== PASS_STATE_OK) break

    // Verify now rather than at the end: a refuted claim is only useful to the NEXT pass, and
    // high-risk cells need a verdict of their own before the run can even consider CLEAN.
    if (verifier) {
      const pending = pendingActionable(run)
      const cellsToVerify = run.cells.filter((c) => c.mandatory && c.covered && !c.verifiedIndependently)
      if ((pending.length || cellsToVerify.length) && !budgetExhausted(run)) {
        // Short opaque ids: the fingerprint is long and punctuation-heavy, and asking the
        // verifier to echo it verbatim made verdicts fail to match their finding.
        const idMap = new Map(pending.map((f, i) => [`F${i + 1}`, f.fingerprint]))
        const verification = await verifier({
          findings: pending.map((f, i) => ({
            id: `F${i + 1}`,
            title: f.title,
            file: f.file,
            line: f.line ?? null,
            severity: f.severity,
            failure_scenario: f.failure_scenario ?? null,
          })),
          cells: cellsToVerify.map((c) => ({ id: c.id, files: c.files, evidence: c.evidence })),
        })
        const verdicts = Array.isArray(verification) ? verification : verification?.verdicts
        const rawCellVerdicts = Array.isArray(verification) ? [] : verification?.cell_verdicts
        const cellVerdicts = Array.isArray(rawCellVerdicts) ? rawCellVerdicts : []
        // A verification attempt that failed produced no judgement, so nothing it "returned" may
        // be applied, and the run cannot then claim a clean bill of health.
        const stateOk = Array.isArray(verification) || !verification?.state || verification.state === "ok"
        // The envelope must have the shape the contract promises before any of it is applied.
        const shapeOk =
          Array.isArray(verification) ||
          (verification && typeof verification === "object" &&
            (verification.verdicts === undefined || Array.isArray(verification.verdicts)) &&
            (verification.cell_verdicts === undefined || Array.isArray(verification.cell_verdicts)))
        const verificationOk = stateOk && shapeOk
        if (!verificationOk) {
          run.rejections.push(
            `verification on pass ${index} ${stateOk ? "returned a malformed envelope" : `returned ${verification.state}`}`
          )
        }
        if (verification?.usage || verification?.ms) spend(run, verification.usage, verification.ms)
        run.verifications.push({
          pass: index,
          findings: pending.length,
          cells: cellsToVerify.length,
          verdicts: Array.isArray(verdicts) ? verdicts.length : 0,
          cellVerdicts: cellVerdicts.length,
          state: verification?.state ?? (Array.isArray(verification) ? "ok" : verification?.verdicts ? "ok" : "unusable"),
          modelId: verification?.modelId ?? null,
          runnerId: verification?.runnerId ?? null,
        })
        // Only ids this loop issued may resolve a finding. Falling back to the raw id let a
        // verdict for an id that was never handed out adjudicate something.
        const mapped = (Array.isArray(verdicts) ? verdicts : [])
          .filter((v) => v && typeof v === "object" && idMap.has(v.id))
          .map((v) => ({ ...v, id: idMap.get(v.id) }))
        if (verificationOk) applyVerdicts(run, mapped)
        // Only a verdict naming the cell counts. Deriving this from "a verifier exists" was the
        // same dispatch-is-not-coverage mistake the evidence records exist to prevent.
        for (const cv of verificationOk ? cellVerdicts : []) {
          if (!cv || typeof cv !== "object") continue
          const cell = run.cells.find((c) => c.id === cv.id || c.id === cv.cell)
          if (!cell || cv.verified !== true) continue
          // A bare `{verified:true}`, or a vague reason, asserts nothing. The verdict must name a
          // location the cell's own evidence cited — the same bar the evidence itself had to clear.
          const reason = typeof cv.reason === "string" ? cv.reason : ""
          // Only anchors that passed validation may be cited. Keeping invalid ones in the set
          // let an approval quote the one anchor that was out of bounds.
          const anchors = (cell.evidence?.anchors ?? []).filter((a) => validAnchor(a, cell))
          // The reason must quote one of the supplied anchors, compared as parsed locations.
          // Substring matching accepted "checked not-a.js:10" as citing the anchor "a.js:1".
          const cited = reason
            .split(/[\s,;()\[\]{}'"`]+/)
            .map((tok) => parseAnchor(tok.replace(/^[^A-Za-z0-9_./-]+|[^A-Za-z0-9_./-]+$/g, "")))
            .filter(Boolean)
          const citesAnchor = anchors.some((a) => {
            const want = parseAnchor(a)
            if (!want) return false
            return cited.some((got) => got.path === want.path && got.line === want.line && (got.lineEnd ?? got.line) === (want.lineEnd ?? want.line))
          })
          if (!citesAnchor) continue
          cell.verifiedIndependently = true
          cell.verifiedFor = cell.evidenceVersion
          cell.verification = { reason, pass: index }
        }
      }
    }
    if (run.trivial) break
  }

  // Non-mandatory cells carry no independent-verification requirement.
  for (const cell of run.cells) {
    if (!cell.mandatory) cell.verifiedIndependently = true
  }

  // Anything still awaiting a verdict after the loop stays unconfirmed rather than becoming a fact.
  for (const f of run.findings) {
    if (f.verdict === null) f.verdict = "unconfirmed"
  }

  const unresolved = run.findings.filter(isUnresolvedActionable)
  if (unresolved.length) {
    run.escalations.push(`${unresolved.length} actionable finding(s) were never resolved by verification`)
  }

  const terminal = evaluateTerminal(run, currentDiffHash ?? ctx.diffHash)
  run.terminal = terminal.state
  run.terminalReasons = terminal.reasons
  return run
}
