# Migration: lifting the index-size ceiling

**Status: proposed, not started.** Nothing here is built. Written 2026-09-22.

## Why

The court corpus is filtered to ~1,136 decisions because classification runs before embedding, and
that ordering exists to keep the index small enough to hold in Lambda memory. The filter turned out
to be both too strict and too loose — a 40-case adjudication found ~60% of the classifier's
positives are not data-protection cases at all, while genuinely relevant boundary cases were being
dropped. See `mcp-rt/PROGRESS.md`.

The obvious fix — index the whole 21,331-decision candidate pool and let retrieval sort it out —
does not fit the current architecture:

```
21,331 decisions x 22.4 chunks = 477,018 chunks
  int8 vectors, 1536d              733 MB
  BM25 postings (current JS form)  1,632 MB
  raw chunk text (BM25 build)      454 MB
Lambda memory today                2,048 MB
```

Neither leg fits, and BM25 is the bigger problem, not the vectors.

## What is actually binding

**Not the vectors.** Those move to S3 Vectors cleanly — available in `eu-central-1`, verified on
this account. 2.9 GB float32, **$0.18/mo storage, $0.59 one-time write, $2.50 per million queries**.
At ~1,000 searches/month that is rounding error, and the size ceiling disappears entirely.

**The BM25 index.** `buildBm25` rebuilds from full chunk text at every cold start — 1.3s and 69 MB
at 20,028 chunks, extrapolating to **30 seconds and 1.6 GB** at 477k. The memory figure is an
artifact of the data structure, not of BM25 itself: `Map<string, [number, number][]>` costs roughly
40 bytes per posting in JS object overhead. Packed into typed arrays (`Int32Array` of chunk ids,
`Uint16Array` of frequencies, offsets per term) the same 40M postings cost ~6 bytes each:

```
naive Map-of-arrays      ~1,632 MB   does not fit
packed typed arrays        ~250 MB   fits comfortably
```

So BM25 stays in Lambda — it just has to be **built at ingest and shipped**, not rebuilt on every
cold start from text the Lambda should not be holding.

## Target shape

| leg | today | after |
|---|---|---|
| dense | int8 vectors in Lambda RAM, exact scan | S3 Vectors ANN query |
| lexical | BM25 rebuilt from text at cold start | packed postings built at ingest, loaded from S3 |
| chunk text | fully resident | S3, fetched only for the ~80 in the rerank pool |
| rerank | Cohere Rerank 3.5 | unchanged |
| fusion | RRF | unchanged |

**No change to the MCP tools, their arguments, or their output.** The only user-visible difference
is latency: expect roughly +200 ms on a ~0.8 s warm search, since the S3 Vectors query and the
pool's text fetch replace in-process array scans.

## The one real trade

S3 Vectors is approximate nearest-neighbour. `HANDOFF.md` chose in-memory exact search precisely to
avoid that — *"No vector DB — int8 vectors in Lambda memory; 12k chunks is 18MB; ANN would only cost
recall."* That was correct at 12k chunks, where exact cost nothing.

At 477k chunks exact-in-RAM is not on the menu, so the comparison is not ANN vs exact at equal
corpus size. It is **ANN over the whole pool versus exact over a twentieth of it**. More documents
should win that comfortably, but it is unmeasured, and the honest way to settle it is to re-run the
24-query eval in `mcp-aki/README.md` against both.

## Steps

1. Pack the BM25 index into typed arrays; build it in `build.ts` and write it to S3 beside the
   vectors. Measure the real packed size rather than trusting the estimate above.
2. Add an `S3Vectors` implementation behind the existing `Corpus<D>` descriptor so AKI and guidance
   can stay in-memory while only the court corpus moves.
3. Move chunk text out of `meta.json.gz` — fetch per-chunk from S3 for the rerank pool only.
4. Re-run the 24-query eval (lawyer-phrased and paraphrased) on the current index and the new one.
   Do not ship on a smaller corpus performing better by construction; compare like for like first.
5. Re-classify with the corrected prompt (`rt-dp-v2`) and index everything that is not bucket A.

Steps 1–4 are independent of the classifier work and can happen in either order.

## What this does not fix

The classifier still decides what enters the corpus. Lifting the ceiling means the filter can be
loose — drop only decisions with no data-protection content — but it does not mean indexing all
725,752 published decisions. That would be ~16M chunks and a different project.

## Rejected

**OpenSearch Serverless.** Would give BM25 and dense in one place and remove the packing work. It
has a 4-OCU floor at ~$0.24/OCU-hour in `eu-central-1` — roughly **$700/month whether or not anyone
searches**, against ~$0.20 for S3 Vectors. For a corpus one lawyer queries, that is not defensible.
