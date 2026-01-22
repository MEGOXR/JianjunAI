# 记忆系统优化改进报告

> 生成日期: 2026-01-08
> 项目: JianjunAI 医疗咨询应用

## 目录
1. [当前实现分析](#1-当前实现分析)
2. [性能瓶颈分析](#2-性能瓶颈分析)
3. [业界最佳实践](#3-业界最佳实践)
4. [推荐优化方案](#4-推荐优化方案)
5. [数据库设计](#5-数据库设计)
6. [实现细节](#6-实现细节)
7. [迁移策略](#7-迁移策略)
8. [预期效果](#8-预期效果)
9. [参考资料](#9-参考资料)
10. [架构重构方案](#10-架构重构方案tool-router--parallel-executor)

---

## 1. 当前实现分析

### 1.1 数据流程

当用户问"昨天发生什么"时，当前系统执行以下流程：

```
用户: "昨天我们聊了什么?"
        ↓
┌───────────────────────────────────────────┐
│ 第一轮 LLM 调用 (~1-2秒)                  │
│ - 识别用户意图                            │
│ - 生成 [SEARCH: {...}] 标记               │
└───────────────────────────────────────────┘
        ↓
┌───────────────────────────────────────────┐
│ 实时数据库查询 (~100-300ms)               │
│ - 解析搜索参数                            │
│ - Supabase 全文搜索 + 时间范围过滤        │
│ - 返回原始聊天记录                        │
└───────────────────────────────────────────┘
        ↓
┌───────────────────────────────────────────┐
│ 第二轮 LLM 调用 (~1-2秒)                  │
│ - 总结搜索结果                            │
│ - 生成自然语言回复                        │
└───────────────────────────────────────────┘
        ↓
用户收到回复 (总耗时: 2-4秒)
```

### 1.2 关键代码位置

| 功能 | 文件 | 行号 |
|------|------|------|
| 搜索意图检测 | `chatController.js` | 375-655 |
| 搜索执行 | `memoryService.js` | 274-324 |
| Supabase 查询 | `supabaseService.js` | 374-432 |
| Memobase 搜索 | `memobaseService.js` | 449-505 |

### 1.3 存储架构现状

| 存储层 | 用途 | 内容 | 访问延迟 |
|--------|------|------|----------|
| 内存 Map | 会话缓存 | 最近31条消息 | <1ms |
| Supabase | 持久化 | 完整聊天记录 | 50-300ms |
| Memobase | 用户画像 | 语义提取的用户特征 | 50-100ms |
| 本地 JSON | 备份 | 历史记录 (deprecated) | 10-50ms |

---

## 2. 性能瓶颈分析

### 2.1 主要瓶颈

| 瓶颈 | 影响 | 严重程度 |
|------|------|----------|
| **两轮 LLM 调用** | 每次历史查询需要 2-4 秒 | 高 |
| **无预计算总结** | 每次都需要实时查询 + 总结 | 高 |
| **搜索标记解析** | 依赖 LLM 生成格式正确的 [SEARCH] | 中 |
| **数据库网络延迟** | Supabase 在云端，RTT ~100ms | 中 |

### 2.2 延迟分解

```
典型历史查询延迟分解 (总计 ~3秒):

┌──────────────────────────────────────────────────────────┐
│ 第一轮 LLM (意图识别)        ████████████  1200ms (40%)  │
│ 数据库查询                    ██            200ms  (7%)  │
│ 第二轮 LLM (总结+回复)       ████████████  1400ms (47%)  │
│ 其他 (解析/格式化)            ██            200ms  (6%)  │
└──────────────────────────────────────────────────────────┘
```

### 2.3 问题场景

1. **频繁历史查询**：用户多次问"之前说过什么"，每次都重复完整流程
2. **简单问题复杂化**："昨天聊什么" 这种简单问题却需要 3 秒响应
3. **资源浪费**：每次都用 LLM 总结相同的历史记录

---

## 3. 业界最佳实践

### 3.1 分层记忆架构 (Hierarchical Memory)

业界领先的 AI 记忆系统采用分层架构，平衡响应速度和信息完整性：

```
┌─────────────────────────────────────────────────────┐
│  L1: 会话内记忆 (Session Memory)                   │
│  - 存储：内存                                       │
│  - 内容：当前对话的完整消息                         │
│  - 延迟：<1ms                                       │
│  - 保留期：会话结束后清除                           │
└─────────────────────────────────────────────────────┘
                    ↓ 会话结束触发
┌─────────────────────────────────────────────────────┐
│  L2: 会话总结 (Session Summary)                    │
│  - 存储：数据库                                     │
│  - 内容：每次会话的要点 (100-200字)                │
│  - 延迟：~50ms                                      │
│  - 保留期：永久                                     │
└─────────────────────────────────────────────────────┘
                    ↓ 每日聚合
┌─────────────────────────────────────────────────────┐
│  L3: 每日总结 (Daily Summary)                      │
│  - 存储：数据库                                     │
│  - 内容：当天所有会话的合并摘要 (200-400字)        │
│  - 延迟：~50ms                                      │
│  - 保留期：永久                                     │
└─────────────────────────────────────────────────────┘
                    ↓ 持续更新
┌─────────────────────────────────────────────────────┐
│  L4: 用户画像 (User Profile)                       │
│  - 存储：向量数据库 (Memobase)                     │
│  - 内容：长期偏好、特征、关注点                    │
│  - 延迟：~100ms (语义搜索)                         │
│  - 保留期：永久，动态更新                          │
└─────────────────────────────────────────────────────┘
```

### 3.2 递归总结 (Recursive Summarization)

来自 [arXiv:2308.15022](https://arxiv.org/abs/2308.15022) 的研究：

```
原始对话 (10000 tokens)
    ↓ 分段总结
段落总结 (2000 tokens)
    ↓ 合并总结
会话总结 (400 tokens)
    ↓ 每日聚合
每日总结 (200 tokens)
```

**效果**：压缩比 50:1，同时保留 95% 关键信息

### 3.3 Memory Bank 方法

将记忆分为四个维度：

| 维度 | 内容 | 示例 |
|------|------|------|
| Situation | 事件日志 | "2026-01-07 咨询双眼皮手术" |
| Background | 递归总结 | "用户对微创手术感兴趣" |
| Topic-Outline | 需求偏好 | "希望自然效果，预算 2-3 万" |
| Principle | 行为模式 | "每次对话都会问恢复期" |

### 3.4 业界产品对比

| 产品 | 方案 | 效果 |
|------|------|------|
| **Mem0** | 智能记忆 + 分层存储 | Token 成本降低 90%，准确率提升 26% |
| **Memobase** | Profile + Event Timeline | 延迟 <100ms，LOCOMO 准确率 75.78% |
| **MemGPT** | 类 OS 内存管理 | 无限上下文错觉 |
| **LangMem** | 行为学习 + 提示词进化 | 持续自我优化 |

---

## 4. 推荐优化方案

### 4.1 方案概述：预计算分层总结

核心思想：**将"实时总结"改为"预计算 + 直接查询"**

```
优化后流程:

用户: "昨天我们聊了什么?"
        ↓
┌───────────────────────────────────────────┐
│ 意图识别 (简单规则匹配)    ~10ms          │
│ - 检测时间关键词: 昨天/前天/上周          │
│ - 无需 LLM 调用                           │
└───────────────────────────────────────────┘
        ↓
┌───────────────────────────────────────────┐
│ 查询预计算总结              ~50ms          │
│ - 直接读取 daily_summaries 表             │
│ - SQL: WHERE date = '2026-01-07'          │
└───────────────────────────────────────────┘
        ↓
┌───────────────────────────────────────────┐
│ 单轮 LLM 调用              ~1-1.5秒        │
│ - 输入: 用户问题 + 预计算总结             │
│ - 输出: 自然语言回复                      │
└───────────────────────────────────────────┘
        ↓
用户收到回复 (总耗时: 1-1.5秒, 提速 60%)
```

### 4.2 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                     写入路径 (异步)                         │
└─────────────────────────────────────────────────────────────┘

用户断开连接
    ↓
SessionSummaryService.generateSessionSummary()
    ↓
┌──────────────────────────────────────────┐
│ 调用 LLM 生成会话总结                    │
│ - 输入: 本次会话完整消息                 │
│ - 输出: 100-200 字结构化摘要             │
│ - 提示词: 提取关键信息、用户需求、结论   │
└──────────────────────────────────────────┘
    ↓
存入 Supabase: chat_sessions.summary
    ↓
每日 00:30 定时任务
    ↓
DailySummaryService.generateDailySummary()
    ↓
┌──────────────────────────────────────────┐
│ 聚合当天所有会话总结                     │
│ - 输入: 当天所有 session.summary         │
│ - 输出: 200-400 字每日总结               │
│ - 提示词: 合并去重、保留重点             │
└──────────────────────────────────────────┘
    ↓
存入 Supabase: daily_summaries


┌─────────────────────────────────────────────────────────────┐
│                     读取路径 (同步)                         │
└─────────────────────────────────────────────────────────────┘

用户问 "昨天聊了什么"
    ↓
TimeQueryDetector.detect(message)
    ↓ 匹配成功
┌──────────────────────────────────────────┐
│ 1. 计算目标日期                          │
│    - "昨天" → 2026-01-07                 │
│    - "前天" → 2026-01-06                 │
│    - "上周" → 2026-01-01 ~ 2026-01-07    │
└──────────────────────────────────────────┘
    ↓
┌──────────────────────────────────────────┐
│ 2. 查询 daily_summaries                  │
│    SELECT summary FROM daily_summaries   │
│    WHERE user_id = ? AND date = ?        │
└──────────────────────────────────────────┘
    ↓
┌──────────────────────────────────────────┐
│ 3. 构建上下文，单轮 LLM 调用             │
│    系统提示: "用户问昨天的对话，         │
│    以下是预先总结的内容: {summary}"      │
└──────────────────────────────────────────┘
    ↓
返回自然语言回复
```

### 4.3 存储选择决策

| 存储类型 | 使用场景 | 推荐存储 |
|----------|----------|----------|
| 会话总结 | 结构化时间查询 | **Supabase** |
| 每日总结 | 结构化时间查询 | **Supabase** |
| 用户画像 | 语义查询 | **Memobase** (保持现状) |
| 原始记录 | 精确回溯 | **Supabase** (保持现状) |

**选择 Supabase 的原因**：
1. 时间维度查询（"昨天"）用 SQL 更精确、更快
2. 项目已有 Supabase 基础设施
3. 避免引入额外复杂度

---

## 5. 数据库设计

### 5.1 修改现有表: chat_sessions

```sql
-- 添加 summary 列到 chat_sessions 表
ALTER TABLE chat_sessions
ADD COLUMN IF NOT EXISTS summary TEXT,
ADD COLUMN IF NOT EXISTS summary_generated_at TIMESTAMPTZ;

-- 添加索引
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_date
ON chat_sessions(user_id, DATE(started_at));
```

### 5.2 时区处理方案

**问题**：服务器在美国/韩国，用户主要在中国，需要按用户本地时间区分"昨天"。

**解决方案**：

1. **用户表添加时区字段**
```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) DEFAULT 'Asia/Shanghai';
```

2. **每日总结按用户时区存储**
```sql
-- date 字段存储的是用户本地日期，不是 UTC 日期
-- 查询时根据用户时区转换
```

3. **前端传递时区**
```javascript
// 微信小程序获取系统时区偏移
const timezoneOffset = new Date().getTimezoneOffset(); // 分钟
// 中国时区: -480 (UTC+8)
```

4. **默认时区策略**
- 新用户默认 `Asia/Shanghai`（中国）
- 可通过微信小程序自动检测并更新

### 5.3 新建表: daily_summaries

```sql
CREATE TABLE IF NOT EXISTS daily_summaries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date DATE NOT NULL,  -- 用户本地日期
    timezone VARCHAR(50) DEFAULT 'Asia/Shanghai',  -- 生成时的时区
    summary TEXT NOT NULL,
    session_count INTEGER DEFAULT 0,
    message_count INTEGER DEFAULT 0,
    key_topics JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(user_id, date)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_daily_summaries_user_date
ON daily_summaries(user_id, date DESC);

-- 自动更新时间戳
CREATE OR REPLACE FUNCTION update_daily_summaries_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER daily_summaries_updated
    BEFORE UPDATE ON daily_summaries
    FOR EACH ROW
    EXECUTE FUNCTION update_daily_summaries_timestamp();
```

### 5.4 数据示例

```json
// daily_summaries 记录示例
{
  "id": "uuid-xxx",
  "user_id": "uuid-user",
  "date": "2026-01-07",
  "timezone": "Asia/Shanghai",
  "summary": "用户咨询了双眼皮手术相关问题，主要关注：1) 全切与埋线的区别；2) 恢复期时长；3) 价格区间（预算2-3万）。用户表示希望效果自然，不想被看出来做过手术。还询问了术后注意事项和复诊安排。",
  "session_count": 2,
  "message_count": 15,
  "key_topics": ["双眼皮", "恢复期", "价格", "自然效果"],
  "created_at": "2026-01-08T00:30:00Z"
}
```

---

## 6. 实现细节

### 6.1 新增服务文件

#### 6.1.1 `backend/src/services/sessionSummaryService.js`

```javascript
/**
 * 会话总结服务
 * 在用户断开连接时异步生成会话摘要
 */
const { openai } = require('./azureOpenAIService');
const supabaseService = require('./supabaseService');

const SESSION_SUMMARY_PROMPT = `你是一个医疗咨询助手的记忆管理员。
请根据以下对话内容，生成一个简洁的会话摘要。

要求：
1. 100-200字以内
2. 提取用户的主要问题和关注点
3. 记录达成的结论或建议
4. 使用第三人称描述（"用户"而非"你"）
5. 保留关键的医疗信息（项目名称、预算、顾虑等）

对话内容:
{conversation}

请输出摘要（仅输出摘要内容，不要其他格式）:`;

async function generateSessionSummary(sessionId, messages) {
    // 过滤系统消息，只保留用户和助手对话
    const conversation = messages
        .filter(m => m.role !== 'system')
        .map(m => `${m.role === 'user' ? '用户' : '杨院长'}: ${m.content}`)
        .join('\n');

    if (conversation.length < 50) {
        return null; // 对话太短，不生成摘要
    }

    try {
        const response = await openai.chat.completions.create({
            model: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
            messages: [
                { role: 'user', content: SESSION_SUMMARY_PROMPT.replace('{conversation}', conversation) }
            ],
            max_completion_tokens: 300,
            temperature: 0.3
        });

        const summary = response.choices[0].message.content.trim();

        // 保存到数据库
        await supabaseService.updateSessionSummary(sessionId, summary);

        return summary;
    } catch (error) {
        console.error('生成会话摘要失败:', error);
        return null;
    }
}

module.exports = { generateSessionSummary };
```

#### 6.1.2 `backend/src/services/dailySummaryService.js`

```javascript
/**
 * 每日总结服务
 * 聚合当天所有会话的摘要
 */
const { openai } = require('./azureOpenAIService');
const supabaseService = require('./supabaseService');

const DAILY_SUMMARY_PROMPT = `你是一个医疗咨询助手的记忆管理员。
请将以下多个会话摘要合并成一个简洁的每日总结。

要求：
1. 200-400字以内
2. 合并相同主题，去除重复信息
3. 保留所有关键的医疗信息
4. 按重要性排序
5. 提取3-5个关键话题标签

会话摘要列表:
{summaries}

请按以下JSON格式输出:
{
  "summary": "每日总结内容...",
  "key_topics": ["话题1", "话题2", ...]
}`;

async function generateDailySummary(userId, date) {
    // 获取当天所有会话摘要
    const sessions = await supabaseService.getSessionSummariesByDate(userId, date);

    if (sessions.length === 0) {
        return null;
    }

    // 如果只有一个会话，直接使用其摘要
    if (sessions.length === 1 && sessions[0].summary) {
        const result = {
            summary: sessions[0].summary,
            key_topics: [],
            session_count: 1,
            message_count: sessions[0].message_count || 0
        };
        await supabaseService.saveDailySummary(userId, date, result);
        return result;
    }

    // 合并多个会话摘要
    const summariesText = sessions
        .filter(s => s.summary)
        .map((s, i) => `会话${i + 1}: ${s.summary}`)
        .join('\n\n');

    try {
        const response = await openai.chat.completions.create({
            model: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
            messages: [
                { role: 'user', content: DAILY_SUMMARY_PROMPT.replace('{summaries}', summariesText) }
            ],
            max_completion_tokens: 500,
            temperature: 0.3,
            response_format: { type: 'json_object' }
        });

        const result = JSON.parse(response.choices[0].message.content);
        result.session_count = sessions.length;
        result.message_count = sessions.reduce((sum, s) => sum + (s.message_count || 0), 0);

        await supabaseService.saveDailySummary(userId, date, result);

        return result;
    } catch (error) {
        console.error('生成每日总结失败:', error);
        return null;
    }
}

// 懒加载：查询时如果没有预计算，则现场生成
async function getDailySummary(userId, date) {
    // 先尝试从缓存获取
    let summary = await supabaseService.getDailySummary(userId, date);

    if (!summary) {
        // 懒加载生成
        summary = await generateDailySummary(userId, date);
    }

    return summary;
}

module.exports = { generateDailySummary, getDailySummary };
```

#### 6.1.3 `backend/src/services/timeQueryDetector.js`

```javascript
/**
 * 时间查询检测器
 * 无需 LLM，使用规则匹配识别时间相关查询
 * 支持用户时区处理
 */

const TIME_PATTERNS = [
    { pattern: /昨天|昨日/, offset: -1, type: 'day' },
    { pattern: /前天/, offset: -2, type: 'day' },
    { pattern: /大前天/, offset: -3, type: 'day' },
    { pattern: /今天|今日/, offset: 0, type: 'day' },
    { pattern: /上周/, offset: -7, type: 'week' },
    { pattern: /上个月|上月/, offset: -30, type: 'month' },
    { pattern: /(\d+)天前/, type: 'days_ago' },
    { pattern: /(\d+)号|(\d+)日/, type: 'specific_day' },
];

const QUERY_KEYWORDS = [
    '聊了什么', '说了什么', '讨论了什么', '谈了什么',
    '发生什么', '发生了什么', '做了什么',
    '之前', '以前', '上次', '那时候'
];

/**
 * 获取用户本地时间
 * @param {string} timezone - 用户时区，如 'Asia/Shanghai'
 * @returns {Date} 用户本地时间
 */
function getUserLocalTime(timezone = 'Asia/Shanghai') {
    // 使用 Intl API 获取用户时区的当前时间
    const now = new Date();
    const options = {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    };

    // 格式化为 YYYY-MM-DD HH:mm:ss
    const formatter = new Intl.DateTimeFormat('en-CA', options);
    const parts = formatter.formatToParts(now);
    const dateStr = `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`;

    return new Date(dateStr + 'T00:00:00');
}

/**
 * 检测时间查询
 * @param {string} message - 用户消息
 * @param {string} timezone - 用户时区，默认 'Asia/Shanghai'
 * @returns {object|null} 时间查询信息
 */
function detect(message, timezone = 'Asia/Shanghai') {
    // 检查是否包含查询关键词
    const hasQueryKeyword = QUERY_KEYWORDS.some(kw => message.includes(kw));
    if (!hasQueryKeyword) {
        return null;
    }

    // 使用用户时区的"今天"
    const userToday = getUserLocalTime(timezone);

    for (const { pattern, offset, type } of TIME_PATTERNS) {
        const match = message.match(pattern);
        if (match) {
            let startDate, endDate;

            switch (type) {
                case 'day':
                    startDate = new Date(userToday);
                    startDate.setDate(startDate.getDate() + offset);
                    endDate = new Date(startDate);
                    break;

                case 'week':
                    endDate = new Date(userToday);
                    endDate.setDate(endDate.getDate() - 1);
                    startDate = new Date(endDate);
                    startDate.setDate(startDate.getDate() - 6);
                    break;

                case 'month':
                    endDate = new Date(userToday);
                    endDate.setDate(endDate.getDate() - 1);
                    startDate = new Date(endDate);
                    startDate.setMonth(startDate.getMonth() - 1);
                    break;

                case 'days_ago':
                    const daysAgo = parseInt(match[1]);
                    startDate = new Date(userToday);
                    startDate.setDate(startDate.getDate() - daysAgo);
                    endDate = new Date(startDate);
                    break;

                default:
                    continue;
            }

            return {
                type: 'time_query',
                startDate: startDate.toISOString().split('T')[0],
                endDate: endDate.toISOString().split('T')[0],
                originalMatch: match[0],
                timezone: timezone  // 记录使用的时区
            };
        }
    }

    return null;
}

module.exports = { detect, getUserLocalTime };
```

### 6.2 修改 chatController.js

在 `sendMessage` 函数中添加时间查询快速路径：

```javascript
// 在 sendMessage 函数开头添加
const timeQueryDetector = require('../services/timeQueryDetector');
const dailySummaryService = require('../services/dailySummaryService');

// 在处理消息之前添加快速路径
async function handleTimeQuery(userId, userMessage, ws, userTimezone) {
    const timeQuery = timeQueryDetector.detect(userMessage, userTimezone);
    if (!timeQuery) {
        return false; // 不是时间查询，走正常流程
    }

    console.log(`[TimeQuery] 检测到时间查询:`, timeQuery);

    // 获取预计算的每日总结
    const summaries = [];
    let currentDate = new Date(timeQuery.startDate);
    const endDate = new Date(timeQuery.endDate);

    while (currentDate <= endDate) {
        const dateStr = currentDate.toISOString().split('T')[0];
        const summary = await dailySummaryService.getDailySummary(userId, dateStr);
        if (summary) {
            summaries.push({ date: dateStr, ...summary });
        }
        currentDate.setDate(currentDate.getDate() + 1);
    }

    if (summaries.length === 0) {
        // 没有找到记录，返回友好提示
        const response = `我查了一下，${timeQuery.originalMatch}我们好像没有聊过天呢。您是想问点什么吗？`;
        ws.send(JSON.stringify({ data: response }));
        ws.send(JSON.stringify({ done: true }));
        return true;
    }

    // 构建上下文，单轮 LLM 调用
    const summaryContext = summaries
        .map(s => `【${s.date}】${s.summary}`)
        .join('\n\n');

    const systemPrompt = `你是杨院长，一位专业的医美咨询顾问。
用户正在询问之前的对话内容。以下是预先总结的历史记录：

${summaryContext}

请根据这些信息，用亲切自然的语气回答用户的问题。
如果用户问的是具体细节而总结中没有，可以告诉用户大概聊了什么，但细节可能需要回顾。`;

    // 单轮 LLM 调用
    const response = await openai.chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
        ],
        stream: true
    });

    for await (const chunk of response) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
            ws.send(JSON.stringify({ data: content }));
        }
    }

    ws.send(JSON.stringify({ done: true }));
    return true;
}

// 在 sendMessage 主函数中调用
async function sendMessage(ws, userId, userMessage, ...) {
    // 获取用户时区（从用户数据或默认）
    const userTimezone = userData?.timezone || 'Asia/Shanghai';

    // 快速路径：时间查询
    const handled = await handleTimeQuery(userId, userMessage, ws, userTimezone);
    if (handled) {
        return;
    }

    // ... 原有逻辑
}
```

### 6.3 会话结束时触发摘要生成

修改 `index.js` 中的 WebSocket 断开处理：

```javascript
const sessionSummaryService = require('./services/sessionSummaryService');

ws.on('close', async () => {
    console.log(`[WebSocket] 用户 ${userId} 断开连接`);

    // 异步生成会话摘要（不阻塞断开流程）
    const history = chatHistories.get(userId);
    if (history && history.messages.length > 2) {
        const sessionId = history.sessionId;
        sessionSummaryService.generateSessionSummary(sessionId, history.messages)
            .then(summary => {
                if (summary) {
                    console.log(`[SessionSummary] 用户 ${userId} 会话摘要已生成`);
                }
            })
            .catch(err => {
                console.error(`[SessionSummary] 生成失败:`, err);
            });
    }

    // ... 其他清理逻辑
});
```

### 6.4 定时任务：每日总结生成

创建 `backend/src/jobs/dailySummaryJob.js`：

```javascript
/**
 * 每日总结定时任务
 * 建议在 00:30 运行，确保当天数据完整
 */
const cron = require('node-cron');
const dailySummaryService = require('../services/dailySummaryService');
const supabaseService = require('../services/supabaseService');

async function runDailySummaryJob() {
    console.log('[DailySummaryJob] 开始执行每日总结任务');

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split('T')[0];

    try {
        // 获取所有有会话的用户
        const users = await supabaseService.getUsersWithSessionsOnDate(dateStr);

        console.log(`[DailySummaryJob] 找到 ${users.length} 个用户需要生成每日总结`);

        for (const user of users) {
            try {
                await dailySummaryService.generateDailySummary(user.id, dateStr);
                console.log(`[DailySummaryJob] 用户 ${user.id} 每日总结已生成`);
            } catch (err) {
                console.error(`[DailySummaryJob] 用户 ${user.id} 生成失败:`, err);
            }
        }

        console.log('[DailySummaryJob] 每日总结任务完成');
    } catch (error) {
        console.error('[DailySummaryJob] 任务执行失败:', error);
    }
}

// 每天 00:30 执行（按用户主要时区 Asia/Shanghai）
function startDailySummaryJob() {
    cron.schedule('30 0 * * *', runDailySummaryJob, {
        timezone: 'Asia/Shanghai'
    });
    console.log('[DailySummaryJob] 定时任务已启动，每天 00:30 (Asia/Shanghai) 执行');
}

module.exports = { startDailySummaryJob, runDailySummaryJob };
```

---

## 7. 迁移策略

### 7.1 阶段一：数据库准备（无风险）

```sql
-- 1. 添加用户时区字段
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) DEFAULT 'Asia/Shanghai';

-- 2. 添加会话摘要字段
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS summary_generated_at TIMESTAMPTZ;

-- 3. 创建每日总结表
CREATE TABLE IF NOT EXISTS daily_summaries (...);

-- 4. 创建索引
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_date ON chat_sessions(user_id, DATE(started_at));
CREATE INDEX IF NOT EXISTS idx_daily_summaries_user_date ON daily_summaries(user_id, date DESC);
```

### 7.2 阶段二：后台填充历史数据（可选）

```javascript
// 一次性脚本：为历史会话生成摘要
async function backfillSessionSummaries() {
    const sessions = await supabase
        .from('chat_sessions')
        .select('id, user_id')
        .is('summary', null)
        .limit(100);

    for (const session of sessions) {
        const messages = await supabase
            .from('chat_messages')
            .select('role, content')
            .eq('session_id', session.id)
            .order('created_at');

        if (messages.length > 2) {
            await sessionSummaryService.generateSessionSummary(session.id, messages);
        }
    }
}
```

### 7.3 阶段三：启用新功能

1. 部署新代码（带懒加载，无历史数据也能工作）
2. 新会话自动生成摘要
3. 时间查询走快速路径
4. 监控效果和错误

### 7.4 阶段四：优化和调整

1. 根据监控数据调整摘要长度
2. 优化提示词以提高摘要质量
3. 考虑添加更多时间模式识别

---

## 8. 预期效果

### 8.1 性能提升

| 场景 | 当前延迟 | 优化后延迟 | 提升 |
|------|---------|-----------|------|
| "昨天聊了什么" | 2-4秒 | 1-1.5秒 | **60-65%** |
| "上周聊了什么" | 3-5秒 | 1.5-2秒 | **50-60%** |
| "我之前说过..." | 2-4秒 | 1-1.5秒 | **60-65%** |
| 普通对话 | 不变 | 不变 | - |

### 8.2 资源消耗

| 指标 | 当前 | 优化后 | 变化 |
|------|------|--------|------|
| LLM 调用次数/历史查询 | 2次 | 1次 | **-50%** |
| Token 消耗/历史查询 | ~2000 | ~800 | **-60%** |
| 数据库查询延迟 | ~200ms | ~50ms | **-75%** |
| 额外存储 | 0 | ~500字/天/用户 | +少量 |

### 8.3 用户体验

- 历史查询响应更快
- 回答更准确（基于预先总结的关键信息）
- 减少"正在搜索..."的等待感
- 支持更多时间表达方式

---

## 9. 参考资料

### 9.1 学术论文

1. [Recursively Summarizing Enables Long-Term Dialogue Memory](https://arxiv.org/abs/2308.15022) - arXiv 2023
2. [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/abs/2504.19413) - arXiv 2025
3. [A Survey on the Memory Mechanism of Large Language Model-based Agents](https://dl.acm.org/doi/10.1145/3748302) - ACM TOIS 2025

### 9.2 业界实践

1. [Mem0 Chat History Summarization Guide](https://mem0.ai/blog/llm-chat-history-summarization-guide-2025)
2. [Memobase GitHub](https://github.com/memodb-io/memobase)
3. [Building Long-Term Memories using Hierarchical Summarization](https://pieces.app/blog/hierarchical-summarization)
4. [AI Agent with Multi-Session Memory](https://towardsdatascience.com/ai-agent-with-multi-session-memory/)

### 9.3 相关项目

1. [Agent Memory Paper List](https://github.com/Shichun-Liu/Agent-Memory-Paper-List)
2. [MemOS - Memory Operating System](https://github.com/MemTensor/MemOS)
3. [Letta Agent Memory](https://www.letta.com/blog/agent-memory)

---

## 附录 A：完整 SQL 脚本

```sql
-- backend/docs/migrations/002_add_summary_tables.sql

-- 1. 添加用户时区字段
ALTER TABLE users
ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) DEFAULT 'Asia/Shanghai';

-- 2. 添加会话摘要列
ALTER TABLE chat_sessions
ADD COLUMN IF NOT EXISTS summary TEXT,
ADD COLUMN IF NOT EXISTS summary_generated_at TIMESTAMPTZ;

-- 3. 创建每日总结表
CREATE TABLE IF NOT EXISTS daily_summaries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    timezone VARCHAR(50) DEFAULT 'Asia/Shanghai',
    summary TEXT NOT NULL,
    session_count INTEGER DEFAULT 0,
    message_count INTEGER DEFAULT 0,
    key_topics JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(user_id, date)
);

-- 4. 创建索引
CREATE INDEX IF NOT EXISTS idx_chat_sessions_summary
ON chat_sessions(user_id, started_at DESC)
WHERE summary IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_daily_summaries_user_date
ON daily_summaries(user_id, date DESC);

-- 5. 自动更新时间戳触发器
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER daily_summaries_updated_at
    BEFORE UPDATE ON daily_summaries
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 6. 创建获取用户某天会话摘要的函数
CREATE OR REPLACE FUNCTION get_session_summaries_by_date(
    p_user_id UUID,
    p_date DATE
)
RETURNS TABLE (
    session_id UUID,
    summary TEXT,
    message_count INTEGER,
    started_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        cs.id,
        cs.summary,
        cs.message_count,
        cs.started_at
    FROM chat_sessions cs
    WHERE cs.user_id = p_user_id
      AND DATE(cs.started_at AT TIME ZONE 'Asia/Shanghai') = p_date
      AND cs.summary IS NOT NULL
    ORDER BY cs.started_at;
END;
$$ LANGUAGE plpgsql;
```

---

## 10. 架构重构方案：Tool Router + Parallel Executor

### 10.1 当前架构问题

当前 `chatController.js` 存在以下架构问题：

| 问题 | 描述 | 影响 |
|------|------|------|
| **职责过重** | 单文件 ~800 行，承担工具检测、流处理、搜索执行等 | 难以维护和扩展 |
| **字符串解析检测** | 依赖 LLM 输出 `[SEARCH: {...}]` 格式 | 脆弱，格式错误则失败 |
| **串行工具执行** | 一次只能处理一个工具调用 | 多工具场景延迟高 |
| **无法并行** | 用户问"昨天聊什么+今天天气"需串行处理 | 用户体验差 |

### 10.2 目标架构

```
┌─────────────────────────────────────────────────────────────────┐
│                      MessageRouter                              │
│  接收用户消息，分发到不同处理器                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ↓                   ↓                   ↓
   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
   │ QuickRouter │     │ ToolRouter  │     │ DefaultChat │
   │ (规则匹配)  │     │(LLM决策)    │     │  (普通对话) │
   │   ~10ms     │     │  ~500ms     │     │             │
   └─────────────┘     └─────────────┘     └─────────────┘
          │                   │
          └───────┬───────────┘
                  ↓
   ┌─────────────────────────────────────────────────────────────┐
   │                    ToolExecutor                             │
   │  ┌──────────────────────────────────────────────────────┐   │
   │  │              Parallel Execution Layer                │   │
   │  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  │   │
   │  │  │History  │  │Weather  │  │Calendar │  │ ...     │  │   │
   │  │  │Searcher │  │Provider │  │Provider │  │         │  │   │
   │  │  └─────────┘  └─────────┘  └─────────┘  └─────────┘  │   │
   │  └──────────────────────────────────────────────────────┘   │
   └─────────────────────────────────────────────────────────────┘
                              │
                              ↓
   ┌─────────────────────────────────────────────────────────────┐
   │                  ResponseComposer                           │
   │  根据工具返回顺序，流式组装响应                              │
   │  谁先完成谁先输出，渐进式生成                                │
   └─────────────────────────────────────────────────────────────┘
```

### 10.3 核心组件设计

#### 10.3.1 ToolRouter - 工具路由器

```javascript
// backend/src/services/toolRouter.js

class ToolRouter {
  constructor() {
    this.tools = new Map();
    this.quickPatterns = []; // 快速规则匹配（无需LLM）
  }

  /**
   * 注册工具
   */
  register(name, config) {
    this.tools.set(name, {
      name,
      description: config.description,
      parameters: config.parameters,
      executor: config.executor,
      priority: config.priority || 0,
      quickMatch: config.quickMatch // 正则快速匹配
    });

    if (config.quickMatch) {
      this.quickPatterns.push({ pattern: config.quickMatch, tool: name });
    }
  }

  /**
   * 快速路径：规则匹配，无需 LLM (~10ms)
   * 可同时匹配多个工具
   */
  quickRoute(message) {
    const matches = [];
    for (const { pattern, tool } of this.quickPatterns) {
      if (pattern.test(message)) {
        matches.push(tool);
      }
    }
    return matches;
  }

  /**
   * 慢路径：让 LLM 决定需要哪些工具 (~500ms)
   * 使用 OpenAI Function Calling
   */
  async llmRoute(message, context) {
    const toolDefinitions = Array.from(this.tools.values()).map(t => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }));

    const response = await openai.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
      messages: [
        { role: "system", content: "分析用户意图，决定需要调用哪些工具。如果不需要工具，返回空。" },
        { role: "user", content: message }
      ],
      tools: toolDefinitions,
      parallel_tool_calls: true,  // 允许并行调用多个工具
      tool_choice: "auto"
    });

    return response.choices[0].message.tool_calls || [];
  }

  /**
   * 获取 OpenAI Function Calling 格式的工具定义
   */
  getToolDefinitions() {
    return Array.from(this.tools.values()).map(t => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }));
  }
}

