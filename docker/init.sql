-- Runs once when the database volume is first created.
-- pgvector is enabled now so the AI assistant can store embeddings next to the books later.
CREATE EXTENSION IF NOT EXISTS vector;
