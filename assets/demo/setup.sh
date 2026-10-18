#!/usr/bin/env bash
# Build the demo repository: a tiny payments module with one commit and an
# uncommitted "partial refunds" change that carries real bugs for the review to find.
set -euo pipefail
D="$1"
rm -rf "$D" && mkdir -p "$D/src" "$D/test" && cd "$D"
git init -q -b main
cat > package.json <<'SRC'
{ "name": "shop-demo", "version": "1.0.0", "type": "module", "scripts": { "test": "node --test" } }
SRC
cat > .gitignore <<'SRC'
.reviews/
node_modules/
SRC
cat > src/orders.js <<'SRC'
// Order state transitions. Money only moves through the gateway.

export function refund(order, gateway) {
  if (!order.paid) throw new Error("order is not paid")
  if (order.refunded) throw new Error("order is already refunded")
  const result = gateway.refund(order.id, order.total)
  order.refunded = true
  return result
}

export function cancel(order) {
  if (order.paid) throw new Error("paid orders are refunded, not cancelled")
  order.cancelled = true
  return order
}
SRC
cat > src/api.js <<'SRC'
import { refund } from "./orders.js"

// POST /orders/:id/refund
export async function refundHandler(req, res, { orders, gateway }) {
  const order = await orders.get(req.params.id)
  if (!order) return res.status(404).json({ error: "not found" })
  try {
    const result = refund(order, gateway)
    await orders.save(order)
    return res.json(result)
  } catch (err) {
    return res.status(409).json({ error: err.message })
  }
}
SRC
cat > test/orders.test.js <<'SRC'
import { test } from "node:test"
import assert from "node:assert/strict"
import { refund } from "../src/orders.js"

const gateway = { refund: (id, amount) => ({ id, amount }) }

test("refunds a paid order in full", () => {
  const order = { id: 1, total: 100, paid: true }
  assert.deepEqual(refund(order, gateway), { id: 1, amount: 100 })
  assert.equal(order.refunded, true)
})

test("refuses an unpaid order", () => {
  assert.throws(() => refund({ id: 2, total: 50, paid: false }, gateway))
})
SRC
git add -A && git -c user.name=demo -c user.email=demo@example.com commit -qm "orders: refunds and cancellation"
# The change under review.
cat > src/orders.js <<'SRC'
// Order state transitions. Money only moves through the gateway.

// Partial refunds: support asked to refund part of an order.
export function refund(order, gateway, amount = order.total) {
  if (order.refunded) throw new Error("order is already refunded")
  const result = gateway.refund(order.id, amount)
  order.refundedAmount = (order.refundedAmount ?? 0) + amount
  order.refunded = order.refundedAmount >= order.total
  return result
}

export function cancel(order) {
  if (order.paid) throw new Error("paid orders are refunded, not cancelled")
  order.cancelled = true
  return order
}
SRC
cat > src/api.js <<'SRC'
import { refund } from "./orders.js"

// POST /orders/:id/refund   body: { amount? }
export async function refundHandler(req, res, { orders, gateway }) {
  const order = await orders.get(req.params.id)
  if (!order) return res.status(404).json({ error: "not found" })
  try {
    const result = refund(order, gateway, req.body.amount)
    await orders.save(order)
    return res.json(result)
  } catch (err) {
    return res.status(409).json({ error: err.message })
  }
}
SRC
cat > test/orders.test.js <<'SRC'
import { test } from "node:test"
import assert from "node:assert/strict"
import { refund } from "../src/orders.js"

const gateway = { refund: (id, amount) => ({ id, amount }) }

test("refunds a paid order in full", () => {
  const order = { id: 1, total: 100, paid: true }
  assert.deepEqual(refund(order, gateway), { id: 1, amount: 100 })
  assert.equal(order.refunded, true)
})

test("refunds part of an order", () => {
  const order = { id: 3, total: 100, paid: true }
  refund(order, gateway, 30)
  assert.equal(order.refundedAmount, 30)
  assert.equal(order.refunded, false)
})
SRC
