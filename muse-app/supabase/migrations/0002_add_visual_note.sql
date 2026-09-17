-- 漏掉了图片附件的"视觉备注"字段（用户给图片补充的说明，供日记/记忆提取参考）
alter table messages add column if not exists visual_note text;
