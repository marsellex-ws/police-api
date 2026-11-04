# Leader frozen balances

`20261104_leader_frozen_points.sql` adds a separate registry for historical leader freezes. It does not import archive rows or change any balance automatically.

## Connect this cloud environment

Use secure environment settings, never repository files:

- `SUPABASE_PROJECT_REF`: `pbwgvyhchpzmgqjyqxzv`.
- `SUPABASE_ACCESS_TOKEN`: a Supabase account access token with access to this project. This is a Management API token, not the project's publishable or service-role key. Configure its HTTPS destination as `api.supabase.com`.

After saving/applying the environment settings, run from `/workspace/police-api`:

```sh
node --use-env-proxy scripts/database.mjs
```

The read-only check reports table columns, the existing balance function signature and member constraints. It prints neither credentials nor account data. Confirm the production schema matches the migration: UUID member IDs; JSONB archive `source_data`; member uniqueness on `(department,nickname,track)`; and the existing transactional `pd_quest_adjust_balance` function with the named arguments used in the migration. This environment's local fixture tests do not establish production schema compatibility.

After that check, apply and recheck:

```sh
node --use-env-proxy scripts/database.mjs --apply migrations/20261104_leader_frozen_points.sql
node --use-env-proxy scripts/database.mjs
```

The migration is transactional and repeatable. Existing runtime API credentials `SUPABASE_URL` and `SUPABASE_SECRET_KEY` stay on the API host; the database-management token is not used by the application server.

## Workflow

The site page `frozen-points.html` is linked from quests. Chiefs see the registry for their department; ministers have read access. Only `admin` and `developer` may confirm old records and thaw balances. These restrictions are checked in both the API and database functions; browser-supplied actor, department and amount cannot control a thaw.

An administrator reviews a historical `leader` freeze row, checks the actual amount and confirms it (maximum 400 points per the supplied rules). Confirmation does not debit or credit an active balance. Rows marked already thawed are excluded. Each source row can be registered once. Review flagged/ambiguous archive rows before confirmation; do not infer the frozen amount from a running balance. A confirmation is an assertion that those points remain frozen and were not previously included in the active balance.

For thawing, enter the account login of the returning chief. The database checks their current `leader` role, the original department, and their profile nickname against the owner. It adds the frozen amount to that owner's leader balance, uses the existing balance/ledger function, records before/after amounts and actor, then marks the archive flag. All changes occur together. Repeated requests and mismatched owner/department are rejected. Database failures roll back the credit.

The archive nickname is the available ownership identifier; nickname changes require administrator reconciliation before thawing. No automatic nickname remapping or transfers between departments are implemented. New freeze creation from active balances is outside this archive-recovery workflow.

## Validation performed locally

- 12 Node API tests, including permissions, immutable session actor and duplicate/conflict errors.
- 24 checks in isolated PostgreSQL (PGlite) against a representative schema: import validation, 30 + 300 = 330, duplicate/concurrent thaw, wrong department/identity, role restrictions, rollback after a ledger error, archive flag and SQL function grants.
- 22 browser checks with a simulated API for guest, chief, minister, administrator and developer, including import/thaw forms and mobile layout.

Production migrations and real account balances still require the configured project connection and successful schema inspection.

To reproduce the isolated PostgreSQL checks without adding application dependencies:

```sh
npm install --prefix /tmp/police-sql-check --no-audit --no-fund @electric-sql/pglite@0.3.14
PGLITE_MODULE=/tmp/police-sql-check/node_modules/@electric-sql/pglite/dist/index.js node scripts/test-frozen-points-sql.mjs
```

This test uses an in-memory database and creates its own representative schema. It does not read production credentials or connect to Supabase.
