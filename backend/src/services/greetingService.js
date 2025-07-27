const userDataService = require('./userDataService');

class GreetingService {
  generateGreeting(userData, wxNickname) {
    const timeSince = userData?.lastVisit ? 
      userDataService.calculateTimeSinceLastVisit(userData.lastVisit) : null;
    
    const extractedName = userData?.userInfo?.extractedName;
    const name = extractedName || wxNickname || '朋友';
    const lastMessage = userData?.lastMessage;
    const chatHistory = userData?.chatHistory || [];
    
    // 首次访问
    if (!userData || chatHistory.length === 0) {
      if (wxNickname && !extractedName) {
        return `你好${wxNickname}！我是杨院长的AI助手。很高兴认识你！有什么整形美容方面的问题，我都可以为你详细解答。对了，如果你愿意告诉我怎么称呼你，我会记住的。`;
      }
      return `你好！我是杨院长的AI助手。很高兴认识你！有什么整形美容方面的问题，我都可以为你详细解答。`;
    }
    
    // 根据时间间隔生成不同的问候
    if (timeSince) {
      switch (timeSince.unit) {
        case 'just_now':
          return `欢迎回来，${name}！我们刚才聊到哪里了？`;
          
        case 'minutes':
          if (timeSince.value < 30) {
            return `${name}，有什么需要补充的吗？`;
          } else {
            return `${name}，让我们继续刚才的话题吧。`;
          }
          
        case 'hours':
          if (timeSince.value < 6) {
            return this.generateContextualGreeting(name, lastMessage, '让我们继续之前的讨论');
          } else if (timeSince.value < 24) {
            const timeOfDay = this.getTimeOfDay();
            return `${timeOfDay}好，${name}！` + this.generateContextualGreeting(name, lastMessage);
          }
          
        case 'days':
          if (timeSince.value === 1) {
            return `${name}，昨天我们聊得很愉快！` + this.generateContextualGreeting(name, lastMessage, '今天有什么新的想了解的吗');
          } else if (timeSince.value < 7) {
            return `${name}，几天不见！` + this.generateContextualGreeting(name, lastMessage, '最近考虑得怎么样了');
          } else if (timeSince.value < 30) {
            return `${name}，好久不见了！` + this.generateContextualGreeting(name, lastMessage, '之前讨论的事情有进展吗');
          } else {
            return `${name}，真的好久不见了！很高兴你又来了。之前我们聊过的内容你还记得吗？有什么新的问题想咨询吗？`;
          }
      }
    }
    
    return `欢迎回来，${name}！有什么可以帮助你的吗？`;
  }
  
  generateContextualGreeting(name, lastMessage, suffix = '') {
    if (!lastMessage) {
      return suffix ? suffix + '？' : '有什么可以帮你的吗？';
    }
    
    // 根据上次对话内容生成相关问候
    const contextualResponses = {
      '双眼皮': '关于双眼皮手术，',
      '隆鼻': '关于鼻部整形，',
      '瘦脸': '关于面部轮廓调整，',
      '抽脂': '关于吸脂塑形，',
      '隆胸': '关于胸部整形，',
      '除皱': '关于抗衰除皱，',
      '玻尿酸': '关于注射美容，',
      '肉毒素': '关于肉毒素注射，',
      '恢复': '关于术后恢复，',
      '价格': '关于费用问题，',
      '风险': '关于手术风险，',
      '效果': '关于手术效果，'
    };
    
    for (const [keyword, prefix] of Object.entries(contextualResponses)) {
      if (lastMessage.includes(keyword)) {
        return prefix + (suffix || '还有什么想了解的吗？');
      }
    }
    
    return suffix ? suffix + '？' : '有什么新的问题吗？';
  }
  
  getTimeOfDay() {
    const hour = new Date().getHours();
    if (hour < 6) return '凌晨';
    if (hour < 12) return '早上';
    if (hour < 14) return '中午';
    if (hour < 18) return '下午';
    return '晚上';
  }
}

module.exports = new GreetingService();