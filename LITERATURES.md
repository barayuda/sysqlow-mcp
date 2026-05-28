# Theoretical Foundations & Literature

This document catalogs the academic and theoretical grounding of **SysQlow-MCP**. It is not ad-hoc engineering — every major subsystem maps to a well-studied class of system in the information retrieval, knowledge representation, and personal knowledge management literature.

If you are contributing to SysQlow, this is your reading list. If you are evaluating the project, this is your "why this is principled" reference.

> **Citation link convention:** Where a stable preprint or open-access version exists (arXiv, W3C, *The Atlantic* archive), the link goes there directly. For paywalled venues (Springer, IEEE, ACM, Elsevier), the link is a deterministic Google Scholar search by title — Scholar returns the canonical paper as the top hit and surfaces every freely-available PDF mirror it has indexed.

---

## 1. The System as a Whole — Personal Knowledge Graphs (PKGs)

SysQlow-MCP is, formally, a **Personal Knowledge Graph** with **context-stratified subgraphs** and **automatic relation extraction via dense vector retrieval**.

### Primary reference

- **Balog, K. & Kenter, T. (2019).** *Personal Knowledge Graphs: A Research Agenda.* In Proceedings of the 2019 ACM SIGIR International Conference on Theory of Information Retrieval (ICTIR '19). [[arXiv:1905.08865]](https://arxiv.org/abs/1905.08865)

  > "A source of structured knowledge about entities and the relations between them, where the entities and the relations between them are of personal, rather than general, interest."

The `technical_knowledge` table is the entity store. The `parent_id`, `knowledge_relations` (planned), and embedding similarity edges form the relation graph. The `project_id` scoping (planned) implements **context stratification** — the principal open problem in the PKG agenda.

### Active research venues

- **PKGC @ TheWebConf** — annual workshop on Personal Knowledge Graph Construction [[Scholar]](https://scholar.google.com/scholar?q=Personal+Knowledge+Graphs+Construction+workshop+TheWebConf)
- **Krisztian Balog (University of Stavanger)** [[Scholar profile]](https://scholar.google.com/citations?user=phb2L4cAAAAJ)
- **Tara Safavi (Microsoft Research)** [[Scholar profile]](https://scholar.google.com/citations?user=tdJI5GsAAAAJ)

---

## 2. The Coherence Engine — Knowledge Graph Refinement

The planned coherence engine (category corrector, relation discoverer, confidence tuner) is a textbook implementation of **Knowledge Graph Refinement** as formally defined in the canonical survey:

### Primary reference

- **Paulheim, H. (2017).** *Knowledge Graph Refinement: A Survey of Approaches and Evaluation Methods.* Semantic Web Journal, 8(3), 489–508. [[DOI:10.3233/SW-160218]](https://doi.org/10.3233/SW-160218) · [[Scholar]](https://scholar.google.com/scholar?q=Paulheim+Knowledge+Graph+Refinement+Survey+2017)

Paulheim defines two refinement operations — both of which SysQlow implements:

| Paulheim's name | SysQlow implementation |
|---|---|
| **Completion** (adding missing knowledge) | `discoverRelations()` — finds missing `uses`, `extends`, `same_concept` edges via embedding similarity |
| **Error Detection / Correction** | `correctCategory()` — re-assigns misclassified snippets; `decayStaleConfidence()` — corrects stale confidence scores |

The taxonomy also distinguishes:

- **Internal methods** (Paulheim §3.2) — refinement using the KG's own structure. *SysQlow's keyword matching + embedding-neighbor voting belongs here.*
- **External methods** (Paulheim §3.3) — refinement using outside sources. *SysQlow's Sentinel validation (web search + LLM) belongs here.*

This makes SysQlow a **hybrid internal/external refinement system** — the architecture Paulheim explicitly identifies as the most robust class.

---

## 3. Project Scoping — Contextualized Knowledge Repositories

The `project_id` scoping rule (project-scoped snippets + a shared generic layer + cross-project opt-in reads but strict-isolation writes) is a lightweight implementation of **Contextualized Knowledge Graphs**.

### Primary references

- **Serafini, L. & Homola, M. (2012).** *Contextualized Knowledge Repositories for the Semantic Web.* Journal of Web Semantics, 12, 64–87. [[Scholar]](https://scholar.google.com/scholar?q=Serafini+Homola+Contextualized+Knowledge+Repositories+Semantic+Web+2012)
- **Brewka, G. & Eiter, T. (2007).** *Equilibria in Heterogeneous Nonmonotonic Multi-Context Systems.* AAAI '07. [[Scholar]](https://scholar.google.com/scholar?q=Brewka+Eiter+Heterogeneous+Nonmonotonic+Multi-Context+Systems+2007) — The **Multi-Context Systems (MCS)** formalism.
- **W3C RDF 1.1 Named Graphs (Dataset model)** — [[w3.org/TR/rdf11-concepts]](https://www.w3.org/TR/rdf11-concepts/#section-dataset) — the practical web-standard representation of context.

### Mapping to formal terms

| SysQlow concept | Formal name |
|---|---|
| `project_id = "X"` | A **named context** / named graph identifier |
| `project_id IS NULL` (generic) | **T-Box** — schema-level / shared knowledge |
| `project_id = "X"` (project rows) | **A-Box** — assertions specific to context X |
| "No cross-project relations" rule | **Context isolation invariant** |
| `promote_to_generic` operation | **Context generalization** — lifting an A-Box assertion to T-Box scope |
| Cross-project recall opt-in | **Federated query across contexts** |

The two-layer rule SysQlow enforces — **permissive reads, strict relation writes** — is what the federated database literature calls *"weak consistency on retrieval, strong consistency on integration"*: a known pattern in multi-source data systems (Hose & Schenkel, *VLDB Journal* 2013). [[Scholar]](https://scholar.google.com/scholar?q=Hose+Schenkel+federated+SPARQL+VLDB+Journal+2013)

---

## 4. Sentinel Validation — Knowledge Base Verification & Truth Discovery

The Sentinel engine (web search → LLM cross-reference → confidence scoring) is a modern instantiation of **Truth Discovery / Knowledge Base Verification**.

### Primary references

- **Yin, X., Han, J. & Yu, P. S. (2007).** *Truth Discovery with Multiple Conflicting Information Providers on the Web.* KDD '07. [[Scholar]](https://scholar.google.com/scholar?q=Yin+Han+Yu+Truth+Discovery+Multiple+Conflicting+Information+Providers+2007) — The seminal "TruthFinder" paper.
- **Li, Y., Gao, J., Meng, C., Li, Q., Su, L., Zhao, B., Fan, W. & Han, J. (2016).** *A Survey on Truth Discovery.* ACM SIGKDD Explorations Newsletter, 17(2), 1–16. [[Scholar]](https://scholar.google.com/scholar?q=Li+Gao+Meng+Survey+on+Truth+Discovery+2016)
- **Dong, X. L., Gabrilovich, E., Murphy, K., Dang, V., Horn, W., Lugaresi, C., Sun, S. & Zhang, W. (2015).** *Knowledge-Based Trust: Estimating the Trustworthiness of Web Sources.* PVLDB 8(9), 938–949. [[arXiv:1502.03519]](https://arxiv.org/abs/1502.03519)

SysQlow's `confidence_score` (1–10), `is_validated` flag, and `source_url` field map directly to the classical TruthFinder variables: **fact trustworthiness**, **source reliability**, **claim confidence**. The Sentinel cron's periodic re-validation is what this literature calls **incremental truth maintenance**.

---

## 5. Embedding-based Relation Discovery — Dense Retrieval

The semantic search tool and `discoverRelations` engine both use **dense vector retrieval** — a paradigm shift in IR documented in:

### Primary references

- **Wang, Q., Mao, Z., Wang, B. & Guo, L. (2017).** *Knowledge Graph Embedding: A Survey of Approaches and Applications.* IEEE Transactions on Knowledge and Data Engineering (TKDE), 29(12), 2724–2743. [[Scholar]](https://scholar.google.com/scholar?q=Wang+Mao+Wang+Guo+Knowledge+Graph+Embedding+Survey+2017)
- **Karpukhin, V., Oğuz, B., Min, S., Lewis, P., Wu, L., Edunov, S., Chen, D. & Yih, W. (2020).** *Dense Passage Retrieval for Open-Domain Question Answering.* EMNLP '20. [[arXiv:2004.04906]](https://arxiv.org/abs/2004.04906) — The "DPR" paper.
- **Johnson, J., Douze, M. & Jégou, H. (2017).** *Billion-scale similarity search with GPUs.* [[arXiv:1702.08734]](https://arxiv.org/abs/1702.08734) — The **FAISS** paper, foundational for ANN retrieval.

### Engineering note

SysQlow currently stores embeddings as JSON-serialized `TEXT` and computes cosine similarity in-process (TypeScript). Academically, this is **brute-force k-NN** retrieval. At scales >100k snippets, this should migrate to **Approximate Nearest Neighbor (ANN)** retrieval — libSQL's native vector type with HNSW or IVF indexing. The trade-off (perfect recall vs. logarithmic query time) is documented in:

- **Malkov, Y. A. & Yashunin, D. A. (2018).** *Efficient and robust approximate nearest neighbor search using Hierarchical Navigable Small World graphs.* IEEE TPAMI 42(4), 824–836. [[arXiv:1603.09320]](https://arxiv.org/abs/1603.09320) — The **HNSW** paper.

---

## 6. Provenance — Where Knowledge Comes From

Every snippet in SysQlow tracks `source_url`, `discovered_by`, `created_at`, `last_validated_at`. This is **provenance metadata** — a first-class concern in modern knowledge systems.

### Primary references

- **W3C PROV-O: The PROV Ontology** (W3C Recommendation, 30 April 2013). [[w3.org/TR/prov-o]](https://www.w3.org/TR/prov-o/)
- **W3C PROV Primer** — gentle introduction to PROV concepts. [[w3.org/TR/prov-primer]](https://www.w3.org/TR/prov-primer/)
- **Moreau, L. & Groth, P. (2013).** *Provenance: An Introduction to PROV.* Synthesis Lectures on the Semantic Web: Theory and Technology, Morgan & Claypool. [[Scholar]](https://scholar.google.com/scholar?q=Moreau+Groth+Provenance+An+Introduction+to+PROV+2013)

PROV-O defines three primitives — **Entity**, **Activity**, **Agent** — and SysQlow's fields map cleanly: the snippet is an Entity, `validateKnowledgeItem()` is an Activity, the Sentinel/LLM is an Agent. The `discovered_by` column (planned: `'coherence_engine'` vs `'user'` vs `'auto_hook'`) makes the Agent explicit.

---

## 7. Confidence Decay — Temporal Knowledge Graphs

The planned `decayStaleConfidence()` function — reducing confidence on snippets not accessed in N days — is grounded in **Temporal Knowledge Graphs** and **information aging** research.

### Primary references

- **Leblay, J. & Chekol, M. W. (2018).** *Deriving Validity Time in Knowledge Graphs.* In Companion Proceedings of TheWebConf 2018. [[Scholar]](https://scholar.google.com/scholar?q=Leblay+Chekol+Deriving+Validity+Time+Knowledge+Graphs+2018)
- **Trivedi, R., Dai, H., Wang, Y. & Song, L. (2017).** *Know-Evolve: Deep Temporal Reasoning for Dynamic Knowledge Graphs.* ICML '17. [[arXiv:1705.05742]](https://arxiv.org/abs/1705.05742)
- **Ebbinghaus, H. (1885).** *Über das Gedächtnis: Untersuchungen zur experimentellen Psychologie.* Duncker & Humblot. [[Project Gutenberg DE]](https://www.projekt-gutenberg.org/ebbingha/gedaecht/gedaecht.html) — the original **forgetting curve**, ancestor of all knowledge-aging models. English translation: *Memory: A Contribution to Experimental Psychology* (1913). [[archive.org]](https://archive.org/details/memorycontributi00ebbiuoft)

The cognitive principle: knowledge unused decays in trust; knowledge accessed reinforces. Spaced-repetition systems (Anki, SuperMemo) operationalize the same idea on the consumer side.

---

## 8. Category Normalization — Ontology Alignment

The `normalizeCategory()` helper ([src/index.ts:102](src/index.ts:102)) — mapping aliases like `"api"`, `"server"`, `"db"` to canonical labels `"Backend"`, `"Database"` — is a **lightweight ontology alignment** operation.

### Primary references

- **Euzenat, J. & Shvaiko, P. (2013).** *Ontology Matching* (2nd ed.). Springer-Verlag. ISBN 978-3-642-38720-3. [[Scholar]](https://scholar.google.com/scholar?q=Euzenat+Shvaiko+Ontology+Matching+Springer+2013) — The canonical book on the topic.
- **Otero-Cerdeira, L., Rodríguez-Martínez, F. J. & Gómez-Rodríguez, A. (2015).** *Ontology matching: A literature review.* Expert Systems with Applications, 42(2), 949–971. [[Scholar]](https://scholar.google.com/scholar?q=Otero-Cerdeira+Ontology+matching+literature+review+2015)

The canonical category list (`Backend`, `Frontend`, `DevOps`, `Project Context`, `Database`, `Testing`, `Tooling`) is a **flat lightweight ontology** — sometimes called a **folksonomy with controlled vocabulary**. Tagging systems on Stack Overflow and GitHub use the same pattern.

---

## 9. The Philosophical Ancestors

Before there were papers, there were two ideas every contributor should know.

### Vannevar Bush — The Memex

- **Bush, V. (1945).** *As We May Think.* The Atlantic Monthly, July 1945. [[theatlantic.com — full text]](https://www.theatlantic.com/magazine/archive/1945/07/as-we-may-think/303881/)

Bush imagined a personal device storing all of a user's books, records, and communications, with **associative trails** linking related items — explicitly modeled after how the human mind works "by association." Every PKG, every "second brain," every Obsidian/Roam/Logseq tool is a descendant of the Memex. SysQlow's `discoverRelations()` mechanizes Bush's *associative trail* idea using cosine similarity over neural embeddings — a method Bush could not have imagined, applied to the exact problem he framed.

### Niklas Luhmann — The Zettelkasten

A German sociologist who built a 90,000-note knowledge system on paper index cards (1950s–1990s), with strict discipline:

1. **Atomic notes** — one idea per card
2. **Unique identifiers** — every card numbered
3. **Explicit links between notes** — references written on the cards themselves
4. **Emergent structure** — no top-down taxonomy; categories arise from the linking pattern

SysQlow's data model is digital Zettelkasten:

| Luhmann | SysQlow |
|---|---|
| Atomic note | One `technical_knowledge` row |
| Unique number | `id TEXT PRIMARY KEY` (UUID) |
| Explicit link | `parent_id`, `knowledge_relations` (planned) |
| Emergent structure | Vis.js graph + category clustering |

Recommended reading on Luhmann's method:

- **Schmidt, J. F. K. (2018).** *Niklas Luhmann's Card Index: The Fabrication of Serendipity.* Sociologica, 12(1), 53–60. [[Scholar]](https://scholar.google.com/scholar?q=Schmidt+Luhmann+Card+Index+Fabrication+Serendipity+Sociologica+2018) — Sociologica is open-access; the PDF is on the journal's site.
- **The Bielefeld Zettelkasten archive** — Luhmann's original cards, digitized. [[ds.ub.uni-bielefeld.de/viewer/collections/zettelkasten]](https://ds.ub.uni-bielefeld.de/viewer/collections/zettelkasten/)

---

## 10. Where SysQlow Sits in the Landscape

Most consumer "AI second brain" products (Notion AI, Mem, Reflect) have **flat, single-context** knowledge graphs — they do not model context-stratified scoping or context-isolation invariants. SysQlow's planned `project_id` scoping with cross-context opt-in is more theoretically grounded than the products charging monthly subscriptions for the same surface feature.

The closest **academic** systems to SysQlow's planned architecture are:

- **Packer, C., Wooders, S., Lin, K., Fang, V., Patil, S. G., Stoica, I. & Gonzalez, J. E. (2023).** *MemGPT: Towards LLMs as Operating Systems.* [[arXiv:2310.08560]](https://arxiv.org/abs/2310.08560) — hierarchical memory tiers for LLM agents.
- **Xu, W. et al. (2025).** *A-MEM: Agentic Memory for LLM Agents.* [[Scholar]](https://scholar.google.com/scholar?q=A-MEM+Agentic+Memory+LLM+Agents+2025) — the closest published analog to SysQlow's coherence engine; uses similarity-based linking + automatic note refinement.
- **Sumers, T. R., Yao, S., Narasimhan, K. & Griffiths, T. L. (2023).** *Cognitive Architectures for Language Agents.* [[arXiv:2309.02427]](https://arxiv.org/abs/2309.02427) — the broader theoretical frame for agent memory systems.

The closest **engineered** systems are:

- **Obsidian** + Smart Connections plugin [[obsidian.md]](https://obsidian.md) [[smart-connections]](https://github.com/brianpetro/obsidian-smart-connections) — manual linking + embedding suggestions
- **Logseq** [[logseq.com]](https://logseq.com) — outline-based Zettelkasten with backlinks
- **mem.ai** [[mem.ai]](https://mem.ai) — embedding-based PKG with weaker context modeling

SysQlow's differentiator: **MCP-native** (the knowledge is queryable by any LLM agent over [Anthropic's Model Context Protocol](https://modelcontextprotocol.io/)) + **self-validating** (Sentinel) + **context-stratified** (project scoping).

---

## 11. Suggested Reading Order

For new contributors who want to understand the "why" before the "how":

1. **Bush 1945** — *As We May Think* (1 hour, free online). [[link]](https://www.theatlantic.com/magazine/archive/1945/07/as-we-may-think/303881/) The vision.
2. **Schmidt 2018** — *Luhmann's Card Index* (1 hour). [[Scholar]](https://scholar.google.com/scholar?q=Schmidt+Luhmann+Card+Index+Fabrication+Serendipity+Sociologica+2018) The method.
3. **Balog & Kenter 2019** — *PKGs: A Research Agenda* (45 min). [[arXiv:1905.08865]](https://arxiv.org/abs/1905.08865) The modern framing.
4. **Paulheim 2017** — *KG Refinement: A Survey* (3 hours). [[DOI:10.3233/SW-160218]](https://doi.org/10.3233/SW-160218) The mechanics of the coherence engine.
5. **W3C PROV Primer** (1 hour). [[w3.org/TR/prov-primer]](https://www.w3.org/TR/prov-primer/) The provenance vocabulary.

The first three are enough to understand the system at a design level. Paulheim is the operations manual for the coherence work. PROV-O is the formal grammar for the metadata fields.

---

## 12. Citation Format for SysQlow Contributors

When discussing SysQlow architecture in commits, PRs, or design docs, prefer formal vocabulary from the literature. Examples:

- ❌ *"This snippet got mis-categorized."*
- ✅ *"Type-1 refinement error (Paulheim §2.3) — entity assigned to the wrong class."*

- ❌ *"We don't want snippets from project A leaking into project B."*
- ✅ *"We enforce the context isolation invariant on relation writes (Serafini & Homola 2012)."*

- ❌ *"Old snippets should lose confidence."*
- ✅ *"Temporal validity decay on stale entities (Leblay & Chekol 2018)."*

Precise vocabulary makes design discussions sharper and onboarding faster.
