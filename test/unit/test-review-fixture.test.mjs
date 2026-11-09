// Guards the truth of the test-review answer key: each seed's check really leaves the suite
// green, each control's check really turns exactly its tests red. Expected values come from the
// plan's test section (.omc/plans/tests-dimension-rubric.md, cases V1–V11), not from runs.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { materialize, applyCheck, childEnv, KEY_PATH } from "../../testkit/review-fixture.mjs"

const KEY = JSON.parse(readFileSync(KEY_PATH, "utf8"))
const entry = (id) => KEY.entries.find((e) => e.id === id)

// Explicit list: a bare `node --test` in the child would also pick up anything else on disk.
const TEST_FILES = [
  "test/bundle.test.js",
  "test/cart.test.js",
  "test/checkout.test.js",
  "test/coupon.test.js",
  "test/deposit.test.js",
  "test/giftcard.test.js",
  "test/giftwrap.test.js",
  "test/inventory.test.js",
  "test/loyalty.test.js",
  "test/order.test.js",
  "test/rating.test.js",
  "test/receipt.test.js",
  "test/refund.test.js",
  "test/reviews.test.js",
  "test/slug.test.js",
  "test/ticket.test.js",
  "test/wishlist.test.js",
]

const CHANGED = [
  "src/bundle.js", "src/cart.js", "src/coupon.js", "src/deposit.js", "src/giftcard.js",
  "src/giftwrap.js", "src/inventory.js", "src/limits.js", "src/loyalty.js", "src/notify.js",
  "src/order.js", "src/rating.js", "src/receipt.js", "src/refund.js", "src/reviews.js",
  "src/shipping.js", "src/store.js", "src/tax.js", "src/ticket.js", "src/wishlist.js",
  "test/bundle.test.js", "test/cart.test.js", "test/checkout.test.js", "test/coupon.test.js",
  "test/deposit.test.js", "test/giftcard.test.js", "test/giftwrap.test.js",
  "test/inventory.test.js", "test/loyalty.test.js", "test/order.test.js", "test/rating.test.js",
  "test/receipt.test.js", "test/refund.test.js", "test/reviews.test.js", "test/slug.test.js",
  "test/ticket.test.js", "test/wishlist.test.js",
]

const PINNED = "2026-11-08T00:00:00Z"

let root
let pristine
let n = 0
before(() => {
  root = mkdtempSync(join(tmpdir(), "test-review-fixture-"))
  pristine = materialize(join(root, "pristine"))
})
after(() => rmSync(root, { recursive: true, force: true }))

/** A fresh copy of the materialised tree, so one check never leaks into another. */
const copy = () => {
  const dir = join(root, `run-${++n}`)
  cpSync(pristine, dir, { recursive: true })
  return dir
}

/** Runs the fixture suite; returns exit status, counts and the names of failing tests. */
function run(dir, now = PINNED) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...TEST_FILES], {
    cwd: dir, env: childEnv(process.env, { now }), encoding: "utf8",
  })
  const lines = r.stdout.split("\n")
  const count = (k) => Number(lines.find((l) => l.startsWith(`# ${k} `))?.slice(k.length + 3))
  return {
    status: r.status,
    tests: count("tests"),
    failing: lines.filter((l) => /^not ok \d+ - /.test(l)).map((l) => l.replace(/^not ok \d+ - /, "")),
  }
}

const gitOut = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" })

test("V1: materialize commits the base and stages the change uncommitted", () => {
  assert.equal(gitOut(pristine, "rev-list", "--count", "HEAD").trim(), "1")
  assert.deepEqual(gitOut(pristine, "diff", "HEAD", "--name-only").trim().split("\n"), CHANGED)
  const ignored = spawnSync("git", ["check-ignore", ".reviews/x"], { cwd: pristine })
  assert.equal(ignored.status, 0)
})

test("V2: the suite is green as committed, with the clock pinned to 2026-11-08", () => {
  const r = run(copy())

  assert.equal(r.status, 0)
  assert.deepEqual(r.failing, [])
  assert.equal(r.tests, 35)
})

for (const id of ["S1", "S2", "S3", "S4", "S5", "S6", "H1", "H2", "H5", "H6", "H7"]) {
  test(`V3: ${id}'s check survives (the suite stays green)`, () => {
    const dir = copy()
    applyCheck(dir, entry(id).check)

    const r = run(dir)

    assert.equal(r.status, 0)
    assert.deepEqual(r.failing, [])
  })
}

const KILLED = [
  ["C1", ["emails the receipt"]],
  ["C2", ["allows exactly MAX_ITEMS"]],
  ["C3", ["formats 0", "formats 5", "formats 499", "formats 123456"]],
  ["C4", ["pins legacy slugs (characterisation)"]],
  ["C5", ["charges one gift-wrap fee for a whole order"]],
  ["C6", ["prints the warehouse code on the slip"]],
]
for (const [id, failing] of KILLED) {
  test(`V4: ${id}'s check is killed by exactly its own tests`, () => {
    const dir = copy()
    applyCheck(dir, entry(id).check)

    const r = run(dir)

    assert.equal(r.status, 1)
    assert.deepEqual(r.failing, failing)
  })
}

