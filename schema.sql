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
