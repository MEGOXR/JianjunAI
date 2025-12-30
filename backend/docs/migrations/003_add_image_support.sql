-- Migration: 添加图片支持
-- 描述: 为 chat_messages 添加图片元数据支持，用于存储 Azure Blob Storage 图片 URL

-- chat_messages 表的 metadata 字段已经是 JSONB 类型，可以直接存储图片信息
-- 本次 migration 主要添加索引和注释，优化图片相关查询

-- 添加注释说明 metadata 字段的图片数据结构
COMMENT ON COLUMN chat_messages.metadata IS
'消息元数据，支持以下结构:
{
  "images": [
    {
      "url": "https://storage.azure.com/...",
      "blobName": "user_xxx/timestamp_id.jpg",
      "size": 102400,
      "containerName": "user-images"
    }
  ],
  "imageAnalysis": "AI 对图片的分析结果文本"
}';

-- 创建索引，优化包含图片的消息查询
CREATE INDEX IF NOT EXISTS idx_messages_with_images
ON chat_messages ((metadata->'images'))
WHERE metadata ? 'images';

-- 创建索引，优化按用户查询图片消息
CREATE INDEX IF NOT EXISTS idx_user_image_messages
ON chat_messages (user_id, created_at DESC)
WHERE metadata ? 'images';

-- 添加辅助函数：统计用户上传的图片总数
CREATE OR REPLACE FUNCTION get_user_image_count(p_user_id UUID)
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*)
  INTO v_count
  FROM chat_messages
  WHERE user_id = p_user_id
    AND metadata ? 'images'
    AND role = 'user';

  RETURN COALESCE(v_count, 0);
END;
$$ LANGUAGE plpgsql;

-- 添加辅助函数：获取用户最近上传的图片
CREATE OR REPLACE FUNCTION get_user_recent_images(
  p_user_id UUID,
  p_limit INTEGER DEFAULT 10
)
RETURNS TABLE (
  message_id UUID,
  image_urls TEXT[],
  created_at TIMESTAMPTZ,
  image_analysis TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    cm.id,
    ARRAY(
      SELECT jsonb_array_elements(cm.metadata->'images')->>'url'
    ) AS image_urls,
    cm.created_at,
    cm.metadata->>'imageAnalysis' AS image_analysis
  FROM chat_messages cm
  WHERE cm.user_id = p_user_id
    AND cm.metadata ? 'images'
    AND cm.role = 'user'
  ORDER BY cm.created_at DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- 添加注释
COMMENT ON FUNCTION get_user_image_count IS '统计用户上传的图片消息总数';
COMMENT ON FUNCTION get_user_recent_images IS '获取用户最近上传的图片及 AI 分析结果';
