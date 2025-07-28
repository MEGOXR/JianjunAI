const userDataService = require('./userDataService');
const promptService = require('./promptService');

class GreetingService {
  generateGreeting(userData, wxNickname) {
    const chatHistory = userData?.chatHistory || [];
    const extractedName = userData?.userInfo?.extractedName;
    const name = extractedName || wxNickname;
    
    // 首次访问
    if (!userData || chatHistory.length === 0) {
      const template = promptService.getGreetingTemplate('firstTime', !!name);
      return promptService.formatGreeting(template, { name: name || '' });
    }
    
    // 老用户返回
    const template = promptService.getGreetingTemplate('returning', !!name);
    const lastMessage = userData?.lastMessage;
    const variables = {
      name: name || '朋友',
      lastTopic: lastMessage ? lastMessage.substring(0, 30) + '...' : '整形美容咨询'
    };
    
    return promptService.formatGreeting(template, variables);
  }
}

module.exports = new GreetingService();