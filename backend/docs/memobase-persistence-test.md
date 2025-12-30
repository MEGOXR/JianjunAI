# Memobase 用户 ID 持久化功能测试

## 功能说明

本次更新实现了 Memobase 用户 ID 的持久化存储，确保同一个微信用户在服务器重启后仍然对应同一个 Memobase 用户。

## 部署步骤

### 1. 执行 Supabase 数据库迁移

在 Supabase Dashboard 的 SQL Editor 中执行迁移脚本：

```bash
backend/docs/migrations/add-memobase-user-id.sql
```

或者手动执行以下 SQL：

```sql
-- 添加 memobase_user_id 列
ALTER TABLE users
ADD COLUMN IF NOT EXISTS memobase_user_id VARCHAR(100) UNIQUE;

-- 添加索引
CREATE INDEX IF NOT EXISTS idx_users_memobase_user_id ON users(memobase_user_id);

-- 添加注释
COMMENT ON COLUMN users.memobase_user_id IS 'Memobase 用户 UUID，用于持久化微信用户与 Memobase 用户的映射关系';
```

### 2. 重启后端服务

```bash
cd backend
npm start
```

## 测试计划

### 测试场景 1: 新用户创建

**目的**: 验证新用户连接时能正确创建 Memobase 用户并持久化映射

**步骤**:
1. 使用新的微信用户（例如 `user_test_001`）连接系统
2. 观察后端日志，应该看到:
   ```
   [Memobase] 创建新用户 user_test_001 -> <UUID>
   [Memobase] 新用户已持久化: user_test_001 -> <UUID>
   [Supabase] Memobase 用户 ID 已保存: user_test_001 -> <UUID>
   ```
3. 在 Supabase Dashboard 查询 `users` 表:
   ```sql
   SELECT wechat_open_id, memobase_user_id
   FROM users
   WHERE wechat_open_id = 'user_test_001';
   ```
4. 验证 `memobase_user_id` 字段已正确保存

**预期结果**: ✅ 数据库中正确保存了映射关系

---

### 测试场景 2: 用户重连（不重启服务器）

**目的**: 验证内存缓存是否正常工作

**步骤**:
1. 使用同一用户（`user_test_001`）断开连接
2. 再次连接系统
3. 观察后端日志，应该看到:
   ```
   [Memobase] 用户 user_test_001 已加载
   ```
   应该**不会**看到 "创建新用户"

**预期结果**: ✅ 使用缓存，不会重复创建

---

### 测试场景 3: 服务器重启后用户重连（核心测试）

**目的**: 验证持久化是否有效，服务器重启后能否恢复映射

**步骤**:
1. 记录当前用户的 Memobase UUID:
   ```sql
   SELECT wechat_open_id, memobase_user_id
   FROM users
   WHERE wechat_open_id = 'user_test_001';
   ```
   例如: `user_test_001` -> `bd4e377f-db2b-4dbc-9ca2-21208d4d6e68`

2. **重启后端服务**:
   ```bash
   # 停止服务
   Ctrl+C

   # 启动服务
   npm start
   ```

3. 使用同一用户（`user_test_001`）连接系统

4. 观察后端日志，应该看到:
   ```
   [Memobase] 从 Supabase 加载映射: user_test_001 -> bd4e377f-db2b-4dbc-9ca2-21208d4d6e68
   [Memobase] 用户 user_test_001 已加载
   ```
   应该**不会**看到 "创建新用户"

5. 再次查询数据库，验证 UUID 没有变化:
   ```sql
   SELECT wechat_open_id, memobase_user_id
   FROM users
   WHERE wechat_open_id = 'user_test_001';
   ```

**预期结果**: ✅ UUID 保持不变，说明持久化成功

---

### 测试场景 4: 检查 Memobase 后台

**目的**: 验证 Memobase 后台不再产生重复用户

**步骤**:
1. 登录 Memobase 后台: https://console.memobase.io
2. 进入 **Users** 页面
3. 使用相同的微信用户多次连接、重启服务器
4. 观察用户列表

**预期结果**:
- ✅ **之前**: 每次重启会产生新的 UUID，用户列表不断增长
- ✅ **现在**: 同一微信用户始终对应同一个 UUID，不会产生重复

---

## 验证检查清单

- [ ] Supabase 数据库迁移已执行
- [ ] `users` 表包含 `memobase_user_id` 字段
- [ ] 新用户连接时能正确创建并保存映射
- [ ] 用户重连时能从缓存加载（不创建新用户）
- [ ] **服务器重启后能从 Supabase 恢复映射**（核心功能）
- [ ] Memobase 后台不再产生重复用户

---

## 故障排查

### 问题 1: 看到 "Supabase 不可用，映射未持久化"

**原因**: Supabase 配置缺失或初始化失败

**解决**:
1. 检查 `.env` 文件是否包含:
   ```
   SUPABASE_URL=your-supabase-url
   SUPABASE_ANON_KEY=your-supabase-anon-key
   ```
2. 检查 Supabase 服务是否正常初始化:
   ```
   [Supabase] 客户端初始化成功
   ```

### 问题 2: 仍然在创建重复用户

**原因**: 可能是数据库迁移未执行或 Supabase 查询失败

**解决**:
1. 验证数据库字段是否存在:
   ```sql
   SELECT column_name, data_type
   FROM information_schema.columns
   WHERE table_name = 'users' AND column_name = 'memobase_user_id';
   ```
2. 检查后端日志是否有 Supabase 错误
3. 查看 `backend/src/services/supabaseService.js` 的日志输出

### 问题 3: 数据库查询错误

**原因**: RLS（Row Level Security）策略可能阻止访问

**解决**:
在 Supabase Dashboard 的 SQL Editor 中临时禁用 RLS（仅用于测试）:
```sql
ALTER TABLE users DISABLE ROW LEVEL SECURITY;
```

---

## 技术架构

### 之前的架构（问题）

```
微信用户 -> 内存 Map -> Memobase UUID
                ↓
          重启后丢失 ❌
```

### 现在的架构（已修复）

```
微信用户 -> Supabase 持久化 -> Memobase UUID
              ↓                    ↑
         内存缓存（性能优化）-------+
```

**关键改进**:
- ✅ 使用 Supabase `users.memobase_user_id` 字段持久化映射
- ✅ 内存缓存仅用于性能优化，不作为唯一数据源
- ✅ 服务器重启后从 Supabase 恢复映射关系
