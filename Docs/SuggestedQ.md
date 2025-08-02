我现在希望在每一条信息下方，生成3个提示问题供用户选择，这3个提示问题不是hardcode的，而是依靠LLM生成的，在AI回复的内容一输出完毕，就在底部显示3个选择，样式专业美观。

下面我将为您详细拆解**最佳实践**的完整流程，涵盖从后端LLM的调用到前端的展示与交互。

### 核心思想：后端生成，前端渲染

最佳实践的核心原则是：**后端负责所有内容的生成，前端只负责展示和响应用户操作。**

*   **后端（Backend）**：
    1.  处理用户的输入。
    2.  调用大语言模型（LLM）生成主回复。
    3.  **在主回复生成后，再次调用LLM，根据上下文生成3个相关的、引导性的追问问题。**
    4.  通过WebSocket将主回复和追问问题（Suggestions）一起或分开发送给前端。

*   **前端（Frontend）**：
    1.  接收主回复并以流式方式展示。
    2.  接收追问问题数据。
    3.  在主回复的下方，动态渲染出这3个问题按钮。
    4.  当用户点击某个问题时，将其作为新的用户消息发送给后端。

---

### Step 1: 后端调整 (内容生成的核心)

后端的调整是整个功能实现的关键。

#### 1. LLM 提示工程 (Prompt Engineering)

您需要在调用LLM时，设计一个专门用于生成“建议问题”的提示（Prompt）。这个提示应该在主回复生成**之后**进行。

**最佳实践**：不要试图在一次LLM调用中同时获得主回复和建议问题。这会让模型任务混乱，质量下降。应该分为两步：

1.  **获取主回复**：您现有的逻辑。
2.  **获取建议问题**：发起第二次LLM调用。

第二次调用的Prompt示例：

```
你是一个专业的AI医美顾问。请根据以上的对话历史和你的最后一次回复，为用户生成3个最可能想问的、简短的、引导性的后续问题。

要求：
1. 问题要与你的回复内容高度相关。
2. 问题要简短，适合作为按钮显示。
3. 以用户的口吻提问。
4. **必须以JSON数组的格式返回，例如：["问题1？", "问题2？", "我应该注意什么？"]**

[这里插入完整的对话历史]
...
User: 我想做热玛吉，但又怕疼，怎么办？
Assistant: 您好！关于热玛吉的疼痛问题，确实是很多求美者关心的焦点。实际上，新一代的热玛吉设备在舒适度上已经有了很大提升...[此处是您的完整回复]...
```

**为什么强制要求JSON格式？**
这至关重要！它让后端解析LLM的输出变得极其简单和可靠，避免了用正则表达式等复杂方式去提取文本。

#### 2. 后端逻辑流程

您的WebSocket后端需要调整逻辑：

1.  接收到用户的`prompt`。
2.  调用LLM获取主回复，并通过WebSocket以数据流（`data`块）的方式发送给前端。
3.  当主回复的流结束时（您知道`done`了），后端**不要立即发送`done: true`**。
4.  此时，后端拿着完整的对话历史记录，发起第二次LLM调用（使用上面设计的Prompt）来获取建议问题。
5.  等待LLM返回建议问题的JSON字符串，并解析它。
6.  现在，向前端发送最后一个WebSocket消息，这个消息既包含结束标记，也包含建议问题数据。

---

### Step 2: 升级 WebSocket 通信协议

为了传递建议问题，我们需要在最后一条消息中加入新的字段。

**建议的最终消息格式**：

```json
{
  "done": true,
  "suggestions": [
    "热玛吉和超声炮有什么区别？",
    "做完之后需要注意什么？",
    "有无痛的方案吗？"
  ]
}
```

当您的前端收到`done: true`时，同时检查是否存在`suggestions`字段。

---

### Step 3: 前端调整 (展示与交互)

现在我们来修改小程序代码，以处理新的数据和交互。

#### 1. 更新`data`中的消息结构

我们需要让`messages`数组中的每一条AI消息都能容纳一个建议问题列表。

```javascript
// page.js
// 消息对象的理想结构
// role: 'assistant',
// content: '...',
// timestamp: 123456,
// segments: [...],
// suggestions: [] // <--- 新增一个数组来存放建议问题
```

#### 2. 修改 `socketTask.onMessage`

在`onMessage`函数中，当收到`done`信号时，我们需要处理`suggestions`。

