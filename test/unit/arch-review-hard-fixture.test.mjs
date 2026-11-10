// Guards the truth of the hard arch-review key: each PR's entries own exactly the lines that PR
// changes, facts and anchors sit where the key says, and every seed's consequence happens when the
// seeded code runs. The fixture writes no rules down; the expected values come from the base code's
// own contracts (JSDoc, the existing subscribers and patterns) named in each test.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { materialize, keyPath } from "../../testkit/review-fixture.mjs"

const KEY = JSON.parse(readFileSync(keyPath("arch-review-hard"), "utf8"))
const PRS = ["pr1", "pr2", "pr3", "pr4", "pr5", "pr6"]
const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 1)

let root
let n = 0
before(() => { root = mkdtempSync(join(tmpdir(), "arch-review-hard-fixture-")) })
after(() => rmSync(root, { recursive: true, force: true }))

const tree = (pr) => materialize(join(root, `t${++n}`), { fixture: "arch-review-hard", change: `${pr}.patch` })
const base = () => materialize(join(root, `t${++n}`), { fixture: "arch-review-hard", include: [] })
const load = (dir, rel) => import(pathToFileURL(join(dir, rel)).href)
const gitOut = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" })
const expand = (ranges) => ranges.flatMap((r) => { const [a, b = a] = r.split("-").map(Number); return Array.from({ length: b - a + 1 }, (_, i) => a + i) })

async function withFetch(body, fn) {
  const real = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => body })
  try { return await fn() } finally { globalThis.fetch = real }
}

test("the key has 5 original and 3 holdout seeds and one control per PR", () => {
  const ids = (kind, set) => KEY.entries.filter((e) => e.kind === kind && (!set || e.set === set)).map((e) => e.id)
  assert.deepEqual(ids("seed", "original"), ["K1", "K2", "K3", "K5", "K7"])
  assert.deepEqual(ids("seed", "holdout"), ["K4", "K6", "K8"])
  assert.deepEqual(ids("control"), ["C1", "C2", "C3", "C4", "C5", "C6"])
})

test("each PR's entries own exactly the lines the PR adds or rewrites", () => {
  for (const pr of PRS) {
    const dir = tree(pr)
    const entries = KEY.entries.filter((e) => e.pr === pr)
    const files = gitOut(dir, "diff", "--cached", "--name-only").trim().split("\n")
    assert.deepEqual([...new Set(entries.flatMap((e) => e.files))].sort(), files, pr)
    for (const f of files) {
      const diff = gitOut(dir, "diff", "--cached", "-U0", "--", f).split("\n").flatMap((l) => {
        const m = l.match(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/)
        if (!m) return []
        const count = m[2] === undefined ? 1 : Number(m[2])
        return Array.from({ length: count }, (_, i) => Number(m[1]) + i)
      })
      const keyed = entries.flatMap((e) => expand(e.changed[f] ?? [])).sort((a, b) => a - b)
      assert.deepEqual(keyed, diff, `${pr} ${f}`)
    }
  }
})

test("every fact is on its line in its PR, and every anchor is in the base", () => {
  const b = base()
  for (const e of KEY.entries) {
    const dir = tree(e.pr)
    for (const f of e.facts) {
      assert.ok(readFileSync(join(dir, f.file), "utf8").split("\n")[f.line - 1]?.includes(f.text), `${e.id}: ${f.file}:${f.line}`)
      if (f.base === "present") assert.ok(readFileSync(join(b, f.file), "utf8").includes(f.text), `${e.id}: ${f.file} in base`)
    }
    if (e.anchor) {
      assert.ok(readFileSync(join(b, e.anchor.file), "utf8").split("\n")[e.anchor.line - 1]?.includes(e.anchor.text), `${e.id} anchor`)
      assert.ok([...e.files, ...e.also].includes(e.anchor.file), `${e.id}: anchor file outside files/also`)
    }
  }
})

