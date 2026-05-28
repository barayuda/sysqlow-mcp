-- Base table for technical snippets
CREATE TABLE IF NOT EXISTS technical_knowledge (
    id TEXT PRIMARY KEY,           -- UUID
    topic TEXT NOT NULL,           -- Subject (e.g., "Laravel Rate Limiting")
    content TEXT NOT NULL,         -- The technical snippet/tip
    category TEXT,                 -- (e.g., "Backend", "Frontend", "DevOps")
    parent_id TEXT REFERENCES technical_knowledge(id) ON DELETE SET NULL, -- Parent snippet for hierarchy
    is_validated BOOLEAN DEFAULT FALSE,
    last_validated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    source_url TEXT,               -- The URL used for validation
    confidence_score INTEGER DEFAULT 0, -- 1-10 rating
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- NOTE: column `project_id TEXT REFERENCES projects(id) ON DELETE SET NULL`
-- is added by auto-migration in src/db.ts so it lands on pre-existing databases too.
-- New databases pick it up via the same migration on first init.

-- Full Text Search virtual table for search fallback
CREATE VIRTUAL TABLE IF NOT EXISTS technical_knowledge_fts USING fts5(
    id UNINDEXED,
    topic,
    content,
    category
);

-- Keep FTS table in sync on INSERT
CREATE TRIGGER IF NOT EXISTS technical_knowledge_ai AFTER INSERT ON technical_knowledge BEGIN
    INSERT INTO technical_knowledge_fts(id, topic, content, category)
    VALUES (new.id, new.topic, new.content, new.category);
END;

-- Keep FTS table in sync on DELETE
CREATE TRIGGER IF NOT EXISTS technical_knowledge_ad AFTER DELETE ON technical_knowledge BEGIN
    DELETE FROM technical_knowledge_fts WHERE id = old.id;
END;

-- Keep FTS table in sync on UPDATE
CREATE TRIGGER IF NOT EXISTS technical_knowledge_au AFTER UPDATE ON technical_knowledge BEGIN
    DELETE FROM technical_knowledge_fts WHERE id = old.id;
    INSERT INTO technical_knowledge_fts(id, topic, content, category)
    VALUES (new.id, new.topic, new.content, new.category);
END;

-- Embeddings table for semantic vector search
CREATE TABLE IF NOT EXISTS technical_knowledge_embeddings (
    id TEXT PRIMARY KEY REFERENCES technical_knowledge(id) ON DELETE CASCADE,
    embedding TEXT NOT NULL
);

-- Projects table: identifies a workspace whose Project Context snippets cohere together.
-- root_path is NULL for "proto-projects" created by topic-prefix migration; they get
-- adopted in place the first time their workspace is opened.
CREATE TABLE IF NOT EXISTS projects (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    root_path      TEXT UNIQUE,
    detected_stack TEXT,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_active_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Allows at most one orphan (proto) project per name; once adopted, the partial index no longer applies.
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name_orphan
    ON projects(name) WHERE root_path IS NULL;

-- Materialized edges between snippets. Replaces on-demand brute-force similarity in /api/graph.
CREATE TABLE IF NOT EXISTS knowledge_relations (
    id            TEXT PRIMARY KEY,
    source_id     TEXT NOT NULL REFERENCES technical_knowledge(id) ON DELETE CASCADE,
    target_id     TEXT NOT NULL REFERENCES technical_knowledge(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL,
    weight        REAL NOT NULL,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_id, target_id, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_relations_source ON knowledge_relations(source_id);
CREATE INDEX IF NOT EXISTS idx_relations_target ON knowledge_relations(target_id);

-- Context isolation invariant: a relation may exist only when at least one endpoint is
-- generic (project_id IS NULL) OR both endpoints belong to the same project.
CREATE TRIGGER IF NOT EXISTS enforce_relation_isolation
BEFORE INSERT ON knowledge_relations
WHEN (
  (SELECT project_id FROM technical_knowledge WHERE id = NEW.source_id) IS NOT NULL
  AND (SELECT project_id FROM technical_knowledge WHERE id = NEW.target_id) IS NOT NULL
  AND (SELECT project_id FROM technical_knowledge WHERE id = NEW.source_id)
     != (SELECT project_id FROM technical_knowledge WHERE id = NEW.target_id)
)
BEGIN
  SELECT RAISE(ABORT, 'context_isolation_violation: cross-project relation forbidden');
END;
