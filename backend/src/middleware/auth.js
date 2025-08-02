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
    // Try to get token from authorization header
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const decoded = this.verifyToken(token);
      
      if (decoded) {
        ws.userId = decoded.userId;
        ws.wxNickname = decoded.wxNickname;
        return true;
      }
    }

    // Fallback to header-based auth (for backward compatibility)
    // This should be removed in production
    const userId = req.headers['user-id'];
    const wxNickname = req.headers['wx-nickname'];
    
    if (userId && wxNickname) {
      console.warn('Using legacy header authentication. Please upgrade to JWT.');
      ws.userId = userId;
      ws.wxNickname = decodeURIComponent(wxNickname);
      return true;
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