module.exports = ToolRouter;
```

#### 10.3.2 ToolExecutor - 并行执行器

```javascript
// backend/src/services/toolExecutor.js

class ToolExecutor {
  constructor(toolRouter) {
    this.router = toolRouter;
  }

  /**
   * 并行执行多个工具，返回 AsyncGenerator
   * 谁先完成谁先 yield（最优延迟）
   */
  async *executeParallel(toolCalls, context) {
    if (toolCalls.length === 0) return;

    const pendingPromises = new Map();

    // 启动所有工具执行（并行）
    for (const call of toolCalls) {
      const tool = this.router.tools.get(call.function?.name || call.name);
      if (!tool) continue;

      const args = typeof call.function?.arguments === 'string'
        ? JSON.parse(call.function.arguments)
        : (call.arguments || {});

      const startTime = Date.now();
      const promise = tool.executor(args, context)
        .then(result => ({
          toolName: tool.name,
          result,
          id: call.id || `call_${Date.now()}`,
          duration: Date.now() - startTime
        }))
        .catch(error => ({
          toolName: tool.name,
          error: error.message,
          id: call.id || `call_${Date.now()}`,
          duration: Date.now() - startTime
        }));

      pendingPromises.set(call.id || tool.name, promise);
    }

    // 使用 Promise.race 获取最先完成的结果
    while (pendingPromises.size > 0) {
      const result = await Promise.race(pendingPromises.values());
      pendingPromises.delete(result.id);

      console.log(`[ToolExecutor] ${result.toolName} 完成，耗时 ${result.duration}ms`);
      yield result;
    }
  }

