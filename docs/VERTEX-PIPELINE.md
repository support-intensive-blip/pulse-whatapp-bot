# Vertex AI Vector Search Pipeline

One-page reference for the Vertex AI Vector Search backend that replaced Pinecone as the
default KB vector store on **2026-08-17**. Covers provisioning, the indexing/search pipeline,
every log line you'll see at each step, and how to debug a failure.

---

## Why two backends exist

`vectorStoreService.js` auto-detects which remote backend to use (`src/services/vectorStoreService.js:186-190`):

```
VECTOR_BACKEND env var, if set to vertex|pinecone|local → forced
else: Vertex configured?  → vertex
else: Pinecone configured? → pinecone
else                       → local (TF-IDF, no external calls)
```

Vertex wins auto-detection whenever `GCP_PROJECT_ID`, `VERTEX_INDEX_ID`, `VERTEX_INDEX_ENDPOINT_ID`,
`VERTEX_DEPLOYED_INDEX_ID`, and `VERTEX_INDEX_ENDPOINT_DOMAIN` are all set — which they are in the
current `.env`. Pinecone code (`pineconeVectorStore.js`, `pineconeClient.js`) is untouched and still
works if `VECTOR_BACKEND=pinecone` is forced, but it is not the active path.

Regardless of backend, **BM25 sparse search always runs locally** (`kbBm25Index.js`, disk-backed
JSON) and gets fused with whichever backend's dense results via reciprocal-rank fusion
(`kbHybridSearch.js`) inside `vectorStoreService.hybridSearch()` (`vectorStoreService.js:258-270`).
Vertex/Pinecone only ever supply the *dense* half.

---

## Components

| File | Role |
|------|------|
| `vertexAuth.js` | GCP access token via `google-auth-library` (ADC or service-account key file) |
| `vertexVectorClient.js` | Raw REST calls: embed, upsertDatapoints, removeDatapoints, findNeighbors |
| `vertexMetadataStore.js` | Firestore — stores chunk text/metadata (Vector Search only stores vectors + restricts, no payload) |
| `vertexVectorStore.js` | Orchestrator — chunking → embed → upsert → Firestore write, and query → embed → findNeighbors → Firestore lookup |
| `vectorStoreService.js` | Backend picker + BM25 fusion layer sitting above vertex/pinecone/local |
| `src/scripts/setup-vertex-vector-search.js` | One-time provisioning script (index + endpoint + deploy) |

**Why Firestore is in the loop at all:** Vertex AI Vector Search is a pure ANN index — it stores
only `datapoint_id` + `feature_vector` + `restricts`, no payload. The actual chunk text, tags,
question ID, etc. live in Firestore (`vertexKb/{namespace}/chunks/{id}`), keyed by the same
datapoint id. Every search does two remote calls (`findNeighbors` then Firestore `getAll`), not one.

---

## Provisioning (one-time, per environment)

```bash
GCP_PROJECT_ID=your-project node src/scripts/setup-vertex-vector-search.js
```

This creates, in order: a GCS init bucket → a Vector Search **Index** (`DOT_PRODUCT_DISTANCE`,
tree-AH, `STREAM_UPDATE` so upserts land without a full rebuild) → an **Index Endpoint**
(public) → **deploys** the index onto the endpoint (`e2-standard-2` by default, 20-30+ min).
It prints the env vars to add and reminds you to run
`gcloud firestore databases create --location=<region> --type=firestore-native` once.

⚠️ **A deployed Index Endpoint bills per node-hour continuously, even fully idle.** There is no
serverless/pay-per-query Vertex Vector Search tier — this is the main cost tradeoff vs. Pinecone.

---

## Indexing pipeline (`indexDocument`)

Triggered from the dashboard's "Re-index knowledge base" action or `force-reindex-kb.js`.

```
KB source (.txt/.json/.pdf)
      │
      ▼
kbSemanticChunker.chunkDocument()        step=chunked
      │  (##QA## / QUESTION_ID / JSON / token-fallback — see RAG-FRAMEWORK.md)
      ▼
kbIndexRecords.expandChunksToIndexRecords()
      │  (1 record per main chunk + 1 per QUESTION_VARIATION)
      ▼
vertexVectorClient.embedTexts()          step=embedded    [vertex:embed:<id>]
      │  text-multilingual-embedding-002, 768d, batches of 32, L2-normalized
      │  (normalized so DOT_PRODUCT_DISTANCE on the index == cosine similarity)
      ▼
for each batch of 96 records:
   vertexVectorClient.upsertDatapoints()  step=batch_upserted  [vertex:upsert:<id>]
   vertexMetadataStore.setChunks()        (Firestore write)    [vertex:firestore:<id>]
      ▼
deleteStaleGeneration()                  step=stale_cleanup_done
      │  (removes previous sourceHash generation — only AFTER the new one lands,
      │   so a failed embed/upsert never leaves the namespace empty)
      ▼
vertexMetadataStore.setMeta()             step=meta_written
      │  (sourceHash, chunkCount, indexedAt — Firestore doc at vertexKb/{namespace})
      ▼
done — logged as "Vertex indexed N vectors in <namespace>"
```

