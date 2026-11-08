#!/usr/bin/env node
// The input side of /consensus-review:plan-review: the one document under review, and where its report goes.
//
//   prepare --wd <WD> --invoke <dir> --doc <path>
//   report --wd <WD>
//
// `prepare` checks the document (a regular file, symlinks followed, 1..131072 bytes, UTF-8 text, not
// only whitespace), finds REPO (`git -C <invoke> rev-parse --show-toplevel`, else null), and writes
// <WD>/diff.patch (the document as a new-file diff under its label), <WD>/doc.json and, with no REPO,
// <WD>/doc-cwd/<basename> (the lanes' empty starting directory). The label is the repo-relative path
// inside REPO, else `.plan-review/<basename>`. It prints doc.json. Any failure is exit 2 with one
// stderr line and nothing written.
// `report`, run after the profile, reads the final <WD>/settings.json `out` and writes the report
// path to doc.json `report`: null for `none`, an explicit file path as given, else
// `plan-review-<slug>-<YYYY-MM-DD>[-N].md` in `.reviews/` or the `out` directory, reserved by an
// empty placeholder (`wx`), so two overlapping runs never get the same name. Relative paths resolve
// against doc.json `invoke`.

import { spawnSync } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

const USAGE = "usage: plan-input.mjs prepare --wd <WD> --invoke <dir> --doc <path> | report --wd <WD>"
const MAX_BYTES = 131072
const MAX_SUFFIX = 1000

const fail = (message) => {
  process.stderr.write(`${message}\n`)
  return 2
}

const writeJson = (path, value) => {
  const text = `${JSON.stringify(value, null, 2)}\n`
  writeFileSync(`${path}.tmp`, text)
  renameSync(`${path}.tmp`, path)
  return text
}

/** The document as a git new-file diff under `label`: every line on the new side, in order. */
export function docDiff(label, text) {
  const lines = text.split("\n")
  const newline = text.endsWith("\n")
  if (newline) lines.pop()
  const body = lines.map((line) => `+${line}\n`).join("")
  return `diff --git a/${label} b/${label}\nnew file mode 100644\n--- /dev/null\n+++ b/${label}\n`
    + `@@ -0,0 +1,${lines.length} @@\n${body}${newline ? "" : "\\ No newline at end of file\n"}`
}

/** The document's bytes and text, or `{ error }` without the `plan-review: <path>: ` prefix. */
const readDoc = (path) => {
  let st
  try {
    st = statSync(path)
  } catch (error) {
    return { error: error.code === "ENOENT" ? "no such file" : String(error.code ?? error.message) }
  }
  if (!st.isFile()) return { error: "not a regular file" }
  if (st.size > MAX_BYTES) return { error: `too large (over ${MAX_BYTES} bytes)` }
  let raw
  try {
    raw = readFileSync(path)
  } catch (error) {
    return { error: String(error.code ?? error.message) }
  }
  if (raw.length > MAX_BYTES) return { error: `too large (over ${MAX_BYTES} bytes)` }
  if (!raw.length) return { error: "empty document" }
  let text
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw)
  } catch {
    return { error: "not a text file" }
  }
  if (text.includes("\0")) return { error: "not a text file" }
  if (!text.trim()) return { error: "empty document" }
  return { raw, text }
}

/** A user-given path as an absolute one: `~` is the home directory, anything relative is under `invoke`. */
const absPath = (path, invoke) => (path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : resolve(invoke, path))

const prepare = ({ wd, invoke: invokeArg, doc: docArg }) => {
  const invoke = resolve(invokeArg)
  if (!existsSync(invoke) || !statSync(invoke).isDirectory()) return fail(`plan-review: ${invokeArg}: not a directory`)
  const path = absPath(docArg, invoke)
  const read = readDoc(path)
  if (read.error) return fail(`plan-review: ${docArg}: ${read.error}`)
  const top = spawnSync("git", ["-C", invoke, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  const repo = top.status === 0 && top.stdout.trim() ? top.stdout.trim() : null
  // The real parent directory and the name as given: a symlinked document keeps its own name.
  const name = basename(path)
  const rel = repo ? relative(realpathSync(repo), join(realpathSync(dirname(path)), name)) : null
  const inRepo = Boolean(rel) && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)
  const label = inRepo ? rel : `.plan-review/${name}`
  const lines = read.text.split("\n").length - (read.text.endsWith("\n") ? 1 : 0)
  writeFileSync(join(wd, "diff.patch"), docDiff(label, read.text))
  if (!repo) {
    mkdirSync(join(wd, "doc-cwd"), { recursive: true })
    writeFileSync(join(wd, "doc-cwd", name), read.raw)
  }
  const doc = { label, path, bytes: read.raw.length, lines, repo, inRepo, invoke }
  process.stdout.write(writeJson(join(wd, "doc.json"), doc))
  return 0
}

const slugOf = (path) => basename(path, extname(path)).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "doc"

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/** The first free `plan-review-<slug>-<date>[-N].md` in `dir`, created empty so no other run takes it. */
const reserve = (dir, stem) => {
  mkdirSync(dir, { recursive: true })
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const file = join(dir, n === 1 ? `${stem}.md` : `${stem}-${n}.md`)
    try {
      closeSync(openSync(file, "wx"))
      return { file }
    } catch (error) {
      if (error.code !== "EEXIST") return { error: `${file}: ${error.code ?? error.message}` }
    }
  }
  return { error: `${join(dir, stem)}: no free name up to -${MAX_SUFFIX}` }
}

const report = ({ wd }) => {
  let doc
  let out
  try {
    doc = JSON.parse(readFileSync(join(wd, "doc.json"), "utf8"))
    out = JSON.parse(readFileSync(join(wd, "settings.json"), "utf8")).settings.out.value
  } catch (error) {
    return fail(`plan-review: cannot read doc.json or settings.json (${error.code ?? error.message})`)
  }
  let file = null
  if (out !== "none") {
    const target = out === "default" ? join(doc.invoke, ".reviews") : absPath(out, doc.invoke)
    const isDir = out === "default" || out.endsWith("/") || (existsSync(target) && statSync(target).isDirectory())
    if (isDir) {
      const reserved = reserve(target, `plan-review-${slugOf(doc.path)}-${today()}`)
      if (reserved.error) return fail(`plan-review: ${reserved.error}`)
      file = reserved.file
    } else {
      file = target
    }
  }
  process.stdout.write(writeJson(join(wd, "doc.json"), { ...doc, report: file }))
  return 0
}

export function main(argv) {
  let values
  let positionals
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: { wd: { type: "string" }, invoke: { type: "string" }, doc: { type: "string" } },
      allowPositionals: true,
    }))
  } catch {
    return fail(USAGE)
  }
  if (positionals.length !== 1 || !values.wd || !existsSync(values.wd)) return fail(USAGE)
  if (positionals[0] === "prepare" && values.invoke && values.doc) return prepare(values)
  if (positionals[0] === "report") return report(values)
  return fail(USAGE)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