  /**
   * 按指定顺序执行（如果需要保证语义顺序）
   */
  async executeInOrder(toolCalls, context) {
    const results = [];
    for (const call of toolCalls) {
      const tool = this.router.tools.get(call.function?.name || call.name);
      if (!tool) continue;

      const args = typeof call.function?.arguments === 'string'
        ? JSON.parse(call.function.arguments)
        : (call.arguments || {});

      try {
        const result = await tool.executor(args, context);
        results.push({ toolName: tool.name, result });
      } catch (error) {
        results.push({ toolName: tool.name, error: error.message });
      }
    }
    return results;
  }
}

module.exports = ToolExecutor;
```

#### 10.3.3 ResponseComposer - 流式响应组装器

```javascript
// backend/src/services/responseComposer.js

class ResponseComposer {
  constructor(openaiClient) {
    this.openai = openaiClient;
  }

  /**
   * 流式组装响应
   * 工具结果按完成顺序注入，LLM 逐步生成
   */
  async *composeStream(userMessage, toolResultsGenerator, context, options = {}) {
    const { sendFiller = true } = options;
    let accumulatedContext = "";
    let isFirstResult = true;

    // 1. 先发送即时填充语（可选）
    if (sendFiller) {
      yield { type: "filler", content: "好的，让我帮你查一下..." };
    }

    // 2. 监听工具结果，逐个生成响应
    for await (const result of toolResultsGenerator) {
      if (result.error) {
        console.error(`[ResponseComposer] 工具 ${result.toolName} 失败:`, result.error);
        continue;
      }

      // 累积上下文
      const resultSummary = typeof result.result === 'object'
        ? JSON.stringify(result.result)
        : result.result;
      accumulatedContext += `\n【${result.toolName}】: ${resultSummary}`;

      // 生成这部分的回复
      const partialStream = await this.generatePartialResponse(
        userMessage,
        result,
        accumulatedContext,
        isFirstResult
      );

      for await (const chunk of partialStream) {
        yield { type: "content", content: chunk };
      }

      isFirstResult = false;
    }
  }

