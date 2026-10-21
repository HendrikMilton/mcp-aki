# mcp-aki

Remote MCP server over Estonian data-protection law, exposed to claude.ai as a custom connector.
It serves **two corpora from one endpoint, as two separate tool sets**:

| | corpus | tools |
|---|---|---|
| `aki` | the Data Protection Inspectorate's own decisions, built here | `search_decisions`, `get_decision`, `list_decisions` |
| `rt` | data-protection decisions of the Estonian courts, built by [mcp-rt](https://github.com/HendrikMilton/mcp-rt) | `search_court_decisions`, `get_court_decision`, `list_court_decisions` |

The indexes stay separate on purpose. Merging would bury 657 AKI decisions under roughly ten times
as much court text, and the two answer different questions — AKI is the regulator's own practice,
the courts are how those positions fared on review. Each corpus is a `Corpus<D>` descriptor in
`src/lib/store.ts` with its own bucket, prefix, document type and embedding text, and the loader
caches them independently, so a Lambda container that only ever answers AKI questions never
downloads the larger court index.

The rest of this file describes the AKI corpus; see the [mcp-rt README](https://github.com/HendrikMilton/mcp-rt#readme) for how the court corpus
is selected, which is the hard part of that half.

657 decisions across three categories — `ettekirjutused`, `vaideotsused`, `seisukohad` — 2021
onwards, 12,113 chunks. The whole published set; three are scans with no text layer and go through
Textract (see Chunking).

## Retrieval

Hybrid, three stages, because on a 24-query Estonian eval neither leg alone held up:

| | lawyer-phrased MRR | paraphrased MRR |
|---|---|---|
| dense only | 0.58 | 0.66 |
| BM25 only | 0.91 | 0.53 |
| **fused + reranked** | **0.87** | **0.89** |

1. **BM25** over all chunks. Estonian has no stock stemmer, so tokens are conflated by 6-char
   prefix (`STEM_PREFIX`) — worth +0.15 MRR over raw tokens.
2. **Dense** — Cohere Embed v4 (`eu.cohere.embed-v4:0`, 1536d, asymmetric input types),
   exhaustive cosine over int8-quantised vectors. At ~11k chunks an ANN index would only cost recall.
3. **RRF fusion → Cohere Rerank 3.5** (`cohere.rerank-v3-5:0`) over the top 80. Pool depth matters:
   recall hit 1.00 at 80 and fell off at 40 and 20.

Both models run in `eu-central-1`, and the embed inference profile only fans out across EU regions,
so the corpus never leaves the EU.

## Chunking

Three decisions are published as scans with no text layer. Those fall back to Textract — not a
listed language for Estonian, but detection is character-level and returns correct diacritics and
section headings. The result is cached as `text/{id}.txt`, so each scan is only paid for once, and
those documents are flagged `OCR` in tool output.

Decisions share a fixed skeleton of ALL-CAPS headings (`RESOLUTSIOON`, `FAKTILISED ASJAOLUD`,
`ANDMEKAITSE INSPEKTSIOONI PÕHJENDUSED`, …). Split on those first, then window to ~1400 chars with
200 char overlap on sentence boundaries. Roughly half of all chunks land in the legal reasoning
section, which is the part worth retrieving.

## Storage

No vector database. The index is ~21MB — 17.6MB of int8 vectors, 3MB of gzipped text and metadata —
held as three S3 objects and loaded into Lambda memory on cold start:

```
s3://hycapital-aki-rag/
  raw/{category}/{year}/{id}.pdf   source PDFs
  text/{id}.txt                    extracted text, served by get_decision
  index/meta.json.gz               docs + chunks
  index/vectors.i8                 int8 unit vectors
  index/scales.f32                 per-vector dequantisation scale
```

## Tools

- `search_decisions(query, category?, year_from?, year_to?, norm?, top_k?)`
- `get_decision(id)`
- `list_decisions(category?, year_from?, year_to?, norm?, limit?)` — switches to one line per
  decision past 20 results, since the six-line form overflowed the client buffer and got truncated
  mid-entry, which produced confidently wrong summaries rather than an error

The court tools mirror these, with `menetlus` (procedure type) and `tier` (court level) in place of
`category`:

- `search_court_decisions(query, menetlus?, tier?, year_from?, year_to?, norm?, top_k?)`
- `get_court_decision(id)`
- `list_court_decisions(menetlus?, tier?, year_from?, year_to?, norm?, limit?)`

`/health` reports both indexes, and reports one being unavailable rather than failing — a court
index that has not been built yet must not take the AKI tools down with it.

The listing pages carry per-decision metadata (`Kuupäev`, `Õigusnormid`, `Adressaat`, `Teema`) in
HTML tables; that is scraped alongside the PDFs and drives the filters.

## Operating

```bash
yarn crawl                  # parse listing pages, print counts
yarn ingest                 # crawl, fetch, chunk, embed, write index to S3
yarn build:lambda           # produce lambda.zip for terraform
yarn start                  # serve locally on :3000
```

`LOCAL_PDF_DIR=<dir>` makes ingest read `<dir>/{category}/{year}/{id}.pdf` instead of refetching.
aki.ee returns 429 under concurrent load — the crawler is deliberately serial with a 1.2s pause.

Ingest is incremental: decisions already in the index keep their text and vectors, so the monthly
EventBridge run only pays for what AKI published since. A decision is re-embedded without refetching
if its title changed, since the title is embedded alongside every chunk.

Warm search latency is ~0.8s, almost all of it the two Bedrock round trips.

## Auth

The corpus is public, so the endpoint is unauthenticated behind an unguessable path segment
(`/mcp/<32 chars>`, generated by terraform) plus API Gateway throttling. That protects the Bedrock
bill, which is the only thing at stake. `terraform output -raw aki_mcp_url` gives the connector URL.
