-- 客厅/卧室/回忆录/日记的所有留言
create table if not exists messages (
  id bigint primary key,
  room text not null,
  text text not null,
  attachments jsonb,
  from_muse boolean not null default false,
  kind text,
  thread_id bigint not null,
  created_at timestamptz not null default now()
);
create index if not exists messages_room_idx on messages (room, id desc);
create index if not exists messages_thread_idx on messages (room, thread_id);

-- 长期记忆：普通 / 历史敏感 / 当前状态 合并成一张表，用 type 区分
create table if not exists memories (
  id text primary key,
  type text not null check (type in ('ordinary', 'sensitive_history', 'current_state')),
  dedupe_key text,
  title text not null,
  summary text not null,
  retrieval_tags jsonb not null default '[]',
  -- sensitive_history 专用
  occurred_at text,
  current_status text,
  interaction_implications jsonb,
  sensitivity text,
  -- current_state 专用
  status text,
  evidence text,
  confidence numeric,
  expires_at timestamptz,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists memories_type_idx on memories (type);
create unique index if not exists memories_dedupe_idx on memories (type, dedupe_key) where dedupe_key is not null;

-- 每段对话的滚动摘要
create table if not exists conversation_summaries (
  room text not null,
  thread_id text not null,
  chunks jsonb not null default '[]',
  covered_through bigint not null default 0,
  covered_count int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (room, thread_id)
);

-- 缪时的可衰减状态（情绪/精力等），只有一行
create table if not exists muse_state (
  id int primary key default 1,
  mood text,
  body text,
  energy int,
  relationship_intensity int,
  pending_responses jsonb not null default '[]',
  updated_at timestamptz,
  constraint muse_state_singleton check (id = 1)
);

-- 主动消息的调度状态，只有一行
create table if not exists proactive_state (
  id int primary key default 1,
  last_sent_at timestamptz,
  recent_urls jsonb not null default '[]',
  constraint proactive_state_singleton check (id = 1)
);

-- 待弹出的主动消息，弹一次清空一次
create table if not exists proactive_pending (
  id int primary key default 1,
  message_id bigint,
  text text,
  room text,
  created_at timestamptz,
  constraint proactive_pending_singleton check (id = 1)
);

-- 图片附件记录（文件本体仍然存在 Vercel Blob 里）
create table if not exists media (
  id text primary key,
  pathname text not null,
  mime_type text not null,
  bytes int not null,
  created_at timestamptz not null default now()
);

-- 关键一步：打开 RLS 但不加任何 policy，等于默认拒绝所有直接访问。
-- 前端的 anon key 是公开的，如果不加这个，任何人都能绕过 Vercel 后端直接拿 anon key 查数据库。
-- 我们所有真实的读写都走 Vercel 后端用 service_role key，它天生绕过 RLS，不受影响。
alter table messages enable row level security;
alter table memories enable row level security;
alter table conversation_summaries enable row level security;
alter table muse_state enable row level security;
alter table proactive_state enable row level security;
alter table proactive_pending enable row level security;
alter table media enable row level security;
