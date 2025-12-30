# Azure Blob Storage 图片存储配置指南

本文档介绍如何配置 Azure Blob Storage 用于存储用户上传的图片。

## 为什么使用 Azure Blob Storage?

1. **成本低廉**：专为大文件存储设计，比数据库存储便宜得多
2. **可扩展性强**：支持海量图片存储，无需担心容量问题
3. **Azure 生态集成**：与 Azure OpenAI 服务无缝集成
4. **CDN 支持**：可配置 CDN 加速图片访问

## 配置步骤

### 1. 创建 Azure Storage Account

1. 登录 [Azure Portal](https://portal.azure.com)
2. 搜索 "Storage accounts" 并点击创建
3. 填写基本信息：
   - **订阅**：选择你的订阅
   - **资源组**：选择现有资源组或创建新的
   - **存储账户名称**：例如 `jianjunaistorage`（必须全局唯一）
   - **区域**：选择与你的应用服务相同的区域（减少延迟）
   - **性能**：标准（Standard）
   - **冗余**：LRS（本地冗余存储）即可

4. 点击 "审阅 + 创建" → "创建"

### 2. 获取连接字符串

1. 创建完成后，进入 Storage Account
2. 左侧菜单选择 **访问密钥（Access keys）**
3. 复制 **连接字符串（Connection string）**
   - 格式类似：`DefaultEndpointsProtocol=https;AccountName=xxx;AccountKey=xxx;EndpointSuffix=core.windows.net`

### 3. 配置环境变量

在 `.env` 文件中添加：

```bash
# Azure Blob Storage 配置
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=xxx;AccountKey=xxx;EndpointSuffix=core.windows.net
```

### 4. Azure App Service 配置

如果部署到 Azure App Service：

1. 进入你的 App Service
2. 左侧菜单选择 **配置（Configuration）**
3. 点击 **新建应用程序设置**
4. 添加：
   - **名称**：`AZURE_STORAGE_CONNECTION_STRING`
   - **值**：粘贴你的连接字符串
5. 点击 **确定** → **保存**

## 工作原理

### 图片上传流程

```
用户上传图片 (前端)
       ↓
  base64 编码 → WebSocket
       ↓
后端接收 → 转换为 Buffer
       ↓
上传到 Azure Blob Storage
       ↓
获得永久 URL
       ↓
发送给 GPT-5.2 Vision API 分析
       ↓
保存图片 URL + AI 分析结果到 Supabase
       ↓
AI 分析结果 → Memobase 记忆系统
```

### 数据存储结构

1. **Azure Blob Storage**：
   - 容器名称：`user-images`
   - Blob 路径格式：`{userId}/{timestamp}_{randomId}.jpg`
   - 示例：`user_abc123/1735567890123_a1b2c3d4.jpg`

2. **Supabase `chat_messages` 表**：
   ```json
   {
     "content": "请帮我看看这些部位适合做什么项目",
     "metadata": {
       "images": [
         {
           "url": "https://jianjunaistorage.blob.core.windows.net/user-images/user_abc/...",
           "blobName": "user_abc123/1735567890123_a1b2c3d4.jpg",
           "size": 245678,
           "containerName": "user-images"
         }
       ],
       "imageAnalysis": "根据您上传的照片，我建议..."
     }
   }
   ```

3. **Memobase 记忆**：
   - 存储格式化的图片分析摘要
   - 示例：`【图片分析】用户上传了2张图片，AI分析结果：根据您上传的照片...`

## 安全配置

### 访问级别

默认容器访问级别：**Blob（匿名读取 Blob）**

- ✅ 图片可以通过 URL 直接访问（适合前端显示）
- ❌ 无法列出容器中的所有文件（保护隐私）

如需更高安全性，可以：
1. 设置为 **Private**
2. 使用 **Shared Access Signature (SAS)** 生成临时 URL

### 成本优化

1. **生命周期管理**：自动删除旧图片
   - 进入 Storage Account → 生命周期管理
   - 创建规则：删除超过 90 天的 blob

2. **访问层级**：
   - 热（Hot）：频繁访问，成本较高（默认）
   - 冷（Cool）：不常访问，存储成本低 50%
   - 存档（Archive）：极少访问，成本最低（需提前解冻）

## 数据库 Migration

运行 Supabase migration 添加图片支持：

```bash
# 连接到你的 Supabase 数据库
psql "postgresql://..."

# 执行 migration
\i backend/docs/migrations/003_add_image_support.sql
```

Migration 内容包括：
- 为 `chat_messages.metadata` 添加注释说明图片数据结构
- 创建索引优化图片查询
- 添加辅助函数：`get_user_image_count()`, `get_user_recent_images()`

## 测试

### 验证 Azure Blob Storage

```bash
# 1. 启动后端服务
cd backend
npm start

# 2. 查看日志，应该看到：
# ✅ Azure Blob Storage 初始化完成
```

### 前端测试

1. 打开微信小程序
2. 点击图片上传按钮
3. 选择图片
4. 查看后端日志：
   ```
   [req_xxx] ✅ 2 张图片已上传到 Azure Blob Storage
   [req_xxx] ✅ 图片信息已保存到 Supabase
   ```

### 查看 Azure Portal

1. 进入 Storage Account
2. 左侧菜单选择 **容器（Containers）**
3. 点击 `user-images`
4. 应该能看到上传的图片文件

## 常见问题

### Q1: 图片上传失败，显示 "service not available"

**原因**：未配置 `AZURE_STORAGE_CONNECTION_STRING` 环境变量

**解决**：检查 `.env` 文件或 Azure App Service 配置

### Q2: 图片上传成功但前端无法显示

**原因**：容器访问级别设置为 Private

**解决**：
1. 进入 Storage Account → 容器 → `user-images`
2. 点击 **更改访问级别**
3. 选择 **Blob（匿名读取 Blob）**

### Q3: 成本控制

**建议**：
- 使用生命周期管理自动删除旧图片
- 考虑使用 Cool 或 Archive 层级（非活跃图片）
- 启用 CDN 减少重复下载

## 相关文档

- [Azure Blob Storage 文档](https://docs.microsoft.com/azure/storage/blobs/)
- [Azure Storage 定价](https://azure.microsoft.com/pricing/details/storage/blobs/)
- [Supabase Schema 文档](./supabase-schema.sql)
- [Memobase 集成文档](./memobase-integration.md)
