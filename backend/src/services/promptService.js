const fs = require('fs');
const path = require('path');

class PromptService {
  constructor() {
    this.promptsConfig = null;
    this.loadPrompts();
    this.watchConfigFile();
  }

  loadPrompts() {
    try {
      const configPath = path.join(__dirname, '../../config/prompts.json');
      const configData = fs.readFileSync(configPath, 'utf8');
      this.promptsConfig = JSON.parse(configData);
      console.log('提示词配置加载成功');
    } catch (error) {
      console.error('加载提示词配置失败:', error);
      // 使用默认配置作为后备
      this.promptsConfig = this.getDefaultConfig();
    }
  }

  getDefaultConfig() {
    return {
      systemPrompt: {
        prompt: "你是杨院长，一位经验丰富的整形美容专家。请以专业、亲切的方式回答用户的问题。"
      }
    };
  }

  getSystemPrompt() {
    const prompt = this.promptsConfig.systemPrompt.prompt;
    console.log('当前使用的系统提示词长度:', prompt ? prompt.length : 0);
    console.log('提示词前100字符:', prompt ? prompt.substring(0, 100) + '...' : 'null');
    return prompt;
  }

  getGreetingTemplate(type, hasName = false) {
    const templates = this.promptsConfig.greetingTemplates;
    
    if (type === 'firstTime') {
      return hasName ? templates.firstTime.withNickname : templates.firstTime.withoutNickname;
    } else if (type === 'returning') {
      if (!hasName) return templates.returning.withoutName;
      // 这里可以根据上次访问时间决定使用 recent 还是 longTime
      return templates.returning.recent;
    }
    
    return templates.firstTime.withoutNickname;
  }

  // 重新加载配置（用于热更新）
  reloadPrompts() {
    console.log('重新加载提示词配置...');
    this.loadPrompts();
  }

  // 监听配置文件变化，实现热更新
  watchConfigFile() {
    const configPath = path.join(__dirname, '../../config/prompts.json');
    try {
      require('fs').watchFile(configPath, (curr, prev) => {
        console.log('检测到提示词配置文件变化，正在重新加载...');
        this.reloadPrompts();
      });
      console.log('开始监听提示词配置文件变化');
    } catch (error) {
      console.log('无法监听配置文件变化:', error.message);
    }
  }

  // 获取完整的系统提示词配置
  getSystemPromptConfig() {
    return this.promptsConfig.systemPrompt;
  }

  // 格式化问候语模板
  formatGreeting(template, variables = {}) {
    let formatted = template;
    Object.keys(variables).forEach(key => {
      const placeholder = `{${key}}`;
      formatted = formatted.replace(new RegExp(placeholder, 'g'), variables[key]);
    });
    return formatted;
  }

  // 清理AI回复中的Markdown格式符号
  cleanMarkdownForWeChat(text) {
    if (!text || typeof text !== 'string') return text;
    
    let cleaned = text
      // 移除所有可能的标题格式
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/^={2,}$/gm, '')
      .replace(/^-{2,}$/gm, '')
      
      // 移除加粗和斜体格式
      .replace(/\*\*\*([^*]+)\*\*\*/g, '「$1」')  // 粗斜体
      .replace(/\*\*([^*]+)\*\*/g, '「$1」')      // 加粗
      .replace(/\*([^*]+)\*/g, '$1')             // 斜体
      .replace(/__([^_]+)__/g, '「$1」')         // 下划线加粗
      .replace(/_([^_]+)_/g, '$1')              // 下划线斜体
      
      // 移除所有分隔线变体
      .replace(/^[-*_]{3,}$/gm, '')
      .replace(/^\s*[-*_]{3,}\s*$/gm, '')
      
      // 移除引用格式  
      .replace(/^>\s*/gm, '')
      .replace(/^&gt;\s*/gm, '')
      
      // 移除代码块和行内代码
      .replace(/```[\s\S]*?```/g, '')
      .replace(/~~([^~]+)~~/g, '$1')            // 删除线
      .replace(/`([^`]+)`/g, '「$1」')
      
      // 转换列表格式 - 更全面的匹配
      .replace(/^\s*[-*+]\s+/gm, '• ')
      .replace(/^\s*(\d+)\.\s+/gm, (match, number) => {
        return `${this.getChineseNumber(number)} `;
      })
      
      // 移除链接格式但保留文本
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      
      // 移除表格分隔符
      .replace(/^\|.*\|$/gm, '')
      .replace(/^\s*\|[-:|\s]+\|\s*$/gm, '')
      
      // 清理多余的符号
      .replace(/[#*_`~\[\]]/g, '')
      
      // 清理多余的空行和空白
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+$/gm, '')
      .trim();
    
    return cleaned;
  }

  // 转换数字为中文序号
  getChineseNumber(num) {
    const numbers = ['', '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
    const n = parseInt(num);
    if (n >= 1 && n <= 10) {
      return numbers[n];
    }
    return `${n}.`;
  }
}

module.exports = new PromptService();