# 数据库迁移说明

本目录包含 Supabase 数据库的迁移脚本。

## 当前迁移

### `add-memobase-user-id.sql` (2025-12-30)

**目的**: 为 `users` 表添加 `memobase_user_id` 字段，用于持久化微信用户与 Memobase 用户的映射关系。

**执行方法**:

1. 登录 Supabase Dashboard: https://supabase.com/dashboard
2. 进入你的项目
3. 点击左侧菜单 **SQL Editor**
4. 点击 **New query**
5. 复制粘贴 `add-memobase-user-id.sql` 的内容
6. 点击 **Run** 执行

**验证**:

```sql
-- 查看字段是否创建成功
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'users' AND column_name = 'memobase_user_id';

-- 查看索引是否创建成功
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'users' AND indexname = 'idx_users_memobase_user_id';
```

**预期结果**:

```
column_name       | data_type        | is_nullable
------------------+------------------+-------------
memobase_user_id  | character varying| YES

indexname                    | indexdef
-----------------------------+--------------------------------------------------
idx_users_memobase_user_id   | CREATE UNIQUE INDEX idx_users_memobase_user_id...
```

## 回滚

如果需要回滚此迁移：

```sql
-- 删除索引
DROP INDEX IF EXISTS idx_users_memobase_user_id;

-- 删除列
ALTER TABLE users DROP COLUMN IF EXISTS memobase_user_id;
```

## 注意事项

- 迁移脚本使用 `IF NOT EXISTS` 和 `IF EXISTS`，可以安全地重复执行
- 如果表中已有数据，现有用户的 `memobase_user_id` 将为 `NULL`
- 新用户首次连接时会自动创建并填充 `memobase_user_id`