  /**
   * 生成部分响应（流式）
   */
  async *generatePartialResponse(userMessage, toolResult, fullContext, isFirst) {
    const transitionPhrase = isFirst ? "" : "\n\n另外，";

    const systemPrompt = `你是杨院长，一位专业的医美咨询顾问。
用户问: "${userMessage}"

已获取的信息:
${fullContext}

请${isFirst ? "根据以上信息" : "继续"}自然地回答用户。
${transitionPhrase ? `用"${transitionPhrase.trim()}"作为过渡词开头。` : ""}
保持亲切专业的语气。`;

    const stream = await this.openai.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ],
      stream: true,
      max_completion_tokens: 500
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) yield content;
    }
  }
}

module.exports = ResponseComposer;
```

### 10.4 工具注册示例

```javascript
// backend/src/config/tools.js

const toolRouter = new ToolRouter();

// 工具1: 历史聊天搜索
toolRouter.register("search_chat_history", {
  description: "搜索用户的历史聊天记录，当用户问'昨天聊了什么'、'之前说过什么'等问题时使用",
  quickMatch: /(昨天|前天|上次|之前|以前).*(聊|说|谈|做|发生)/,  // 快速匹配
  parameters: {
    type: "object",
    properties: {
      time_range: {
        type: "string",
        enum: ["today", "yesterday", "last_week", "last_month"],
        description: "时间范围"
      },
      query: {
        type: "string",
        description: "搜索关键词（可选）"
      }
    },
    required: ["time_range"]
  },
  executor: async (args, ctx) => {
    const dailySummaryService = require('../services/dailySummaryService');
    const date = calculateDate(args.time_range, ctx.timezone);
    return await dailySummaryService.getDailySummary(ctx.userId, date);
  }
});

