// A deliberately small JSON Schema validator. It covers exactly the keywords the contracts in
// contracts/ actually use — nothing more — because the alternative was adding a dependency to a
// zero-dependency plugin in order to test four schemas.
//
// It stays this small because the schemas never carry a semantic rule: "non-blank after trimming"
// and "P0/P1 needs a scenario" live in the runtime validators and are asserted against them
// directly (see contracts/loop-payload.schema.json "x-runtime" and test/unit/conformance.test.mjs).
// If you find yourself needing minLength, pattern or if/then here, that is the signal a semantic
// rule is being pushed into the wrong layer.

const SUPPORTED = new Set([
  "$schema", "$defs", "$ref", "title", "description",
  "type", "properties", "required", "additionalProperties", "items", "enum",
])

const TYPE_OF = (value) => {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number"
  return typeof value
}

const typeMatches = (value, allowed) => {
  const actual = TYPE_OF(value)
  for (const want of allowed) {
    if (want === actual) return true
    // JSON Schema treats an integer as a valid `number`.
    if (want === "number" && actual === "integer") return true
  }
  return false
}

/** Resolve a local `#/...` pointer against the root document. Remote refs are not supported. */
function resolveRef(root, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) {
    throw new Error(`unsupported $ref ${JSON.stringify(ref)} — only local #/... pointers are supported`)
  }
  let node = root
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~")
    if (node == null || typeof node !== "object" || !(key in node)) {
      throw new Error(`$ref ${ref} does not resolve`)
    }
    node = node[key]
  }
  return node
}

/** Fail loudly on a keyword we do not implement, rather than silently accepting everything. */
function assertSupported(schema, path) {
  for (const key of Object.keys(schema)) {
    if (SUPPORTED.has(key) || key.startsWith("x-")) continue
    throw new Error(`${path}: unsupported schema keyword "${key}" — see scripts/lib/json-schema.mjs`)
  }
}

function check(root, schema, value, path, problems) {
  if (schema.$ref) return check(root, resolveRef(root, schema.$ref), value, path, problems)
  assertSupported(schema, path)

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!typeMatches(value, allowed)) {
      problems.push(`${path}: expected ${allowed.join("|")}, got ${TYPE_OF(value)}`)
      return problems
    }
  }

  // `enum` is checked independently of `type`: a nullable enum lists null as a member.
  if (schema.enum !== undefined && !schema.enum.some((member) => member === value)) {
    problems.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`)
  }

  if (TYPE_OF(value) === "object") {
    const props = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (!(key in value)) problems.push(`${path}: missing required property "${key}"`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) problems.push(`${path}: unexpected property "${key}"`)
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) check(root, sub, value[key], `${path}.${key}`, problems)
    }
  }

  if (TYPE_OF(value) === "array" && schema.items) {
    value.forEach((item, i) => check(root, schema.items, item, `${path}[${i}]`, problems))
  }

  return problems
}

/**
 * Validate `value` against `root`, entering at `entry` (a local pointer, or the root itself).
 * Returns an array of human-readable problems; empty means valid.
 */
export function validate(root, value, entry = null) {
  const schema = entry ? resolveRef(root, entry) : root
  return check(root, schema, value, "$", [])
}

export { resolveRef }
