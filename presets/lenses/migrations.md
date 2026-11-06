---
paths:
  - "migrations/*"
  - "*/migrations/*"
  - "*.sql"
dimension: impact
---
- A migration that changes or drops a column, table or index still works with the code deployed before it (expand, then contract), or the change says why a downtime deploy is acceptable.
- A migration that rewrites or locks a large table names its expected duration or runs in batches.
- Every migration has a working down step, or states that it is irreversible.
- A new non-null column has a default or a backfill before the constraint.