Namespace = `global` (no team) or `team-<id>` — implemented as a Vector Search **restrict**
(`namespace: 'team', allow_list: [ns]`), not a separate index. All teams share one physical
index; queries are filtered by restrict at query time.

---

## Search pipeline (`search`)

Triggered on every INTENSIVE-mode KB-eligible chat turn (see `docs/RAG-FRAMEWORK.md` for the
gating rules) and by `debug-kb-query.js`.

```
query text
      │
      ▼
vertexVectorClient.embedQuery()          step=query_embedded   [vertex:embed:<id>]
      │  RETRIEVAL_QUERY task type (asymmetric from RETRIEVAL_DOCUMENT used at index time)
      ▼
vertexVectorClient.findNeighbors()       step=neighbors_found  [vertex:findNeighbors:<id>]
      │  POST to the endpoint's PUBLIC DOMAIN (not aiplatform.googleapis.com),
      │  filtered by the same team restrict
      ▼
vertexMetadataStore.getChunksByIds()     step=metadata_fetched [vertex:firestore:<id>]
      │  batched Firestore getAll() by datapoint id
      │  ⚠ logs step=metadata_gap if Vector Search returns ids Firestore doesn't have —
      │    the #1 silent-failure mode (stale index vs. Firestore, see Troubleshooting)
      ▼
map + sort by semanticScore, apply KB_MIN_SEARCH_SCORE floor
      ▼
returned to vectorStoreService.hybridSearch(), fused with local BM25 results
```

Every stage now logs a shared `[vertex:search:<opId>]` correlation id, elapsed ms, and the
calling host's IPs — see **Logging** below.

---

## Logging

As of this update, every Vertex call logs `START`/`OK`/`FAILED` (or a `step=...` marker for
sub-stages within a larger op) with:

- a per-operation **correlation id** (`[vertex:search:64a7b1b0]`) — grep one id to see every
  step of a single request across auth → embed → findNeighbors → Firestore
- **elapsed ms** for that step
- **host identity**: `private=<LAN/VPC IP> public=<egress IP>` — resolved via
  `src/utils/networkInfo.js` (private: first non-internal IPv4 from `os.networkInterfaces()`;
  public: `api.ipify.org` → `checkip.amazonaws.com` → `ifconfig.me` fallback chain, cached 15 min).
  This is what tells you *which box* made a given call when logs from a local dev machine and a
  production VM interleave, or when diagnosing a firewall/egress-IP-allowlist issue.
- on failure: HTTP status + truncated response body where available

Log line prefixes, in call order:

| Prefix | Emitted by |
|--------|-----------|
| `[vertex:auth]` | `vertexAuth.js` — token acquisition, host identity (once per process) |
| `[vertex:embed:<id>]` | `vertexVectorClient.embedBatch()` |
| `[vertex:upsert:<id>]` | `vertexVectorClient.upsertDatapoints()` |
| `[vertex:remove:<id>]` | `vertexVectorClient.removeDatapoints()` |
| `[vertex:findNeighbors:<id>]` | `vertexVectorClient.findNeighbors()` |
| `[vertex:firestore:<id>]` | `vertexMetadataStore.js` — every Firestore op |
| `[vertex:index:<id>]` | `vertexVectorStore.indexDocument()` — the outer orchestration |
| `[vertex:search:<id>]` | `vertexVectorStore.search()` — the outer orchestration |
| `[vertex:config]` | Missing-env-var diagnosis when `assertEnabled()` fails |

All go through the existing Winston logger (`src/utils/logger.js`) → console + `logs/app.log` +
`logs/error.log` (errors only, 10MB × 5 rotation).

Example (single query, full trace):

