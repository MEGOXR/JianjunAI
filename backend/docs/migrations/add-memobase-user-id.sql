-- 迁移脚本：添加 memobase_user_id 字段
-- 在 Supabase SQL Editor 中执行此脚本

-- 添加 memobase_user_id 列
ALTER TABLE users
ADD COLUMN IF NOT EXISTS memobase_user_id VARCHAR(100) UNIQUE;

-- 添加索引以提高查询性能
CREATE INDEX IF NOT EXISTS idx_users_memobase_user_id ON users(memobase_user_id);

-- 添加注释
COMMENT ON COLUMN users.memobase_user_id IS 'Memobase 用户 UUID，用于持久化微信用户与 Memobase 用户的映射关系';
