const jwt = require('jsonwebtoken');

class AuthMiddleware {
  static JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-should-be-in-env';
  static TOKEN_EXPIRY = '24h';

  /**
   * Generate JWT token for user
   */
  static generateToken(userId, wxNickname) {
    return jwt.sign(
      { 
        userId, 
        wxNickname,
        timestamp: Date.now() 
      },
      this.JWT_SECRET,
      { expiresIn: this.TOKEN_EXPIRY }
    );
  }

  /**
   * Verify JWT token
   */
  static verifyToken(token) {
    try {
      return jwt.verify(token, this.JWT_SECRET);
    } catch (error) {
      console.error('JWT verification failed:', error.message);
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
        ws.wxNickname = decoded.wxNickname;
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
}

module.exports = AuthMiddleware;