```
[vertex:search:64a7b1b0] START namespace=global topK=32 queryLen=19 private=192.168.56.1 public=154.209.252.226
[vertex:embed:1dbe073f] START count=1 taskType=RETRIEVAL_QUERY model=text-multilingual-embedding-002 dims=768 ...
[vertex:auth] getAccessToken OK keyFile=./secrets/whatsapp-bot-bq.json elapsedMs=177
[vertex:embed:1dbe073f] OK returned=1/1 elapsedMs=2048 ...
[vertex:search:64a7b1b0] step=query_embedded namespace=global ...
[vertex:findNeighbors:95e211f5] START namespace=global neighborCount=32 endpoint=1854836082.us-central1-585517343381.vdb.vertexai.goog ...
[vertex:findNeighbors:95e211f5] OK namespace=global neighbors=32 elapsedMs=456 ...
[vertex:search:64a7b1b0] step=neighbors_found namespace=global count=32 ...
[vertex:firestore:bdee8866] getChunksByIds OK namespace=global requested=32 found=32 elapsedMs=1332
[vertex:search:64a7b1b0] step=metadata_fetched namespace=global requested=32 found=32 ...
[vertex:search:64a7b1b0] OK namespace=global returned=32 topScore=0.698 minScoreFilter=0 elapsedMs=4135 ...
```

---

## Troubleshooting

| Symptom | Where to look | Likely cause |
|---|---|---|
| `[vertex:config] not configured — missing env: ...` | thrown at first call | one of the 5 required env vars unset on that host — compare `.env` between dev and prod |
| `[vertex:auth] getAccessToken FAILED` / `ERROR` | auth step | bad/missing `GOOGLE_APPLICATION_CREDENTIALS` path, key file not deployed to that host, or the service account lacks `roles/aiplatform.user` + `roles/datastore.user` |
| `[vertex:embed:...] FAILED status=403` | embed step | service account missing `roles/aiplatform.user`, or Vertex AI API not enabled on the project |
| `[vertex:findNeighbors:...] FAILED status=...` (connection/timeout, not 4xx) | findNeighbors step | wrong `VERTEX_INDEX_ENDPOINT_DOMAIN` (must be the **public domain**, not `aiplatform.googleapis.com`), or outbound egress blocked from that host — check the logged `public=` IP is what you expect to be calling from |
| `[vertex:search:...] EMPTY reason=no_neighbors_returned` | search step | namespace has zero indexed vectors, or restrict/namespace name mismatch (`namespaceFor()` must agree between index-time and query-time) |
| `step=metadata_gap ... missing=N` | search step | Vector Search has datapoint ids Firestore doesn't — usually a `deleteStaleGeneration` that ran against Firestore but the matching `removeDatapoints` call failed (or vice versa); the two stores can drift since they're written in two separate calls, not one transaction |
| Search returns stale/wrong content after a re-index | `[vertex:index:...]` trace for that namespace | check `step=stale_cleanup_done` actually ran — `deleteStaleGeneration` is best-effort and only logs a `warn` on failure, old + new generations can coexist silently |
| Indexing hangs at `step=batch_upserted progress=X/Y` | embed/upsert steps | Vertex embed API rate limiting — retries happen automatically (`withRetry`, 4 attempts, exponential backoff from `VERTEX_EMBED_RETRY_BASE_MS`) but very large re-indexes can still take minutes (1903 vectors ≈ 7-8 min observed) |

### Debug a single query end-to-end

```bash
node src/scripts/debug-kb-query.js "your question" --phone=<owner_phone>
```

Prints KB status, the full hybrid search hit list (fused/dense/sparse scores), whether the
result would actually reach the LLM (topic guard, mode gating), and the assembled prompt —
while every `[vertex:*]` log line streams alongside.

### Force a re-index from CLI

```bash
node src/scripts/force-reindex-kb.js
```

---

## Known cost/ops notes

- Deployed endpoint bills continuously — there's a `team-smoketest` namespace in Firestore
  (1 vector) left over from manual testing before the 2026-08-17 global migration; harmless
  but worth deleting from Firestore (`vertexKb/team-smoketest`) if it's not needed.
- `VERTEX_META_CACHE_TTL_MS` (default 5 min) caches the namespace meta doc (`sourceHash`,
  `chunkCount`) in-process — a re-index from another process won't be picked up as "indexed"
  by this process until the cache expires.
- Migration history: Pinecone hybrid-integrated (377-467 chunks, through 2026-07-21) →
  Vertex AI Vector Search (1,903 chunks, from 2026-08-17), see `docs/RAG-FRAMEWORK.md` for the
  content-authoring side of that jump.

---

*Last updated: 2026-08-19*