// 工具2: 天气查询
toolRouter.register("get_weather", {
  description: "获取指定城市的天气信息，当用户问天气相关问题时使用",
  quickMatch: /(天气|气温|下雨|晴天|阴天|温度)/,
  parameters: {
    type: "object",
    properties: {
      city: {
        type: "string",
        description: "城市名称，默认北京"
      }
    }
  },
  executor: async (args, ctx) => {
    const weatherService = require('../services/weatherService');
    return await weatherService.getWeather(args.city || "北京");
  }
});

// 工具3: 用户画像查询
toolRouter.register("get_user_profile", {
  description: "获取用户的医美画像信息，包括关注的项目、预算、顾虑等",
  quickMatch: /(我的|我之前|我想做|我关注)/,
  parameters: {
    type: "object",
    properties: {
      aspect: {
        type: "string",
        enum: ["interests", "budget", "concerns", "all"],
        description: "查询的方面"
      }
    }
  },
  executor: async (args, ctx) => {
    const memobaseService = require('../services/memobaseService');
    return await memobaseService.getUserProfile(ctx.userId);
  }
});

module.exports = toolRouter;
```

### 10.5 重构后的 chatController

```javascript
// backend/src/controllers/chatController.js (重构后核心逻辑)

const ToolRouter = require('../services/toolRouter');
const ToolExecutor = require('../services/toolExecutor');
const ResponseComposer = require('../services/responseComposer');
const toolRouter = require('../config/tools');

