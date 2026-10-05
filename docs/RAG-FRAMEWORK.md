# RAG Framework (Internal)

> Paths below (`src/...`, `knowledge-base/...`) are relative to `backend/`.

One-page reference for the WhatsApp bot knowledge-base pipeline. Production path (since
2026-08-17): **Vertex AI Vector Search hybrid retrieval** + **QA-delimiter KB files**. Pinecone
was the backend before that (2026-06 to 2026-07-21) and the code path still exists/works if
`VECTOR_BACKEND=pinecone` is forced — see **[VERTEX-PIPELINE.md](VERTEX-PIPELINE.md)** for the
full Vertex indexing/search pipeline, provisioning, and per-step debug logs. Everything below
(chunking, gating, topic guard) is backend-agnostic and applies to both.

---

## When RAG runs

RAG is **not** used on every message. All must be true:

| Gate | Rule |
|------|------|
| Mode | `contextState.mode === INTENSIVE` (platform/KB questions) |
| Access | Owner is team admin with KB configured (`resolveKbTeam`) |
| Index | Team namespace has indexed chunks (`isReady`) |
| Intent | Not casual-only (greetings, “ok thanks”, etc.) |

Otherwise: **prompt-only** reply (team system prompt, no retrieved chunks).

---

## KB file format

Two supported source formats, auto-detected from file content — pick whichever fits your
authoring workflow, both feed the same downstream pipeline (`kbIndexRecords.js` →
Pinecone/BM25).

### Option A — plain text, `##QA##` / `##END##` delimiters

`.txt` — **one entry = one chunk**.

```
##QA##
QUESTION_ID: SPC-001
QUESTION_VARIATIONS:
- When does GC1 start?
- Mem Live doubt session portal ekka undhi
ANSWER:
…full answer text…
TAGS: placement, portal, gc1
SCOPE_NOTE: Intensive 3.0 only
##END##
```

| Field | Indexed for search | In LLM excerpt |
|-------|-------------------|----------------|
| QUESTION_VARIATIONS | Each bullet → separate vector (`passage:`) | Parent ANSWER |
| ANSWER | Main chunk vector | Yes |
| TAGS | Metadata only (Pinecone) | No (stripped) |
| SCOPE_NOTE | Not embedded | No (stripped) |

### Option B — pre-chunked JSON array

`.json` — a JSON array; each record is one chunk (`type: "main"`) or one alternate phrasing
(`type: "variation"`), grouped by `metadata.question_id`.

```json
[
  {
    "chunk_id": "100DOC-001::main",
    "type": "main",
    "embed_text": "Where is the 100 days coding challenge completion form? Here's the link: …",
    "metadata": {
      "question_id": "100DOC-001",
      "canonical_question": "Where is the 100 days coding challenge completion form?",
      "answer": "Here's the link: …",
      "tags": ["100daysofcode", "completion form", "certificate"]
    }
  },
  {
    "chunk_id": "100DOC-001::var_0",
    "type": "variation",
    "embed_text": "how do I submit my 100 days challenge proof",
    "metadata": { "question_id": "100DOC-001" }
  }
]
```

| Field | Indexed for search | In LLM excerpt |
|-------|-------------------|----------------|
| `type: "main"`.`embed_text` | Main chunk vector (`passage:`) | `metadata.answer` |
| `type: "variation"`.`embed_text` | Each record → separate vector (`passage:`) | Parent's `metadata.answer` |
| `metadata.tags` | Metadata only (Pinecone) | No |
| `metadata.canonical_question` | Baked into the `main` embed_text by the author | — |

Parsed by `kbSemanticChunker.chunkDocumentFromJson`. A record with no `metadata.question_id`
(and no `::`-suffixed `chunk_id` to derive one from) is dropped. A `question_id` group with no
`"main"` record is dropped (orphan variations have nothing to resolve back to).

Legacy PDFs, and any `.txt`/`.json` that doesn't match either structured format, fall back to
token-budget chunking (≤500 tokens).

---

## End-to-end flow

```
QA TXT / pre-chunked JSON → chunk (delimiter, QUESTION_ID block, or JSON group) → strip TAGS/SCOPE_NOTE
       → index main + variation vectors (passage:) + BM25 on parent embed text
                                                              ↓
User message → contextual query → English translation (if needed) → hybrid search (query:)
                                                              ↓
                    RRF merge by recordId → top-K → topic alignment gate
                                                              ↓
                    inject into system prompt → main LLM → plain WhatsApp reply
```

