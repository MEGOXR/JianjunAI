您好，您反馈的这三个问题非常精准，而且它们之间相互关联，特别是“自动滑动失效”和“JS报错”直接揭示了问题的根源。您已经成功地应用了节流缓冲，解决了最大的性能瓶颈，现在我们来处理这些收尾的逻辑和BUG问题。

我们逐一分析并解决。

---

### 问题 3：`ReferenceError: finalMessages is not defined` (直接BUG)

这是一个简单的笔误，我们首先修复它。

*   **问题定位**：在 `socketTask.onMessage` 的 `if (data.done)` 代码块中，有一段用于处理语音模式的代码。
    ```javascript
    // 您代码中的错误之处 (line 506附近)
    if (this.data.isVoiceMode && finalMessages.length > 0) { // <--- finalMessages 在这里未定义
      const lastMessage = finalMessages[finalMessages.length - 1];
      // ...
    }
    ```
*   **原因**：变量 `finalMessages` 在当前作用域中确实不存在。正确的做法是直接使用 `this.data.messages`，因为它持有当前UI上最新的消息列表。

*   **【修复】**：将 `finalMessages` 替换为 `this.data.messages`。

    ```javascript
    // 修正后的代码
    if (data.done) {
      // ... (其他done逻辑)
      
      // Play TTS for complete AI response if in voice mode
      const messages = this.data.messages; // 先获取当前消息列表
      if (this.data.isVoiceMode && messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        if (lastMessage.role === 'assistant') {
          // ...
        }
      }
      // ...
    }
    ```

---

### 问题 1 & 2：滚动功能失效 (核心逻辑问题)

这是当前最核心的体验问题。您观察到的“满了一页后不继续”是 `scroll-into-view` 机制的一个典型表现，而“发送后不滚动”则说明调度逻辑有待完善。

*   **问题根源**：您使用的 `scroll-into-view: 'msg-${lastIndex}'` 策略，是让视图滚动到 **ID为`msg-${lastIndex}`的那个元素** 的位置。
    *   **流式输出时**：AI回复时，这个 `div` 的 `id` **始终不变**。您只是在不断地往这个 `div` 内部填充文字，导致它变高。但因为这个 `div` 本身已经位于可见区域内，所以小程序不会再触发滚动。**视图不会自动去追随一个正在变高的元素的底部。**
    *   **发送消息后**：虽然逻辑上调用了 `scheduleAutoScroll`，但可能因为时机或其它原因，滚动效果没有稳定触发。

*   **【终极解决方案】统一滚动目标：底部锚点**

    为了解决所有滚动问题，我们采用一个更稳定、更简单、更可靠的“锚点”方案。我们不再滚动到某条不确定的消息，而是始终滚动到一个**固定的、位于聊天记录最底部的“隐形”锚点**。

    #### 第一步：在 WXML 中添加底部锚点

    在您的 `scroll-view` 内容的**最末尾**，添加一个空的 `view` 作为锚点。

    ```xml
    <!-- index.wxml -->
    <scroll-view 
      ...
      scroll-into-view="{{scrollIntoView}}"
    >
      <block wx:for="{{messages}}" wx:key="timestamp">
        <!-- message-item... -->
        <view class="message-item" id="msg-{{index}}">
          <!-- ... -->
        </view>
      </block>
      
      <!-- 【关键新增】在所有消息循环的下方，添加一个永久的底部锚点 -->
      <view id="chat-bottom-anchor"></view>
      
    </scroll-view>
    ```

    #### 第二步：修改 JS 中的滚动调度函数

    让 `scheduleAutoScroll` **始终以这个固定的锚点为目标**。这样，无论你是新增消息还是流式输出，只要调用它，就等于在说“滚动到最最底部”。

    ```javascript
    // index.js
    // 【修正】一个节流的滚动调度函数
    scheduleAutoScroll: function() {
      if (this.scrollTimer) return;

      this.scrollTimer = setTimeout(() => {
        this.scrollTimer = null;
        if (!this.data.userHasScrolledUp) {
          // 【关键修正】始终滚动到底部锚点
          this.setData({ scrollIntoView: 'chat-bottom-anchor' });
        }
      }, 100);
    },
    ```

    这个改动极其高效，它用一个统一的机制解决了所有场景下的“滚动到底部”的需求，无论是用户发送消息后，还是AI流式回复时，逻辑完全一致，效果稳定可靠。

---

### 潜在的性能问题：`sendVoiceMessage`

我注意到，您的 `sendVoiceMessage` 函数还遗留着之前导致性能崩溃的旧逻辑。当用户通过语音输入时，如果历史消息很多，同样会造成卡顿甚至崩溃。

*   **问题代码**：
    ```javascript
    sendVoiceMessage: function(text) {
      // ...
      const newMessages = [...this.data.messages, newMessage];
      this.setData({
        messages: this.formatMessages(newMessages) // <--- 灾难重现！全量格式化
      });
      // ...
    }
    ```

*   **【修复】**：必须将其修改为和 `sendMessage` 一样的**增量更新**逻辑。

    ```javascript
    // index.js
    // 【修正】sendVoiceMessage 函数
    sendVoiceMessage: function(text) {
      const newUserMessage = {
        role: 'user',
        content: text,
        timestamp: Date.now()
      };

      // 只格式化单条新消息
      const formattedNewUserMessage = this.formatMessages([newUserMessage])[0];

      // 使用 concat 增量更新
      this.setData({
        messages: this.data.messages.concat(formattedNewUserMessage)
      }, () => {
        // 立即调度滚动
        this.scheduleAutoScroll();
      });
      
      if (this.socketTask) {
        this.socketTask.send({
          data: JSON.stringify({ 
            prompt: text,
            wxNickname: this.data.wxNickname || ''
          })
        });
      }
    },
    ```

### 清理 `onUnload`

为了代码的健壮性，在页面卸载时，应该把所有可能在后台运行的定时器都清理掉。

```javascript
// index.js
// 【修正】onUnload
onUnload: function () {
  this.isPageUnloaded = true;
  if (this.socketTask) {
    this.socketTask.close();
    this.socketTask = null;
  }
  // 清理所有定时器
  if (this.scrollTimer) clearTimeout(this.scrollTimer);
  if (this.scrollEventTimer) clearTimeout(this.scrollEventTimer);
  if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
  if (this._stream.timer) clearTimeout(this._stream.timer); // <--- 补充清理流定时器
},
```

### 总结：请按以下步骤操作

1.  **修复JS错误**：在`socketTask.onMessage`的`if (data.done)`块中，将 `finalMessages` 替换为 `this.data.messages`。
2.  **添加WXML锚点**：在`index.wxml`的`<scroll-view>`内的`<block>`循环之后，添加 `<view id="chat-bottom-anchor"></view>`。
3.  **更新JS滚动函数**：用上面提供的【修正版】`scheduleAutoScroll`函数替换您现有的同名函数。
4.  **修复语音发送性能**：用上面提供的【修正版】`sendVoiceMessage`函数替换您现有的同名函数。
5.  **完善onUnload**：用上面提供的【修正版】`onUnload`函数替换您现有的同名函数，确保所有定时器都被清理。

完成以上五步操作后，您的小程序将彻底解决目前已知的**所有滚动问题**和**JS运行时错误**，同时规避了语音输入场景下的潜在性能风险。