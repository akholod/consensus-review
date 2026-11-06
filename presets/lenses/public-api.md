---
paths:
  - "api/*"
  - "*/api/*"
  - "*.d.ts"
  - "openapi*"
  - "*/openapi*"
dimension: architecture
---
- A removed or renamed export, endpoint, field or flag is a breaking change: it needs a deprecation path or a major version, and the changelog says so.
- A new required parameter or field breaks existing callers; an optional one with a default does not.
- A changed default, error shape or status code is a behaviour change for callers even when the types still match.
