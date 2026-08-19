// Renders a JSON Schema node into the type-sketch form the prompts use:
//
//   {"title": str, "severity": "P0"|"P1"|"P2", "line": str|null}
//
// The prompts asked for this shape by hand before it was generated. It is not JSON — `str` is a
// type name, not a value — which is exactly why the earlier plan to JSON.parse those blocks and
// compare them could not work. Generating them instead removes the need to parse anything.

import { resolveRef } from "./json-schema.mjs"

const SCALAR = { string: "str", boolean: "bool", number: "num", integer: "int", null: "null" }

/** One line of `{...}` body, or a scalar/enum/array type expression. */
function typeExpr(root, node) {
  if (node.$ref) return typeExpr(root, resolveRef(root, node.$ref))
  // An enum is more informative than its type, so it wins: "P0"|"P1"|"P2" over str.
  if (node.enum) return node.enum.map((v) => (v === null ? "null" : JSON.stringify(v))).join("|")
  const types = Array.isArray(node.type) ? node.type : [node.type]
  if (types.includes("array")) return `[${node.items ? typeExpr(root, node.items) : "any"}]`
  if (types.includes("object")) return objectExpr(root, node)
  return types.map((t) => SCALAR[t] ?? t).join("|")
}

function objectExpr(root, node) {
  const body = Object.entries(node.properties ?? {})
    .map(([key, sub]) => `"${key}": ${typeExpr(root, sub)}`)
    .join(", ")
  return `{${body}}`
}

/**
 * Wrap a long `{...}` body across lines at property boundaries, so the generated block reads the
 * way the hand-written one did. Splitting on ", " inside the braces is safe because every value is
 * a type expression, never a string containing a comma.
 */
function wrap(expr, indent, width) {
  if (!expr.startsWith("{") || !expr.endsWith("}")) return expr
  const parts = expr.slice(1, -1).split(", ")
  const lines = []
  let current = ""
  for (const part of parts) {
    const candidate = current ? `${current}, ${part}` : part
    // +1 for the opening brace on the first line.
    if (current && indent.length + 1 + candidate.length > width) {
      lines.push(current)
      current = part
    } else {
      current = candidate
    }
  }
  if (current) lines.push(current)
  const inner = `${indent} `
  return `{${lines.join(`,\n${inner}`)}}`
}

/**
 * Render an entrypoint as the fenced sketch a prompt shows. Top-level properties each get their
 * own block; array items are wrapped and indented like the hand-written originals.
 */
export function renderSketch(root, entry, { width = 96 } = {}) {
  const schema = resolveRef(root, entry)
  const lines = ["{"]
  const props = Object.entries(schema.properties ?? {})
  props.forEach(([key, sub], i) => {
    const comma = i === props.length - 1 ? "" : ","
    const types = Array.isArray(sub.type) ? sub.type : [sub.type]
    if (types.includes("array") && sub.items) {
      lines.push(`  "${key}": [`)
      lines.push(`    ${wrap(typeExpr(root, sub.items), "    ", width)}`)
      lines.push(`  ]${comma}`)
    } else {
      lines.push(`  "${key}": ${wrap(typeExpr(root, sub), "  ", width)}${comma}`)
    }
  })
  lines.push("}")
  return lines.join("\n")
}
