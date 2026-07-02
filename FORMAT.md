# FORMAT.md — SPEC.md encoding rules

Caveman encoding: drop articles/filler. Fragments OK. Identifiers, paths, code verbatim. Terms exact.

## Sections (order fixed)

- `§G` goal — 1 line.
- `§C` constraints — bullet list, stack + hard limits.
- `§I` interfaces — external surfaces. `I.<name>: <shape>`.
- `§V` invariants — numbered `V1…`. Never renumber. Testable statements.
- `§T` tasks — pipe table: `id|st|task|deps|cites`
  - `st`: `.` todo, `>` in-progress, `x` done, `-` dropped
  - `deps`: T-ids that must be `x` first. Empty = ready when track unblocked.
  - `cites`: §V/§I this task enforces/implements.
  - Track tag in task text: `[CORE] [R]ender [P]hysics [W]ater [C]ontent [PL]ayer [N]et`.
  - Tasks in different tracks with satisfied deps = parallelizable (subagents OK).
- `§B` bugs — pipe table: `id|date|cause|fix`. Every bug gets row. `fix` cites V-id if invariant added.

## Rules

- Numbering monotonic. Never reuse V.N / B.N / T.N.
- SPEC.md mutated only via /spec skill.
- /build executes §T. /check diffs code vs §V.
