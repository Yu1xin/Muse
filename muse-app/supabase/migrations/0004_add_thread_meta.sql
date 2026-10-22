-- 客厅/卧室里每段聊天（thread）的整理信息：分到哪个组、是否隐藏。
-- 没有这一行的 thread 就是“未分组、未隐藏”，所以只有被整理过的聊天才会有记录。
create table if not exists thread_meta (
  room text not null,
  thread_id bigint not null,
  group_name text,
  hidden boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (room, thread_id)
);

-- 和其他表一样：打开 RLS 不加 policy，只允许后端用 service_role 读写。
alter table thread_meta enable row level security;
