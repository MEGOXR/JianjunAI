const jwt = require('jsonwebtoken');

class AuthMiddleware {
  static JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-should-be-in-env';
  static TOKEN_EXPIRY = '24h';

  /**
   * Generate JWT token for user
   */
  static generateToken(userId) {
    const payload = { 
      userId, 
      timestamp: Date.now() 
    };
    
    console.log('🔑 生成JWT Token:');
    console.log('  UserId:', userId);
    console.log('  Payload:', payload);
    console.log('  JWT_SECRET (前20字符):', this.JWT_SECRET.substring(0, 20) + '...');
    
    const token = jwt.sign(payload, this.JWT_SECRET, { expiresIn: this.TOKEN_EXPIRY });
    
    console.log('✅ Token生成成功 (前50字符):', token.substring(0, 50) + '...');
    
    return token;
  }

  /**
   * Verify JWT token
   */
  static verifyToken(token) {
    try {
      console.log('🔐 JWT验证开始:');
      console.log('  Token (前50字符):', token.substring(0, 50) + '...');
      console.log('  JWT_SECRET (前20字符):', this.JWT_SECRET.substring(0, 20) + '...');
      
      const decoded = jwt.verify(token, this.JWT_SECRET);
      console.log('✅ JWT验证成功:', {
        userId: decoded.userId,
        timestamp: decoded.timestamp,
        exp: decoded.exp,
        iat: decoded.iat
      });
      return decoded;
    } catch (error) {
      console.error('❌ JWT verification failed:', {
        message: error.message,
        name: error.name,
        tokenPreview: token.substring(0, 50) + '...',
        secretPreview: this.JWT_SECRET.substring(0, 20) + '...'
      });
      return null;
    }
  }

  /**
   * Extract and verify token from request headers
   */
  static authenticateRequest(req) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }

    const token = authHeader.substring(7);
    return this.verifyToken(token);
  }

  /**
   * WebSocket authentication
   */
  static authenticateWebSocket(ws, req) {
    // Get token from authorization header
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const decoded = this.verifyToken(token);
      
      if (decoded) {
        ws.userId = decoded.userId;
        console.log(`JWT authentication successful for user: ${decoded.userId}`);
        return true;
      } else {
        console.warn('JWT token verification failed');
      }
    } else {
      console.warn('No Bearer token provided in WebSocket connection');
    }

    return false;
  }

  /**
   * Express middleware for API endpoints
   */
  static requireAuth(req, res, next) {
    const decoded = AuthMiddleware.authenticateRequest(req);
    
    if (!decoded) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    req.user = decoded;
    next();
  }

  /**
   * Express middleware for token authentication (alias for requireAuth)
   */
  static authenticateToken(req, res, next) {
    return AuthMiddleware.requireAuth(req, res, next);
  }
}

module.exports = AuthMiddleware;