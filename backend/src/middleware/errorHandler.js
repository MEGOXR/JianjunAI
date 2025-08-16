class ErrorHandler {
  /**
   * Express error handling middleware
   */
  static expressErrorHandler(err, req, res, next) {
    console.error('Express Error:', {
      message: err.message,
      stack: err.stack,
      url: req.url,
      method: req.method,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      timestamp: new Date().toISOString()
    });

    // Don't leak error details in production
    const isDevelopment = process.env.NODE_ENV !== 'production';
    
    // Handle different types of errors
    if (err.name === 'ValidationError') {
      return res.status(400).json({
        error: 'Validation Error',
        message: isDevelopment ? err.message : 'Invalid input data'
      });
    }

    if (err.name === 'UnauthorizedError' || err.status === 401) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required'
      });
    }

    if (err.name === 'ForbiddenError' || err.status === 403) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Access denied'
      });
    }

    if (err.status === 404) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Resource not found'
      });
    }

    if (err.name === 'RateLimitError' || err.status === 429) {
      return res.status(429).json({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please try again later.'
      });
    }

    // Default to 500 server error
    res.status(err.status || 500).json({
      error: 'Internal Server Error',
      message: isDevelopment ? err.message : 'Something went wrong',
      ...(isDevelopment && { stack: err.stack })
    });
  }

  /**
   * Handle 404 errors
   */
  static notFoundHandler(req, res, next) {
    const error = new Error(`Resource not found - ${req.originalUrl}`);
    error.status = 404;
    next(error);
  }

  /**
   * WebSocket error handler
   */
  static handleWebSocketError(ws, error, context = 'Unknown') {
    console.error('WebSocket Error:', {
      context,
      message: error.message,
      stack: error.stack,
      userId: ws.userId || 'Unknown',
      timestamp: new Date().toISOString()
    });

    try {
      if (ws.readyState === ws.OPEN) {
        const errorMessage = this.getWebSocketErrorMessage(error);
        ws.send(JSON.stringify({
          error: errorMessage.error,
          details: errorMessage.message,  // 前端期望 details 字段
          message: errorMessage.message,
          timestamp: Date.now()
        }));
      }
    } catch (sendError) {
      console.error('Failed to send error message to WebSocket:', sendError);
    }
  }

  /**
   * Get appropriate error message for WebSocket
   */
  static getWebSocketErrorMessage(error) {
    const isDevelopment = process.env.NODE_ENV !== 'production';
    
    // Azure OpenAI specific errors
    if (error.message.includes('content filter')) {
      return {
        error: 'Content Filter',
        message: '您的消息包含敏感内容，请重新表述您的问题。'
      };
    }

    if (error.message.includes('quota') || error.message.includes('rate limit')) {
      return {
        error: 'Rate Limit',
        message: '服务繁忙，请稍后再试。'
      };
    }

    if (error.message.includes('token')) {
      return {
        error: 'Token Limit',
        message: '消息过长，请缩短您的问题。'
      };
    }

    if (error.message.includes('authentication') || error.message.includes('unauthorized')) {
      return {
        error: 'Authentication Error',
        message: '认证失败，请重新连接。'
      };
    }

    // Network errors
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return {
        error: 'Network Error',
        message: '网络连接失败，请检查您的网络。'
      };
    }

    if (error.code === 'ETIMEDOUT') {
      return {
        error: 'Timeout',
        message: '请求超时，请重试。'
      };
    }

    // Default error
    return {
      error: 'Server Error',
      message: isDevelopment ? (error.message || 'Unknown error') : '服务器内部错误，请稍后再试。'
    };
  }

  /**
   * Async wrapper for route handlers
   */
  static asyncWrapper(fn) {
    return (req, res, next) => {
      Promise.resolve(fn(req, res, next)).catch(next);
    };
  }

  /**
   * Log unhandled errors
   */
  static setupGlobalErrorHandlers() {
    process.on('uncaughtException', (error) => {
      console.error('Uncaught Exception:', {
        message: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString()
      });
      
      // In production, gracefully shut down
      if (process.env.NODE_ENV === 'production') {
        console.error('Shutting down due to uncaught exception');
        process.exit(1);
      }
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Rejection:', {
        reason: reason?.message || reason,
        stack: reason?.stack,
        timestamp: new Date().toISOString()
      });
      
      // In production, gracefully shut down
      if (process.env.NODE_ENV === 'production') {
        console.error('Shutting down due to unhandled rejection');
        process.exit(1);
      }
    });
  }

  /**
   * Create specific error types
   */
  static createValidationError(message) {
    const error = new Error(message);
    error.name = 'ValidationError';
    error.status = 400;
    return error;
  }

  static createAuthError(message = 'Authentication required') {
    const error = new Error(message);
    error.name = 'UnauthorizedError';
    error.status = 401;
    return error;
  }

  static createForbiddenError(message = 'Access denied') {
    const error = new Error(message);
    error.name = 'ForbiddenError';
    error.status = 403;
    return error;
  }

  static createNotFoundError(message = 'Resource not found') {
    const error = new Error(message);
    error.status = 404;
    return error;
  }

  static createRateLimitError(message = 'Rate limit exceeded') {
    const error = new Error(message);
    error.name = 'RateLimitError';
    error.status = 429;
    return error;
  }
}

module.exports = ErrorHandler;