const toolExecutor = new ToolExecutor(toolRouter);
const responseComposer = new ResponseComposer(openaiClient);

exports.sendMessage = async (ws, prompt, images = []) => {
  const userId = ws.userId;
  const context = {
    userId,
    timezone: await getUserTimezone(userId) || 'Asia/Shanghai'
  };

  try {
    // ===== 阶段1: 工具路由 =====

    // 1.1 快速路由（规则匹配，~10ms）
    let matchedTools = toolRouter.quickRoute(prompt);
    console.log(`[QuickRoute] 匹配到 ${matchedTools.length} 个工具:`, matchedTools);

    // 1.2 如果快速路由没匹配，使用 LLM 路由（~500ms）
    let toolCalls = [];
    if (matchedTools.length > 0) {
      // 快速路由匹配成功，构造工具调用
      toolCalls = matchedTools.map(name => ({
        id: `quick_${Date.now()}_${name}`,
        name,
        arguments: extractArgsFromMessage(prompt, name)
      }));
    } else {
      // 使用 LLM 判断是否需要工具
      toolCalls = await toolRouter.llmRoute(prompt, context);
    }

    // ===== 阶段2: 工具执行 + 响应生成 =====

    if (toolCalls.length > 0) {
      console.log(`[ToolExecutor] 准备执行 ${toolCalls.length} 个工具`);

      // 2.1 并行执行工具
      const toolResults = toolExecutor.executeParallel(toolCalls, context);

      // 2.2 流式组装响应（谁先完成谁先输出）
      for await (const part of responseComposer.composeStream(prompt, toolResults, context)) {
        if (part.type === "filler" || part.type === "content") {
          ws.send(JSON.stringify({ data: part.content }));
        }
      }
    } else {
      // ===== 阶段3: 普通对话（无工具） =====
      await handleNormalChat(ws, userId, prompt, images);
    }

    ws.send(JSON.stringify({ done: true }));

  } catch (error) {
    console.error('[ChatController] Error:', error);
    ws.send(JSON.stringify({ error: error.message }));
  }
};