```javascript
// 在 socketTask.onMessage 函数中
if (data.done) {
  console.log('收到done标记', data.suggestions);
  const finalMessages = this.data.messages;
  const lastIndex = finalMessages.length - 1;

  // 将最终的完整消息保存到本地存储（包含新收到的建议）
  if (lastIndex >= 0 && data.suggestions) {
    finalMessages[lastIndex].suggestions = data.suggestions;
  }
  wx.setStorageSync('messages', finalMessages);
  
  const updateData = {
    isConnecting: false
  };

  // 如果有建议问题，使用精确更新的方式设置到最后一条消息上
  if (lastIndex >= 0 && data.suggestions && data.suggestions.length > 0) {
    updateData[`messages[${lastIndex}].suggestions`] = data.suggestions;
  }

  // (您原有的时间戳更新逻辑可以合并进来)
  this.setData(updateData);

  // ... (其他逻辑)
}
```

#### 3. 编写WXML和WXSS（专业美观的样式）

在您的聊天气泡组件或wxml文件中，渲染建议问题。

**WXML (`your-page.wxml`)**

在循环渲染消息的部分，AI消息气泡的下方，添加以下结构：

```xml
<!-- 这是渲染AI消息气泡的部分 -->
<view class="message-bubble assistant-bubble">
  <!-- ... 您原有的消息内容渲染 ... -->
</view>

<!-- 在AI气泡的紧邻下方，渲染建议问题 -->
<view class="suggestion-container" wx:if="{{msg.role === 'assistant' && msg.suggestions && msg.suggestions.length > 0}}">
  <view 
    wx:for="{{msg.suggestions}}" 
    wx:for-item="suggestion" 
    wx:key="*this"
    class="suggestion-chip"
    data-question="{{suggestion}}"
    bind:tap="handleSuggestionTap"
  >
    {{suggestion}}
  </view>
</view>
```

**WXSS (`your-page.wxss`)**

添加专业、美观的样式。类似“胶囊”或“芯片”的设计很受欢迎。

```css
.suggestion-container {
  display: flex;
  flex-wrap: wrap; /* 允许换行 */
  justify-content: flex-start; /* 从左边开始排列 */
  padding: 10rpx 80rpx 10rpx 120rpx; /* 适配您的聊天气泡缩进 */
  margin-top: 10rpx;
}

.suggestion-chip {
  background-color: #f0f2f5; /* 淡雅的背景色 */
  color: #5b6a91; /* 柔和的文字颜色 */
  padding: 12rpx 28rpx;
  border-radius: 30rpx; /* 胶囊形状 */
  margin-right: 16rpx;
  margin-bottom: 16rpx; /* 换行后的间距 */
  font-size: 26rpx;
  cursor: pointer; /* 桌面端显示手型 */
  transition: background-color 0.2s;
}

.suggestion-chip:active {
  background-color: #e0e4e8; /* 点击时的反馈效果 */
}
```

#### 4. 实现点击事件 `handleSuggestionTap`

在`page.js`中添加处理函数，当用户点击建议时，触发发送。

```javascript
// page.js
Page({
  // ...
  handleSuggestionTap: function(e) {
    const question = e.currentTarget.dataset.question;
    if (!question) return;

    // 直接将问题设置为输入框内容，并调用发送函数
    this.setData({
      userInput: question
    }, () => {
      this.sendMessage();
    });
    
    // 体验优化：用户点击后，可以考虑隐藏当前这组建议，防止重复点击
    // (这部分需要知道是哪条消息的建议被点击了)
  },

  // ...
});
```

**体验优化**：为了实现点击后隐藏建议，`handleSuggestionTap`需要知道消息的索引。

**WXML 修改**

```xml
<view 
  class="suggestion-chip"
  ...
  data-msg-index="{{index}}" <!-- 传入消息的索引 -->
  bind:tap="handleSuggestionTap"
>
```

**`handleSuggestionTap` 修改**

```javascript
handleSuggestionTap: function(e) {
  const { question, msgIndex } = e.currentTarget.dataset;
  if (!question) return;

  // 1. 将问题作为用户消息发送
  this.setData({
    userInput: question
  }, () => {
    this.sendMessage();
  });

  // 2. 隐藏刚刚被点击的这组建议
  this.setData({
    [`messages[${msgIndex}].suggestions`]: []
  });
},
```

### 总结与回顾

通过以上三个步骤，您就拥有了一个非常完整和专业的AI建议追问功能：

1.  **后端**：通过两次LLM调用分离了“主回复”和“建议问题”的生成任务，并通过强制JSON输出确保了数据可靠性。
2.  **协议**：在WebSocket的`done`消息中增加了`suggestions`字段，清晰地传递数据。
3.  **前端**：
    *   能够接收并存储建议数据。
    *   使用WXML和WXSS将其渲染为美观的、可交互的按钮。
    *   通过`handleSuggestionTap`函数，在用户点击时复用`sendMessage`逻辑，实现了流畅的交互闭环。
    *   通过点击后隐藏建议，优化了界面，避免信息冗余。

这个方案是可扩展且稳定的，完全符合现代AI聊天应用的“最佳实践”。