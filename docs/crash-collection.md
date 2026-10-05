# Crash collection & annotation loop

The runtime records every failed request the router sees into
`<piConfigDir>/switchback/crashes.json` (sha256-keyed, deduped). The store
is machine-local: blocks and crashes are facts about the account, not the
project on disk, and the personal-data scrub gate applies before anything
from this file is promoted into the repo.

## Schema (one entry per sha256(raw) key)

```ts
{
  sample: string;        // the raw error bytes (truncated to 4 KB)
  provider: string;      // the model that failed
  model: string;
  first: number;         // epoch ms
  last: number;          // epoch ms
  count: number;         // increment per record
  verdict: { class, scope, promptVersion } | null;  // null on no-classifier path
  noClassifierReason?: "not-configured" | "unresolvable" | "timeout" | "threw" | "unparseable";
  action: "blind-cycle" | "blocked+advanced" | "stuck-stayed";
  annotated?: { class: ErrorClass, note: string, at: number };  // user-confirmed
  verdictHistory: Array<{ at, verdict, noClassifierReason?, action }>;  // bounded at 50
}
```

## Flow

1. `decideRetry` records one crash per failed retry. Both classified and
   no-classifier paths write — the corpus grows even while no classifier
   is configured. Record errors are swallowed; the crash store is a side
   effect, not a blocker on routing.
2. `classifyError` checks the cache first. If the raw-message sha256 has
   an `annotated` entry, that class is returned directly with
   `source: "annotation"` and `resetAtMs: undefined` (default block).
3. The classifier verdict (when present) is recorded too, but never
   short-circuits the cache. Only the user's `/switchback-annotate`
   command unlocks Tier 2b for those exact bytes.
4. `/switchback-crashes [n]` lists the most-recent N entries with
   short-hash, provider/model, class-or-reason, count, last-seen, and an
   `[annot]` marker for user-annotated entries.
5. `/switchback-annotate <hash> <class> [note...]` writes the
   annotation. Hash must be a unique ≥4-char prefix; class must be one
   of the five valid values; ambiguous or unknown prefix produces a clear
   error.

## Privacy

The crash store is under the agent config dir, not the project. It never
ships in the repo. A future contributor who wants to seed the corpus from
real samples must run the same personal-data scrub gate that the
passive-mining flow used before the 2026-10-04 401 probe was committed
(handlers, machine paths, and account handles are stripped at the same
level). No raw sample is ever pulled from this store into a commit.
