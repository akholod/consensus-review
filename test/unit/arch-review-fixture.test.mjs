// Guards the truth of the arch-review answer key: the key covers the whole change, every fact and
// anchor sits where the key says, each entry applies on its own, and the consequences the key
// names really happen when the seeded code runs. Expected values come from the fixture's rules
// (docs/architecture.md, docs/api.md, docs/events.md inside the fixture) and the seed design in
// docs/design/arch-review-measurements.md, not from runs.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { materialize, keyPath } from "../../testkit/review-fixture.mjs"

const KEY = JSON.parse(readFileSync(keyPath("arch-review"), "utf8"))

const CHANGED = [
  "config/shop.json", "docs/api.md", "docs/events.md", "eslint.config.js",
  "src/api/customers-handler.js", "src/api/orders-handler.js", "src/api/products-handler.js",
  "src/billing/index.js", "src/billing/issue.js", "src/catalog/index.js",
  "src/checkout/confirmation.js", "src/checkout/gift-card.js", "src/checkout/index.js",
  "src/checkout/promo.js", "src/checkout/validate.js", "src/customers/index.js",
  "src/infra/config.js", "src/infra/settings.js", "src/orders/index.js",
  "src/payments/gateway.js", "src/payments/index.js", "src/payments/refund.js",
  "src/reports/index.js", "src/shipping/index.js", "src/shipping/internal/carriers.js",
  "src/shipping/internal/rates.js", "src/ui/order-history.js", "src/ui/price-badge.js",
  "src/ui/receipt.js", "test/customers.test.js",
]

let root
let n = 0
before(() => { root = mkdtempSync(join(tmpdir(), "arch-review-fixture-")) })
after(() => rmSync(root, { recursive: true, force: true }))

/** A fresh tree per use: fixture modules keep state (tables, bus handlers, caches) per directory. */
const tree = (include) => materialize(join(root, `t${++n}`), { fixture: "arch-review", include })
const base = () => tree([])
const head = () => tree()
const load = (dir, rel) => import(pathToFileURL(join(dir, rel)).href)
const gitOut = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" })
const baseFile = (dir, file) => gitOut(dir, "show", `HEAD:${file}`)

/** Replaces global fetch for one call of `fn`; the fixture's HTTP code reads the global. */
async function withFetch(body, fn) {
  const real = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => body })
  try { return await fn() } finally { globalThis.fetch = real }
}

const ORDER_JSON = { id: "ord_1", status: "paid", total: 1500, items: [{ sku: "a", qty: 2, priceCents: 500 }] }

test("the key partitions the change: every changed file belongs to exactly one entry", () => {
  const owned = KEY.entries.flatMap((e) => e.files)
  assert.deepEqual([...owned].sort(), CHANGED)
  assert.deepEqual(gitOut(head(), "diff", "--cached", "--name-only").trim().split("\n"), CHANGED)
})