/**
 * 从消息中提取工具参数（快速路由场景）
 */
function extractArgsFromMessage(message, toolName) {
  switch (toolName) {
    case 'search_chat_history':
      if (/昨天/.test(message)) return { time_range: 'yesterday' };
      if (/前天/.test(message)) return { time_range: 'day_before_yesterday' };
      if (/上周/.test(message)) return { time_range: 'last_week' };
      return { time_range: 'yesterday' };

    case 'get_weather':
      const cityMatch = message.match(/(北京|上海|广州|深圳|杭州|成都)/);
      return { city: cityMatch ? cityMatch[1] : '北京' };

    default:
      return {};
  }
}
```

### 10.6 并行执行时序示例

```
用户: "昨天聊了什么，今天北京天气怎样？"

时间线:
─────────────────────────────────────────────────────────────────
0ms    │ 收到消息
       │
10ms   │ QuickRoute 匹配到 2 个工具:
       │   - search_chat_history (昨天)
       │   - get_weather (北京天气)
       │
20ms   │ ToolExecutor.executeParallel() 启动
       │   ├── 任务1: 查询每日总结 (异步)
       │   └── 任务2: 调用天气API (异步)
       │
50ms   │ ResponseComposer 发送填充语:
       │   → "好的，让我帮你查一下..."
       │
150ms  │ 天气API返回 (更快)
       │   → yield { toolName: "get_weather", result: "晴天 26°C" }
       │
200ms  │ 生成天气部分回复 (流式):
       │   → "今天北京天气不错，晴天，气温26度，..."
       │
400ms  │ 每日总结返回 (较慢)
       │   → yield { toolName: "search_chat_history", result: "..." }
       │
450ms  │ 生成历史部分回复 (流式):
       │   → "另外，关于昨天的对话，我们主要聊了双眼皮手术..."
       │
700ms  │ 完成
       │   → { done: true }
