# TODO

## Reconcile CLAUDE.md drift between tetsuclaw and tetsuclaw-core

The `CLAUDE.md` files in `tetsuclaw` and `tetsuclaw-core` share roughly 95% of their content but have drifted in small ways. As of 2026-04-09, only `tetsuclaw-core/CLAUDE.md` has a `## Cross-Project Reference` section; `tetsuclaw/CLAUDE.md` does not. Other undocumented drift likely exists.

**To do:**

1. Diff the two files and list every divergence.
2. For each divergence, decide which side is correct (or whether both should merge).
3. Either (a) reconcile them to one canonical version and symlink/include, or (b) explicitly document what each file is responsible for so future drift is intentional.
4. Add a note to whichever file is canonical explaining the relationship.

Noticed 2026-04-09 while adding the NO-SILENT-FAILURES pointer block across all project CLAUDE.md files.
