// Shared test doubles. The adversarial cases deliberately build their own verifiers inline —
// only the honest, contract-abiding shape is shared, since repeating it obscured which tests
// were varying it on purpose.

/** A verifier that adjudicates every finding and vouches for every cell, citing real anchors. */
export const honestVerifier = async ({ findings, cells }) => ({
  verdicts: findings.map((f) => ({
    id: f.id,
    verdict: "confirmed",
    evidence: `traced a concrete path in ${f.file}`,
  })),
  cell_verdicts: cells.map((c) => ({
    id: c.id,
    verified: true,
    reason: `checked ${c.evidence?.anchors?.[0]} against the diff`,
  })),
})

/** Vouches for cells but adjudicates nothing — used where a finding must be left unresolved. */
export const cellsOnlyVerifier = async ({ cells }) => ({
  verdicts: [],
  cell_verdicts: cells.map((c) => ({
    id: c.id,
    verified: true,
    reason: `checked ${c.evidence?.anchors?.[0]} against the diff`,
  })),
})

/** A well-formed evidence record for `cell`, anchored in `file`. */
export const evidenceFor = (cell, file, overrides = {}) => ({
  cell,
  status: "covered",
  anchors: [`${file}:10`],
  checks: ["read the guard"],
  context_used: "the diff hunk for this file",
  disposition: "none",
  context_complete: true,
  ...overrides,
})
