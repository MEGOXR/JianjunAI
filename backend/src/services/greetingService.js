const userDataService = require('./userDataService');
const promptService = require('./promptService');
const { AzureOpenAI } = require('openai');

class GreetingService {
  constructor() {
    // 初始化Azure OpenAI客户端
    this.openai = new AzureOpenAI({
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      endpoint: process.env.AZURE_OPENAI_ENDPOINT,
      apiVersion: process.env.OPENAI_API_VERSION,
      deployment: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
    });
  }

  async generateGreeting(userData) {
    const chatHistory = userData?.chatHistory || [];
    const extractedName = userData?.userInfo?.extractedName;
    const name = extractedName;
    
    console.log('检查问候语条件:', {
      hasUserData: !!userData,
      chatHistoryLength: chatHistory.length,
      lastVisit: userData?.lastVisit,
      createdAt: userData?.createdAt
    });
    
    // 检查是否需要发送问候语（基于时间判断）
    if (!this.shouldSendGreeting(userData)) {
      return null; // 24小时内返回的用户不发送问候语
    }
    
    // 首次访问（没有用户数据或没有聊天记录）
    if (!userData || chatHistory.length === 0) {
      console.log('识别为首次访问用户，生成首次问候语');
      const template = promptService.getGreetingTemplate('firstTime', !!name);
      return promptService.formatGreeting(template, { name: name || '' });
    }
    
    // 老用户返回 - 使用AI总结话题
    console.log('识别为返回用户，生成返回问候语');
    const template = promptService.getGreetingTemplate('returning', !!name);
    const lastTopic = await this.summarizeConversationTopic(chatHistory);
    const variables = {
      name: name || '朋友',
      lastTopic: lastTopic
    };
    
    return promptService.formatGreeting(template, variables);
  }

  /**
   * 判断是否应该发送问候语
   * 规则：如果用户在24小时内访问过，则不发送问候语
   */
  shouldSendGreeting(userData) {
    if (!userData) {
      // 没有用户数据，应该发送问候语（真正的首次访问）
      console.log('没有用户数据，发送问候语');
      return true;
    }
    
    if (!userData.lastVisit) {
      // 有用户数据但没有访问记录，说明是新创建的用户，发送问候语
      console.log('新用户没有访问记录，发送问候语');
      return true;
    }
    
    const now = new Date();
    const lastVisit = new Date(userData.lastVisit);
    const hoursSinceLastVisit = (now - lastVisit) / (1000 * 60 * 60);
    
    // 如果距离上次访问超过24小时，发送问候语
    const shouldSend = hoursSinceLastVisit >= 24;
    
    console.log(`用户上次访问时间: ${lastVisit.toISOString()}, 距今${hoursSinceLastVisit.toFixed(1)}小时, ${shouldSend ? '需要' : '不需要'}发送问候语`);
    
    return shouldSend;
  }

  // 使用AI总结对话话题
  async summarizeConversationTopic(chatHistory) {
    try {
      // 获取最近的对话（最多10条消息，排除system消息）
      const recentMessages = chatHistory
        .filter(msg => msg.role !== 'system')
        .slice(-10)
        .map(msg => `${msg.role === 'user' ? '用户' : '医生'}: ${msg.content}`)
        .join('\n');

      if (!recentMessages.trim()) {
        return '整形美容咨询';
      }

      const prompt = `请分析以下整形美容咨询对话，简洁地总结用户最关心的话题。要求：
1. 用5-15个字概括用户的核心关注点
2. 使用自然的中文表达，不要太正式
3. 如果是多个话题，选择最近讨论的主要话题
4. 避免使用"咨询"、"讨论"等词汇，直接说话题内容

对话内容：
${recentMessages}

话题总结：`;

      const response = await this.openai.chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 50,
        temperature: 0.3
      });

      const summary = response.choices[0]?.message?.content?.trim();
      
      // 如果AI总结失败或为空，使用备选方案
      if (!summary || summary.length > 20) {
        return this.fallbackTopicExtraction(chatHistory);
      }

      return summary;
    } catch (error) {
      console.error('AI话题总结失败，使用备选方案:', error);
      return this.fallbackTopicExtraction(chatHistory);
    }
  }

  // 备选话题提取方案（当AI总结失败时使用）
  fallbackTopicExtraction(chatHistory) {
    // 从后往前找用户的最后一条消息
    for (let i = chatHistory.length - 1; i >= 0; i--) {
      const message = chatHistory[i];
      if (message.role === 'user' && message.content) {
        const content = message.content.trim();
        
        // 提取关键词
        const keywords = ['双眼皮', '隆鼻', '瘦脸', '除皱', '美白', '祛斑', '丰胸', '吸脂', '面部', '皮肤', '注射', '手术'];
        const foundKeyword = keywords.find(keyword => content.includes(keyword));
        
        if (foundKeyword) {
          return foundKeyword + '相关问题';
        }
        
        // 如果没有关键词，简单截断
        if (content.length <= 15) {
          return content;
        }
        return content.substring(0, 12) + '...';
      }
    }
    
    return '整形美容咨询';
  }
}

module.exports = new GreetingService();