-- 漏掉了 LLM 在提取时直接判定的 topics 字段（不加这个，inferTopics 会全部退化成关键词推断）
alter table memories add column if not exists topics jsonb;
