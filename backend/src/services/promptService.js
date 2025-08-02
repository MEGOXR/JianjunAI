const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

class PromptService {
  constructor() {
    this.promptsConfig = null;
    this.isLoading = false;
    this.initPrompts();
    this.watchConfigFile();
  }

  async initPrompts() {
    await this.loadPrompts();
  }

  async loadPrompts() {
    if (this.isLoading) return;
    this.isLoading = true;
    
    try {
      const configPath = path.join(__dirname, '../../config/prompts.json');
      const configData = await fs.readFile(configPath, 'utf8');
      this.promptsConfig = JSON.parse(configData);
      console.log('提示词配置加载成功');
    } catch (error) {
      console.error('加载提示词配置失败:', error);
      // 使用默认配置作为后备
      this.promptsConfig = this.getDefaultConfig();
    } finally {
      this.isLoading = false;
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
    // 如果配置还没加载完成，返回默认值
    if (!this.promptsConfig) {
      console.warn('提示词配置尚未加载，使用默认配置');
      return this.getDefaultConfig().systemPrompt.prompt;
    }
    
    const prompt = this.promptsConfig.systemPrompt.prompt;
    console.log('当前使用的系统提示词长度:', prompt ? prompt.length : 0);
    console.log('提示词前100字符:', prompt ? prompt.substring(0, 100) + '...' : 'null');
    return prompt;
  }

  getGreetingTemplate(type, hasName = false) {
    if (!this.promptsConfig) {
      console.warn('提示词配置尚未加载，使用默认问候语');
      return '您好！欢迎咨询，我是您的专属美容顾问。';
    }
    
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
  async reloadPrompts() {
    console.log('重新加载提示词配置...');
    await this.loadPrompts();
  }

  // 监听配置文件变化，实现热更新
  watchConfigFile() {
    const configPath = path.join(__dirname, '../../config/prompts.json');
    try {
      // 使用非阻塞的方式检查文件是否存在
      fsSync.access(configPath, fsSync.constants.F_OK, (err) => {
        if (err) {
          console.log('配置文件不存在，跳过监听');
          return;
        }
        
        // 使用 fs.watch 代替 watchFile，性能更好
        fsSync.watch(configPath, { persistent: false }, async (eventType) => {
          if (eventType === 'change') {
            console.log('检测到提示词配置文件变化，正在重新加载...');
            // 添加防抖，避免频繁重载
            clearTimeout(this.reloadTimer);
            this.reloadTimer = setTimeout(async () => {
              await this.reloadPrompts();
            }, 1000);
          }
        });
        console.log('开始监听提示词配置文件变化');
      });
    } catch (error) {
      console.log('无法监听配置文件变化:', error.message);
    }
  }

  // 获取完整的系统提示词配置
  getSystemPromptConfig() {
    if (!this.promptsConfig) {
      return this.getDefaultConfig().systemPrompt;
    }
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

  // 转换数字为阿拉伯数字序号
  getChineseNumber(num) {
    const n = parseInt(num);
    return `${n}.`;
  }
}

module.exports = new PromptService();