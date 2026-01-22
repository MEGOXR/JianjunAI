const AzureClientFactory = require('../utils/AzureClientFactory');

class NameExtractorService {
  async extractNameFromConversation(messages) {
    try {
      // 验证配置并获取客户端
      AzureClientFactory.validateConfig();
      const client = AzureClientFactory.getClient();

      // 构建提取名字的提示
      const conversationContext = messages
        .filter(msg => msg.role === 'user')
        .slice(-5) // 只看最近5条用户消息
        .map(msg => msg.content)
        .join('\n');

      const systemPrompt = `你是一个专门识别用户名字的助手。请从用户的对话中识别出用户告诉你的名字。

规则：
1. 只提取用户明确告诉你的名字，不要猜测
2. 如果用户说"我叫..."、"我是..."、"我的名字是..."、"你可以叫我..."等，提取后面的名字
3. 忽略职位、称呼等，只要名字本身
4. 如果没有找到明确的名字，返回null
5. 返回格式必须是JSON：{"name": "找到的名字"} 或 {"name": null}
6. 名字应该是2-4个字的中文名字，或合理长度的英文名

例子：
- "我叫小明" -> {"name": "小明"}
- "我是张医生" -> {"name": null} (医生是职位，不确定名字)
- "我是张三，今年25岁" -> {"name": "张三"}
- "你可以叫我David" -> {"name": "David"}
- "我想咨询一下" -> {"name": null}`;

      const response = await client.chat.completions.create({
        model: AzureClientFactory.getDeploymentName(),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `请从以下对话中提取用户的名字：\n\n${conversationContext}` }
        ],
        temperature: 0.1,
        max_completion_tokens: 50,
        response_format: { type: "json_object" }
      });

      const result = JSON.parse(response.choices[0].message.content);
      return result.name;
    } catch (error) {
      console.error('Name extraction error:', error);
      return null;
    }
  }

  async shouldUpdateName(currentName, newMessage) {
    // 如果已经有名字，检查新消息是否包含更正名字的意图
    if (!currentName) return true;

    const nameChangePatterns = [
      /不是.*我叫/,
      /我不叫.*我叫/,
      /叫错了.*叫我/,
      /更正.*我的名字/,
      /其实我叫/
    ];

    return nameChangePatterns.some(pattern => pattern.test(newMessage));
  }
}

module.exports = new NameExtractorService();