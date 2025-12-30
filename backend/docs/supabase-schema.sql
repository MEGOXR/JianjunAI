-- JianjunAI Supabase 数据库 Schema
-- 在 Supabase SQL Editor 中执行此脚本

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wechat_open_id VARCHAR(100) UNIQUE NOT NULL,
  nickname VARCHAR(100),
  extracted_name VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_visit TIMESTAMPTZ DEFAULT NOW(),
  total_sessions INT DEFAULT 0,
  total_messages INT DEFAULT 0,
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_users_wechat_open_id ON users(wechat_open_id);
CREATE INDEX IF NOT EXISTS idx_users_last_visit ON users(last_visit);

-- 会话表
CREATE TABLE IF NOT EXISTS chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  message_count INT DEFAULT 0,
  is_active BOOLEAN DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id ON chat_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_started_at ON chat_sessions(started_at DESC);

-- 消息表
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_user_id ON chat_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at DESC);

-- 用户洞察表 (Memobase 备份)
CREATE TABLE IF NOT EXISTS user_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  insight_type VARCHAR(50) NOT NULL,
  topic VARCHAR(100),
  content TEXT NOT NULL,
  confidence FLOAT DEFAULT 0.8,
  source_message_id UUID REFERENCES chat_messages(id),
  extracted_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_user_insights_user_id ON user_insights(user_id);
CREATE INDEX IF NOT EXISTS idx_user_insights_type ON user_insights(insight_type);

-- 启用 Row Level Security (可选，根据需要配置)
-- ALTER TABLE users ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE user_insights ENABLE ROW LEVEL SECURITY;

-- 创建获取最近聊天历史的函数
CREATE OR REPLACE FUNCTION get_recent_chat_history(
  p_user_id UUID,
  p_limit INT DEFAULT 10
)
RETURNS TABLE (
  role VARCHAR(20),
  content TEXT,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.role, m.content, m.created_at
  FROM chat_messages m
  WHERE m.user_id = p_user_id
  ORDER BY m.created_at DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- 创建用户连接时的 upsert 函数
CREATE OR REPLACE FUNCTION upsert_user_on_connect(
  p_wechat_open_id VARCHAR,
  p_nickname VARCHAR DEFAULT NULL
)
RETURNS users AS $$
DECLARE
  v_user users;
BEGIN
  INSERT INTO users (wechat_open_id, nickname, last_visit, total_sessions)
  VALUES (p_wechat_open_id, p_nickname, NOW(), 1)
  ON CONFLICT (wechat_open_id) DO UPDATE SET
    last_visit = NOW(),
    nickname = COALESCE(EXCLUDED.nickname, users.nickname),
    total_sessions = users.total_sessions + 1
  RETURNING * INTO v_user;

  RETURN v_user;
END;
$$ LANGUAGE plpgsql;
