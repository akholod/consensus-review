// Crash-path harness for test/unit/run-lane.test.mjs: runs the real helper, then throws from
// onSpawned once the fake has started its grandchild. The helper's exit handler must kill the group.
import { existsSync } from "node:fs"
import { join } from "node:path"
import { main } from "../../scripts/run-lane.mjs"

// `node --test` loads every .mjs under test/; outside run-lane.test.mjs there is nothing to do.
if (!process.env.FAKE_DIR) process.exit(0)

const marker = join(process.env.FAKE_DIR, "codex.1.gc")
await main(process.argv.slice(2), {
  onSpawned: () => {
    const pause = new Int32Array(new SharedArrayBuffer(4))
    for (let i = 0; i < 250 && !existsSync(marker); i++) Atomics.wait(pause, 0, 0, 20)
    throw new Error("crash in onSpawned")
  },
})