test("V4: C2's lower bound (`>= 1` to `> 1`) is killed by exactly `allows a single item`", () => {
  const dir = copy()
  applyCheck(dir, { kind: "killed", file: "src/limits.js", line: 5, from: ">= 1", to: "> 1" })

  const r = run(dir)

  assert.equal(r.status, 1)
  assert.deepEqual(r.failing, ["allows a single item"])
})

test("V5: S9's fix (round half up) turns only the VAT test red", () => {
  const dir = copy()
  applyCheck(dir, entry("S9").check)

  const r = run(dir)

  assert.equal(r.status, 1)
  assert.deepEqual(r.failing, ["charges VAT"])
})

const REFACTORED = [
  ["S7", ["add stores the line"]],
  ["H3", ["adding the same item twice keeps one entry"]],
  ["H4", ["cancelling an open order releases its stock"]],
]
for (const [id, failing] of REFACTORED) {
  test(`V6: ${id}'s behaviour-preserving refactor turns only its own test red`, () => {
    const dir = copy()
    applyCheck(dir, entry(id).check)

    const r = run(dir)

    assert.equal(r.status, 1)
    assert.deepEqual(r.failing, failing)
  })
}

test("V7: S8's coupon test fails at 2027-07-01", () => {
  assert.equal(entry("S8").check.at, "2027-07-01T00:00:00Z")

  const r = run(copy(), "2027-07-01T00:00:00Z")

  assert.equal(r.status, 1)
  assert.deepEqual(r.failing, ["a coupon is valid before its expiry"])
})

test("V7: S8's coupon test passes at 2026-11-08", () => {
  const r = run(copy(), "2026-11-08T00:00:00Z")

  assert.equal(r.status, 0)
})

test("V8: applyCheck throws when `from` is absent from its line", () => {
  const dir = copy()

  assert.throws(
    () => applyCheck(dir, { kind: "killed", file: "src/limits.js", line: 5, from: "!==", to: "===" }),
    { message: "does not apply: src/limits.js:5" },
  )
})

test("V8: applyCheck throws when `from` occurs twice on its line", () => {
  const dir = copy()

  // src/limits.js:5 is `return count >= 1 && count <= MAX_ITEMS`: "count" occurs twice.
  assert.throws(
    () => applyCheck(dir, { kind: "killed", file: "src/limits.js", line: 5, from: "count", to: "n" }),
    { message: "does not apply: src/limits.js:5" },
  )
})

test("V9: childEnv drops NODE_TEST_CONTEXT and preloads the clock pin", () => {
  const env = childEnv({ NODE_TEST_CONTEXT: "child-v8" })

  assert.equal("NODE_TEST_CONTEXT" in env, false)
  assert.match(env.NODE_OPTIONS, /--import=/)
})

const BANNED = /seeded|mutant|defect|planted|answer|holdout/i
test("V10: no materialised file mentions the seeding", () => {
  const files = readdirSync(pristine, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(pristine, join(d.parentPath, d.name)))
    .filter((p) => !p.startsWith(".git/"))
  assert.equal(files.length, 43) // 7 base files + 36 the change adds

  const hits = files.filter((p) => BANNED.test(p) || BANNED.test(readFileSync(join(pristine, p), "utf8")))

  assert.deepEqual(hits, [])
})

test("V11: the key has 16 seeds and 6 controls with unique ids and valid severities", () => {
  const ids = KEY.entries.map((e) => e.id)
  const seeds = KEY.entries.filter((e) => e.family !== "control")
  const controls = KEY.entries.filter((e) => e.family === "control")

  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual(seeds.map((e) => e.id), [
    "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "H1", "H2", "H3", "H4", "H5", "H6", "H7",
  ])
  assert.deepEqual(controls.map((e) => e.id), ["C1", "C2", "C3", "C4", "C5", "C6"])
  for (const e of seeds) {
    assert.ok(["P0", "P1", "P2"].includes(e.severity.key), `${e.id} key`)
    assert.ok(e.severity.accepted.includes(e.severity.key), `${e.id} accepted holds key`)
    assert.ok(e.severity.accepted.every((s) => ["P0", "P1", "P2"].includes(s)), `${e.id} accepted`)
  }
  for (const e of controls) assert.equal(e.severity, null, `${e.id} has no severity`)
})

test("V11: the key marks the 13 original entries and the 9 holdout entries", () => {
  const ids = (set) => KEY.entries.filter((e) => e.set === set).map((e) => e.id)

  assert.deepEqual(ids("original"), ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "C1", "C2", "C3", "C4"])
  assert.deepEqual(ids("holdout"), ["H1", "H2", "H3", "H4", "H5", "H6", "H7", "C5", "C6"])
})

test("V11: each key entry's line range holds its named tests", () => {
  const off = KEY.entries.filter((e) => {
    const lines = readFileSync(join(pristine, e.test.file), "utf8").split("\n")
    const span = lines.slice(e.test.lines[0] - 1, e.test.lines[1]).join("\n")
    const named = e.test.names.every((name) => span.includes(name) || span.includes("formats ${cents}"))
    return !named
  }).map((e) => e.id)

  assert.deepEqual(off, [])
})