test("every PR imports cleanly and passes its own tests", () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  for (const pr of PRS) {
    const dir = tree(pr)
    for (const f of gitOut(dir, "ls-files", "src").trim().split("\n")) execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(join(dir, f)).href)})`], { cwd: dir })
    execFileSync(process.execPath, ["--test", ...gitOut(dir, "ls-files", "test/*.test.js").trim().split("\n")], { cwd: dir, env, stdio: "pipe" })
  }
})

/** One account on a 30-day 1900-cent plan, its subscription started at NOW − 30 days so it is due at NOW. */
async function dueSubscription(dir) {
  const { insert } = await load(dir, "src/infra/db.js")
  const { createAccount } = await load(dir, "src/accounts/index.js")
  const { startSubscription } = await load(dir, "src/subscriptions/index.js")
  insert("plans", { id: "basic", name: "Basic", priceCents: 1900, interval: 30 })
  const accountId = createAccount({ name: "Ada", email: "ada@example.com" })
  return { accountId, id: startSubscription(accountId, "basic", NOW - 30 * DAY) }
}

test("K1: the finance export leaves out a past-due subscription that `listActive` still bills", async () => {
  const dir = tree("pr1")
  const { accountId, id } = await dueSubscription(dir)
  const { listActive, markPastDue } = await load(dir, "src/subscriptions/index.js")
  const { exportActiveCsv } = await load(dir, "src/admin/index.js")
  markPastDue(id, NOW)
  assert.deepEqual(listActive(accountId).map((s) => s.id), [id])
  assert.equal(exportActiveCsv(), "id,accountId,planId,status,renewsAt,graceUntil")
})

test("K2: after a failed renewal the PR ends grace at 72 h but schedules reminders at days 36 and 71", async () => {
  const failed = async (dir) => {
    const { provide } = await load(dir, "src/infra/registry.js")
    const { query } = await load(dir, "src/infra/db.js")
    provide("payments", { charge: async () => ({ id: "ch_1", status: "failed" }) })
    const { id } = await dueSubscription(dir)
    await (await load(dir, "src/invoicing/index.js")).renewDue(NOW)
    return { remindAt: query("invoices")[0].remindAt.map((t) => (t - NOW) / DAY), graceDays: (query("subscriptions", { id })[0].graceUntil - NOW) / DAY }
  }
  assert.deepEqual(await failed(tree("pr2")), { remindAt: [36, 71], graceDays: 3 })
  assert.deepEqual(await failed(base()), { remindAt: [1.5, 2], graceDays: 3 })
})

test("K5: `PATCH /v1/accounts/:id` saves the patch and returns 500 in the PR; the base returns 200 and emails", async () => {
  const run = async (dir) => {
    await load(dir, "src/app.js")
    const { createAccount, getAccount } = await load(dir, "src/accounts/index.js")
    const { patchAccountHandler } = await load(dir, "src/api/accounts-handler.js")
    const { sent } = await load(dir, "src/notifications/index.js")
    const id = createAccount({ name: "Ada", email: "ada@example.com" })
    const res = patchAccountHandler({ params: { id }, body: { name: "Ada L." } })
    return { status: res.status, saved: getAccount(id).name, mails: sent().length }
  }
  assert.deepEqual(await run(tree("pr4")), { status: 500, saved: "Ada L.", mails: 0 })
  assert.deepEqual(await run(base()), { status: 200, saved: "Ada L.", mails: 1 })
})

test("K6: the SMS opt-in changes accounts' cache but not the stored account", async () => {
  const dir = tree("pr4")
  const { createAccount, getSettings } = await load(dir, "src/accounts/index.js")
  const { findAccount } = await load(dir, "src/accounts/repository.js")
  const { enableSms } = await load(dir, "src/notifications/index.js")
  const id = createAccount({ name: "Ada", email: "ada@example.com" })
  enableSms(id)
  assert.deepEqual(getSettings(id).channels, ["email", "sms"])
  assert.deepEqual(findAccount(id).settings.channels, ["email"])
})

test("K7: with Adyen wired in, a charge that went through still marks the renewal past due", async () => {
  const renew = async (dir, chargeResponse) => {
    await load(dir, "src/app.js")
    const { id } = await dueSubscription(dir)
    const { renewDue } = await load(dir, "src/invoicing/index.js")
    const { getSubscription } = await load(dir, "src/subscriptions/index.js")
    const { query } = await load(dir, "src/infra/db.js")
    await withFetch(chargeResponse, () => renewDue(NOW))
    return { subscription: getSubscription(id).status, invoice: query("invoices")[0].status }
  }
  assert.deepEqual(await renew(tree("pr5"), { pspReference: "psp_1", resultCode: "Authorised" }), { subscription: "past_due", invoice: "failed" })
  assert.deepEqual(await renew(base(), { id: "ch_1", status: "succeeded" }), { subscription: "active", invoice: "paid" })
})

test("K8: voiding an invoice cancels the subscription without the cancellation email that `cancel` sends", async () => {
  const run = async (dir, end) => {
    await load(dir, "src/app.js")
    const { insert } = await load(dir, "src/infra/db.js")
    const { id, accountId } = await dueSubscription(dir)
    insert("invoices", { id: "inv_1", subscriptionId: id, accountId, amountCents: 1900, status: "failed" })
    await end(dir, id)
    const { getSubscription } = await load(dir, "src/subscriptions/index.js")
    const { sent } = await load(dir, "src/notifications/index.js")
    return { status: getSubscription(id).status, subjects: sent().map((m) => m.subject) }
  }
  const pr = await run(tree("pr5"), async (dir) => (await load(dir, "src/invoicing/index.js")).voidInvoice("inv_1"))
  assert.deepEqual(pr, { status: "cancelled", subjects: [] })
  const was = await run(base(), async (dir, id) => (await load(dir, "src/subscriptions/index.js")).cancel(id))
  assert.deepEqual(was, { status: "cancelled", subjects: ["Your subscription was cancelled"] })
})