test("the key has 9 original and 8 holdout seeds, and 4 controls", () => {
  const ids = (kind, set) => KEY.entries.filter((e) => e.kind === kind && e.set === set).map((e) => e.id)
  assert.deepEqual(ids("seed", "original"), ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"])
  assert.deepEqual(ids("seed", "holdout"), ["H1", "H2", "H3", "H4", "H5", "H6", "H7", "H8"])
  assert.deepEqual(KEY.entries.filter((e) => e.kind === "control").map((e) => e.id), ["C1", "C2", "C3", "C4"])
})

test("every fact is on its line in the change, and a `base: present` fact is already in the base", () => {
  const dir = head()
  for (const e of KEY.entries) for (const f of e.facts) {
    const line = readFileSync(join(dir, f.file), "utf8").split("\n")[f.line - 1]
    assert.ok(line?.includes(f.text), `${e.id}: ${f.file}:${f.line} lacks ${f.text}`)
    if (f.base === "present") assert.ok(baseFile(dir, f.file).includes(f.text), `${e.id}: ${f.file} lacks it in base`)
  }
})

test("every seed's anchor is a rule already stated in the base", () => {
  const dir = base()
  for (const e of KEY.entries.filter((x) => x.kind === "seed")) {
    const line = baseFile(dir, e.anchor.file).split("\n")[e.anchor.line - 1]
    assert.ok(line?.includes(e.anchor.text), `${e.id}: ${e.anchor.file}:${e.anchor.line}`)
  }
})

test("each entry applies on its own and changes exactly its files", () => {
  for (const e of KEY.entries) {
    const changed = gitOut(tree(e.files), "diff", "--cached", "--name-only").trim().split("\n")
    assert.deepEqual(changed, [...e.files].sort(), e.id)
  }
})

test("both trees import cleanly and the fixture's own tests pass", () => {
  for (const dir of [base(), head()]) {
    for (const f of gitOut(dir, "ls-files", "src").trim().split("\n")) execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(join(dir, f)).href)})`], { cwd: dir })
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    execFileSync(process.execPath, ["--test", ...gitOut(dir, "ls-files", "test").trim().split("\n")], { cwd: dir, env, stdio: "pipe" })
  }
})

test("S2: the refund breakdown pays out a voided charge that the balance excludes", async () => {
  // Ledger: o1 1000 (voided) and o2 500; fee 50. Balance rule: 500 − 50 = 450; breakdown: 1500 − 50.
  const dir = head()
  const { ledgerFor } = await load(dir, "src/billing/internal/ledger.js")
  const { voidCharge } = await load(dir, "src/billing/index.js")
  const { refundableCents, refundBreakdown } = await load(dir, "src/payments/refund.js")
  ledgerFor("cus_1").add({ orderId: "o1", amount: 1000 })
  ledgerFor("cus_1").add({ orderId: "o2", amount: 500 })
  voidCharge("cus_1", "o1")
  assert.equal(refundableCents("cus_1"), 450)
  assert.equal(refundBreakdown("cus_1").payoutCents, 1450)
})

test("S3: a flash sale rewrites catalog's cache for every caller while the products table keeps the price", async () => {
  const dir = head()
  const { insert, query } = await load(dir, "src/infra/db.js")
  const { getPrice, getProduct } = await load(dir, "src/catalog/index.js")
  const { startFlashSale } = await load(dir, "src/checkout/index.js")
  insert("products", { sku: "a", name: "A", priceCents: 1000, tags: [] })
  startFlashSale(["a"], 50)
  assert.equal(getPrice("a"), 500)
  assert.equal(getProduct("a").priceCents, 500)
  assert.equal(query("products", { sku: "a" })[0].priceCents, 1000)
})

test("S6: the stock hold lapses within 60 ms in the change and is still there in the base", async () => {
  const held = async (dir) => {
    const { placeOrder } = await load(dir, "src/orders/index.js")
    const { heldItems } = await load(dir, "src/orders/reserve.js")
    const id = placeOrder({ customerId: "cus_1", items: [{ sku: "a", qty: 1 }], total: 100 })
    await new Promise((resolve) => setTimeout(resolve, 60))
    return heldItems(id)
  }
  assert.deepEqual(await held(head()), [])
  assert.deepEqual(await held(base()), [{ sku: "a", qty: 1 }])
})

test("S7: the v1 order response has no `total`, and the web order page rejects it", async () => {
  const dir = head()
  const { placeOrder } = await load(dir, "src/orders/index.js")
  const { getOrderHandler } = await load(dir, "src/api/orders-handler.js")
  const id = placeOrder({ customerId: "cus_1", items: [], total: 1500 })
  const { body } = getOrderHandler({ params: { id } })
  assert.equal(body.total, undefined)
  assert.equal(body.totalCents, 1500)
  const { renderOrderPage } = await load(dir, "src/ui/order-page.js")
  await assert.rejects(withFetch({ ...ORDER_JSON, total: undefined, totalCents: 1500 }, () => renderOrderPage("ord_1")), /Order\.total: expected integer cents/)
})

test("S8: a guest order publishes the session id as `customerId`, still at version 1", async () => {
  const dir = head()
  const { subscribe } = await load(dir, "src/infra/bus.js")
  const { placeOrder } = await load(dir, "src/orders/index.js")
  const seen = []
  subscribe("order.placed", (payload) => seen.push(payload))
  placeOrder({ sessionId: "sess_9", items: [], total: 0 })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].customerId, "sess_9")
  assert.equal(seen[0].version, 1)
})

test("S9: the receipt renders NaN line amounts for a valid v1 response; the parsed page renders the total", async () => {
  const { renderReceipt } = await load(head(), "src/ui/receipt.js")
  const { renderOrderPage } = await load(base(), "src/ui/order-page.js")
  const receipt = await withFetch(ORDER_JSON, () => renderReceipt("ord_1"))
  const page = await withFetch(ORDER_JSON, () => renderOrderPage("ord_1"))
  assert.match(receipt, /<li>a × 2: NaN<\/li>/)
  assert.match(page, /Total 15\.00/)
})

test("H4: `invoice.issued` carries `accountId` and no `customerId`, still at version 1", async () => {
  const dir = head()
  const { subscribe } = await load(dir, "src/infra/bus.js")
  await load(dir, "src/billing/index.js")
  const { placeOrder, updateStatus } = await load(dir, "src/orders/index.js")
  const seen = []
  subscribe("invoice.issued", (payload) => seen.push(payload))
  updateStatus(placeOrder({ customerId: "cus_1", items: [], total: 100 }), "paid")
  assert.equal(seen.length, 1)
  assert.equal(seen[0].accountId, "cus_1")
  assert.equal("customerId" in seen[0], false)
  assert.equal(seen[0].version, 1)
})

test("H5: checkout records 12.34 as `paidCents` for a 1234-cent charge; the base records 1234", async () => {
  const paid = async (dir) => {
    const { insert } = await load(dir, "src/infra/db.js")
    const { checkout } = await load(dir, "src/checkout/index.js")
    insert("products", { sku: "a", name: "A", priceCents: 744, tags: [] })
    // 744 for the item + 490 shipping to DE = 1234 cents on the ledger.
    return withFetch({ authorizationId: "auth_1" }, () => checkout({ customerId: "cus_1", items: [{ sku: "a", qty: 1 }], country: "DE" }))
  }
  assert.equal((await paid(head())).paidCents, 12.34)
  assert.equal((await paid(base())).paidCents, 1234)
})

test("H6: with production's `maxItems` config the change accepts 51 lines; the base rejects them", async () => {
  const prod = join(root, "prod-shop.json")
  writeFileSync(prod, JSON.stringify({ maxItems: 50, currency: "EUR" }))
  const lines = Array.from({ length: 51 }, (_, i) => ({ sku: `s${i}`, qty: 1 }))
  const before = process.env.SHOP_CONFIG
  process.env.SHOP_CONFIG = prod
  try {
    const { validateCart: headValidate } = await load(head(), "src/checkout/validate.js")
    const { validateCart: baseValidate } = await load(base(), "src/checkout/validate.js")
    assert.doesNotThrow(() => headValidate(lines))
    assert.throws(() => baseValidate(lines), /a cart holds at most 50 lines/)
  } finally {
    if (before === undefined) delete process.env.SHOP_CONFIG
    else process.env.SHOP_CONFIG = before
  }
})

test("H7: a product with one tag gets `tags` as a string in the change, an array in the base", async () => {
  const tags = async (dir) => {
    const { insert } = await load(dir, "src/infra/db.js")
    const { getProductHandler } = await load(dir, "src/api/products-handler.js")
    insert("products", { sku: "a", name: "A", priceCents: 100, tags: ["sale"] })
    return getProductHandler({ params: { sku: "a" } }).body.tags
  }
  assert.equal(await tags(head()), "sale")
  assert.deepEqual(await tags(base()), ["sale"])
})

test("C1: the customer response keeps `id` and `name` and adds `initials`", async () => {
  const body = async (dir) => {
    const { createCustomer } = await load(dir, "src/customers/index.js")
    const { getCustomerHandler } = await load(dir, "src/api/customers-handler.js")
    return getCustomerHandler({ params: { id: createCustomer({ name: "Ada Lovelace", email: "ada@example.com" }) } }).body
  }
  assert.deepEqual(await body(head()), { id: "cus_1", name: "Ada Lovelace", initials: "AL" })
  assert.deepEqual(await body(base()), { id: "cus_1", name: "Ada Lovelace" })
})

test("C2: `rateFor` gives the same rates and the same error before and after the refactor", async () => {
  for (const dir of [base(), head()]) {
    const { rateFor } = await load(dir, "src/shipping/internal/rates.js")
    assert.deepEqual(["DE", "FR", "NL"].map(rateFor), [490, 690, 590])
    assert.throws(() => rateFor("XX"), /no shipping to XX/)
  }
})

test("C4: `ship` publishes `shipment.created` at version 1 with the documented fields", async () => {
  const dir = head()
  const { subscribe } = await load(dir, "src/infra/bus.js")
  const { ship } = await load(dir, "src/shipping/index.js")
  const seen = []
  subscribe("shipment.created", (payload) => seen.push(payload))
  ship("ord_1", "FR")
  assert.deepEqual(seen, [{ version: 1, orderId: "ord_1", country: "FR", carrier: "colissimo" }])
})
