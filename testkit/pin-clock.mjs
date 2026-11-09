// Preloaded by childEnv() (NODE_OPTIONS=--import): fixes Date.now for a fixture test run.
const now = Date.parse(process.env.REVIEW_FIXTURE_NOW)
if (Number.isNaN(now)) throw new Error(`pin-clock: bad REVIEW_FIXTURE_NOW ${process.env.REVIEW_FIXTURE_NOW}`)
Date.now = () => now
