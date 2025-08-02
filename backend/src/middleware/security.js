const rateLimit = new Map();
const crypto = require('crypto');

class SecurityMiddleware {
  // 验证userId格式 - 增强安全性
  static isValidUserId(userId) {
    if (!userId || typeof userId !== 'string') {
      return false;
    }
    // 更严格的userId验证，防止路径遍历攻击
    return /^user_[a-zA-Z0-9]{10,30}$/.test(userId) && 
           !userId.includes('..') && 
           !userId.includes('/') && 
           !userId.includes('\\');
  }

  // 增强的速率限制
  static checkRateLimit(userId, windowMs = 60000, maxRequests = 60) {
    const now = Date.now();
    const key = crypto.createHash('sha256').update(userId).digest('hex');
    
    if (!rateLimit.has(key)) {
      rateLimit.set(key, { 
        count: 1, 
        resetTime: now + windowMs,
        firstRequest: now,
        violations: 0 
      });
      return true;
    }
    
    const userLimit = rateLimit.get(key);
    
    if (now > userLimit.resetTime) {
      // 重置窗口
      rateLimit.set(key, { 
        count: 1, 
        resetTime: now + windowMs,
        firstRequest: now,
        violations: userLimit.violations 
      });
      return true;
    }
    
    if (userLimit.count >= maxRequests) {
      userLimit.violations++;
      // 如果违规次数过多，延长限制时间
      if (userLimit.violations > 3) {
        userLimit.resetTime = now + (windowMs * 2);
      }
      return false;
    }
    
    userLimit.count++;
    return true;
  }

  // 清理过期的速率限制记录
  static cleanupRateLimit() {
    const now = Date.now();
    for (const [key, limit] of rateLimit.entries()) {
      if (now > limit.resetTime + 300000) { // 5分钟缓冲期
        rateLimit.delete(key);
      }
    }
  }

  // 增强的输入验证
  static validateInput(input) {
    if (!input || typeof input !== 'string') {
      return { valid: false, error: '输入内容无效' };
    }
    
    // Unicode规范化，防止Unicode攻击
    const normalizedInput = input.normalize('NFC');
    
    if (normalizedInput.length > 1500) {
      return { valid: false, error: '输入内容过长' };
    }
    
    // 增强的恶意内容检测
    const maliciousPatterns = [
      // XSS攻击模式
      /<script[^>]*>[\s\S]*?<\/script>/gi,
      /<iframe[^>]*>[\s\S]*?<\/iframe>/gi,
      /<object[^>]*>[\s\S]*?<\/object>/gi,
      /<embed[^>]*>/gi,
      /<link[^>]*>/gi,
      /javascript:/gi,
      /vbscript:/gi,
      /on\w+\s*=\s*["'][^"']*["']/gi,
      /on\w+\s*=\s*[^\s>]+/gi,
      
      // SQL注入模式（虽然不使用SQL，但仍要防范）
      /(\b(union|select|insert|update|delete|drop|create|alter|exec|execute)\b)/gi,
      
      // 命令注入模式
      /[;&|`$()]/g,
      
      // 路径遍历
      /\.\.[\\\/]/g,
      
      // 特殊字符组合
      /<!\-\-[\s\S]*?\-\->/g,
      /\x00/g, // NULL字符
    ];
    
    for (const pattern of maliciousPatterns) {
      if (pattern.test(normalizedInput)) {
        console.warn(`Malicious pattern detected: ${pattern}`);
        return { valid: false, error: '输入包含不允许的内容' };
      }
    }
    
    // 检查医疗相关的危险内容
    const medicalDangerPatterns = [
      /自杀|自残|结束生命/gi,
      /非法药物|毒品/gi,
      /暴力|伤害他人/gi
    ];
    
    for (const pattern of medicalDangerPatterns) {
      if (pattern.test(normalizedInput)) {
        return { valid: false, error: '检测到潜在危险内容，请寻求专业帮助' };
      }
    }
    
    return { valid: true };
  }

  // 增强的XSS防护 - 清理用户输入
  static sanitizeInput(input) {
    if (typeof input !== 'string') return '';
    
    // Unicode规范化
    let sanitized = input.normalize('NFC');
    
    // HTML实体编码
    const htmlEntities = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#x27;',
      '/': '&#x2F;',
    };
    
    sanitized = sanitized.replace(/[&<>"'\/]/g, char => htmlEntities[char]);
    
    // 移除所有控制字符（除了常见的空白字符）
    sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    
    // 移除零宽字符
    sanitized = sanitized.replace(/[\u200B-\u200D\uFEFF]/g, '');
    
    // 限制长度
    sanitized = sanitized.trim().substring(0, 1000);
    
    return sanitized;
  }
  
  // 医疗内容专用清理
  static sanitizeMedicalContent(input) {
    if (typeof input !== 'string') return '';
    
    // 先进行基础清理
    let sanitized = this.sanitizeInput(input);
    
    // 保留医疗术语但移除潜在危险内容
    // 这里可以根据实际需要添加更多医疗相关的清理规则
    
    return sanitized;
  }
  
  // 验证和清理微信昵称
  static sanitizeWxNickname(nickname) {
    if (typeof nickname !== 'string') return '用户';
    
    // 微信昵称可能包含emoji，需要特殊处理
    let sanitized = nickname.normalize('NFC');
    
    // 移除潜在的XSS攻击向量，但保留emoji
    sanitized = sanitized
      .replace(/[<>'"]/g, '')
      .replace(/javascript:/gi, '')
      .trim()
      .substring(0, 50);
    
    return sanitized || '用户';
  }
  
  // 生成安全的会话ID
  static generateSecureSessionId() {
    return crypto.randomBytes(32).toString('hex');
  }
  
  // 验证请求来源
  static validateOrigin(origin, allowedOrigins = []) {
    if (!origin) return false;
    
    // 默认允许的来源
    const defaultAllowed = [
      'https://servicewechat.com', // 微信小程序
      'http://localhost:3000', // 本地开发
      'https://mego-xr.com' // 生产环境
    ];
    
    const allAllowed = [...defaultAllowed, ...allowedOrigins];
    return allAllowed.some(allowed => origin.startsWith(allowed));
  }
}

// 定期清理速率限制记录
setInterval(() => {
  SecurityMiddleware.cleanupRateLimit();
}, 5 * 60 * 1000); // 每5分钟清理一次

module.exports = SecurityMiddleware;