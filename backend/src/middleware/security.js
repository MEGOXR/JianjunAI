const rateLimit = new Map();

class SecurityMiddleware {
  // 验证userId格式
  static isValidUserId(userId) {
    if (!userId || typeof userId !== 'string') {
      return false;
    }
    return userId.match(/^user_[a-zA-Z0-9_]+$/) && userId.length <= 50;
  }

  // 简单的速率限制
  static checkRateLimit(userId, windowMs = 60000, maxRequests = 60) {
    const now = Date.now();
    
    if (!rateLimit.has(userId)) {
      rateLimit.set(userId, { count: 1, resetTime: now + windowMs });
      return true;
    }
    
    const userLimit = rateLimit.get(userId);
    
    if (now > userLimit.resetTime) {
      // 重置窗口
      rateLimit.set(userId, { count: 1, resetTime: now + windowMs });
      return true;
    }
    
    if (userLimit.count >= maxRequests) {
      return false;
    }
    
    userLimit.count++;
    return true;
  }

  // 清理过期的速率限制记录
  static cleanupRateLimit() {
    const now = Date.now();
    for (const [userId, limit] of rateLimit.entries()) {
      if (now > limit.resetTime) {
        rateLimit.delete(userId);
      }
    }
  }

  // 验证输入内容
  static validateInput(input) {
    if (!input || typeof input !== 'string') {
      return { valid: false, error: '输入内容无效' };
    }
    
    if (input.length > 2000) {
      return { valid: false, error: '输入内容过长' };
    }
    
    // 检查恶意内容（简单示例）
    const maliciousPatterns = [
      /<script/i,
      /javascript:/i,
      /on\w+\s*=/i
    ];
    
    for (const pattern of maliciousPatterns) {
      if (pattern.test(input)) {
        return { valid: false, error: '输入包含不允许的内容' };
      }
    }
    
    return { valid: true };
  }

  // XSS防护 - 清理用户输入
  static sanitizeInput(input) {
    if (typeof input !== 'string') return '';
    
    return input
      .replace(/[<>]/g, '') // 移除尖括号
      .replace(/javascript:/gi, '') // 移除javascript协议
      .trim()
      .substring(0, 1000); // 限制长度
  }
}

// 定期清理速率限制记录
setInterval(() => {
  SecurityMiddleware.cleanupRateLimit();
}, 5 * 60 * 1000); // 每5分钟清理一次

module.exports = SecurityMiddleware;