─────────────────────────────────────────────────────────────────
总耗时: 700ms (并行) vs 1200ms+ (串行)
```

### 10.7 对比优势

| 方面 | 当前架构 | 重构后架构 |
|------|----------|------------|
| **工具检测** | 字符串解析 `[SEARCH:]` | OpenAI Function Calling / 正则快速匹配 |
| **可扩展性** | 添加工具需修改主流程 | 只需 `toolRouter.register()` |
| **执行方式** | 串行，一个一个来 | 并行，Promise.race |
| **响应策略** | 等待搜索完成再说 | 即时填充 + 渐进输出 |
| **代码量** | 单文件 800+ 行 | 分层，每个模块 ~100 行 |
| **测试难度** | 难以单元测试 | 各模块可独立测试 |

### 10.8 文件结构

```
backend/src/
├── controllers/
│   └── chatController.js      # 精简为 ~200 行，只做协调
├── services/
│   ├── toolRouter.js          # 工具注册和路由
│   ├── toolExecutor.js        # 并行执行器
│   ├── responseComposer.js    # 流式响应组装
│   ├── dailySummaryService.js # 每日总结（已有）
│   ├── weatherService.js      # 天气服务（新增）
│   └── ...
├── config/
│   └── tools.js               # 工具定义和注册
└── ...
```

### 10.9 参考资料

- [Google: Bidirectional Streaming Multi-agent System](https://developers.googleblog.com/en/beyond-request-response-architecting-real-time-bidirectional-streaming-multi-agent-system/)
- [Speculative Tool Calling for Voice](https://getstream.io/blog/speculative-tool-calling-voice/)
- [LangChain LLMCompiler (DAG Execution)](https://langchain-ai.github.io/langgraph/tutorials/llm-compiler/LLMCompiler/)
- [OpenAI Function Calling](https://platform.openai.com/docs/guides/function-calling)
- [Parallel Tool Calling](https://blog.continue.dev/parallel-tool-calling/)
- [Reducing Voice Agent Latency](https://webrtc.ventures/2025/06/reducing-voice-agent-latency-with-parallel-slms-and-llms/)

---

## 11. 已实现的改进 (2026-01-08)

根据评审建议，以下改进已经实现：

### 11.1 P0: SQL UPSERT 修正

**问题**: 原设计中 `INSERT INTO daily_summaries` 在并发场景下会报错。

**解决方案**: 在 `supabaseService.js` 中使用 UPSERT 逻辑：

```javascript
// backend/src/services/supabaseService.js
async saveDailySummary(userUuid, date, summaryData) {
  const { data, error } = await this.client
    .from('daily_summaries')
    .upsert({
      user_id: userUuid,
      date: date,
      summary: summaryData.summary,
      // ...其他字段
    }, {
      onConflict: 'user_id,date',  // 指定冲突列
      ignoreDuplicates: false       // 冲突时更新
    })
    .select()
    .single();
}
```

### 11.2 P0: 空闲超时兜底机制

**问题**: `ws.on('close')` 在移动端不可靠（用户杀进程、网络切换、App 后台冻结）。

**解决方案**: 双重触发机制

新增文件：
- `backend/src/services/idleSessionService.js` - 空闲会话检测服务
- `backend/src/services/sessionSummaryService.js` - 会话摘要生成服务

核心逻辑：
1. `ws.on('close')` 保留作为触发器之一
2. 空闲超时检测：每 5 分钟扫描，如果用户 30 分钟无消息，判定会话结束
3. 在 `chatController.js` 中每次处理消息后记录用户活动

```javascript
// backend/src/services/idleSessionService.js
const IDLE_TIMEOUT = 30 * 60 * 1000;  // 30 分钟
const CHECK_INTERVAL = 5 * 60 * 1000; // 5 分钟

class IdleSessionService {
  checkIdleSessions() {
    for (const [userId, activity] of this.userLastActivity.entries()) {
      if (Date.now() - activity.lastMessageTime >= IDLE_TIMEOUT) {
        // 触发会话总结生成
        this.handleIdleSession(userId, activity.sessionId, activity.messages);
      }
    }
  }
}
```

### 11.3 P1: 信息有损回退机制

**问题**: 预计算总结是有损压缩，用户问具体细节（如药名）时可能找不到。

**解决方案**: 在 `dailySummaryService.js` 中添加 `getDailySummaryWithFallback` 方法：

```javascript
// backend/src/services/dailySummaryService.js
async function getDailySummaryWithFallback(wechatOpenId, date, query) {
  const result = {
    summary: null,
    rawMessages: null,
    needsDetailSearch: false
  };

  // 获取每日总结
  const dailySummary = await getDailySummary(user.uuid, date);
  result.summary = dailySummary?.summary;

  // 检测是否需要细节搜索
  const detailPatterns = [
    /具体|详细|原话|说的是|什么名字|叫什么|多少钱/,
    /药|价格|费用|预算|医生|医院/
  ];

  if (detailPatterns.some(p => p.test(query)) || !dailySummary) {
    // 自动回退到原始记录搜索
    result.rawMessages = await supabaseService.searchMessages(wechatOpenId, {
      startTime: `${date}T00:00:00`,
      endTime: `${date}T23:59:59`,
      limit: 20
    });
    result.needsDetailSearch = true;
  }

  return result;
}
```

### 11.4 P2: 定时任务并发限制

**问题**: 如果用户量大，`for (const user of users)` 循环会导致任务积压。

**解决方案**: 在 `dailySummaryJob.js` 中添加并发限制器：

```javascript
// backend/src/jobs/dailySummaryJob.js
const CONCURRENCY_LIMIT = 5; // 同时处理 5 个用户
const ACTIVE_THRESHOLD = 10 * 60 * 1000; // 10 分钟内活跃跳过

function createLimiter(concurrency) {
  let running = 0;
  const queue = [];
  // ... 实现队列逻辑
}

async function runDailySummaryJob() {
  const limit = createLimiter(CONCURRENCY_LIMIT);

  const tasks = users.map(user => {
    return limit(async () => {
      // 活跃窗口检测：跳过最近活跃的用户
      const lastActive = await supabaseService.getUserLastActiveTime(user.id);
      if (lastActive && (Date.now() - lastActive.getTime()) < ACTIVE_THRESHOLD) {
        return; // 跳过
      }
      await dailySummaryService.generateDailySummary(user.id, dateStr);
    });
  });

  await Promise.all(tasks);
}
```

### 11.5 新增文件清单

| 文件 | 用途 |
|------|------|
| `services/sessionSummaryService.js` | 会话摘要生成 |
| `services/idleSessionService.js` | 空闲会话检测 |
| `services/dailySummaryService.js` | 每日总结生成 + 回退机制 |
| `jobs/dailySummaryJob.js` | 定时任务 + 并发限制 |

### 11.6 修改的现有文件

| 文件 | 修改内容 |
|------|----------|
| `services/supabaseService.js` | 添加 `saveDailySummary`、`getDailySummary` 等方法 (使用 UPSERT) |
| `services/memoryService.js` | 集成空闲检测、会话摘要生成 |
| `controllers/chatController.js` | 记录用户活动、断开时传递消息 |

### 11.7 待完成事项

1. **数据库迁移**: 需要执行 SQL 创建 `daily_summaries` 表和相关索引
2. **node-cron 依赖**: 如需启用定时任务，需安装 `npm install node-cron`
3. **测试**: 建议在非生产环境验证空闲检测和会话摘要生成

---

*报告生成日期: 2026-01-08*
*架构章节更新: 2026-01-08*
*改进实现日期: 2026-01-08*