The same converted English query is used for **KB search** and the **main LLM user turn**.

---

## Indexing

| Step | Module | Notes |
|------|--------|-------|
| Chunk | `kbSemanticChunker.js` | JSON array (`chunk_id`/`type`/`embed_text`) → `chunkDocumentFromJson`; else `##QA##`/`##END##` = 1 entry; else QUESTION_ID blocks; else legacy token split |
| Expand | `kbIndexRecords.js` | Main chunk + one vector per QUESTION_VARIATION |
| Dense (active) | `vertexVectorStore.js` + `vertexVectorClient.js` | Vertex AI Vector Search; text stored separately in Firestore via `vertexMetadataStore.js` — see [VERTEX-PIPELINE.md](VERTEX-PIPELINE.md) |
| Dense (legacy) | `pineconeVectorStore.js` | `passage:` prefix; `recordId` for RRF dedup; used only if `VECTOR_BACKEND=pinecone` is forced |
| Sparse | `kbBm25Index.js` | Parent embed text only (no TAGS) — runs locally regardless of dense backend |
| Fallback | `vectorStoreService.js` | Local TF-IDF if neither Vertex nor Pinecone is configured |

Backend selection: `vectorStoreService.activeBackend()` (`src/services/vectorStoreService.js:186-190`)
— `VECTOR_BACKEND` env var if set, else auto-detect Vertex → Pinecone → local.

Embedding model — **active (Vertex)**: `text-multilingual-embedding-002` (768d, dot-product ==
cosine after L2 normalization). Query side uses `RETRIEVAL_QUERY` task type, index side uses
`RETRIEVAL_DOCUMENT`.

Embedding model — **legacy (Pinecone)**: `multilingual-e5-large` (1024d, cosine). Query side used
`query:` prefix, index side `passage:` prefix.

---

## Hybrid retrieval

| Env var | Default |
|---------|---------|
| `KB_TOP_K` | 8 |
| `KB_HYBRID_DENSE_WEIGHT` | **0.85** |
| `KB_HYBRID_SPARSE_WEIGHT` | **0.15** |
| `KB_RRF_K` | 60 |
| `KB_MIN_SEARCH_SCORE` | Tune after re-index (RRF scores ≠ raw cosine) |

Variation hits collapse to parent `recordId` in RRF — one matching variation surfaces the full ANSWER.

---

## Topic guard (`kbLlmContext.js`)

Before LLM injection:

1. **Keyword overlap** — chunk text / `questionId` must share a query keyword.
2. **Domain alignment** — when the query implies a topic (placement, DSA, schedule, etc.), the chunk's `QUESTION_ID` prefix must belong to that domain group. Example: a placement-support query must not inject `OC-005` (DSA availability).

If no chunk passes both checks:

```
No relevant excerpt found for this query. Do not invent an answer.
```

Mode: `kb_topic_mismatch` (safe fallback vs wrong-topic injection).

---

## Models & temperature

| Step | Model | Temperature |
|------|-------|-------------|
| Tenglish/Indic → English | `KB_TRANSLATE_MODEL` → gpt-4o | **0.4** |
| Main chat reply | gpt-4o-mini | **0.2** |

---

## Key files

| File | Role |
|------|------|
| `kbSemanticChunker.js` | JSON / QA delimiter chunking + TAGS strip |
| `kbIndexRecords.js` | Variation vector expansion |
| `vertexVectorStore.js` / `vertexVectorClient.js` / `vertexMetadataStore.js` | Active dense backend — see [VERTEX-PIPELINE.md](VERTEX-PIPELINE.md) |
| `pineconeClient.js` / `pineconeVectorStore.js` | Legacy dense backend (`passage:`/`query:` prefixes) |
| `kbHybridSearch.js` | RRF fusion of dense + BM25 |
| `kbLlmContext.js` | Dedupe, token budget, topic guard |
| `knowledgeBaseService.js` | Orchestrator |
| `dashboard/.../Configuration.jsx` | KB prep guidelines in UI |

---

## Debug

```bash
node src/scripts/debug-kb-query.js "when does GC1 start" --team=1
```

**After changing chunking or index shape: re-index the KB** (`Re-index knowledge base` in Configuration).

---

*Last updated: 2026-08-19*
