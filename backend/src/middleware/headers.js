const helmet = require('helmet');

class SecurityHeaders {
  static configure(app) {
    // Use helmet for basic security headers
    app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", "wss:", "https:"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          mediaSrc: ["'self'"],
          frameSrc: ["'none'"],
        },
      },
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      }
    }));

    // Additional security headers
    app.use((req, res, next) => {
      // Prevent clickjacking
      res.setHeader('X-Frame-Options', 'DENY');
      
      // Prevent MIME type sniffing
      res.setHeader('X-Content-Type-Options', 'nosniff');
      
      // Enable XSS filter
      res.setHeader('X-XSS-Protection', '1; mode=block');
      
      // Referrer policy
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      
      // Permissions policy
      res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
      
      // Remove server header
      res.removeHeader('X-Powered-By');
      
      next();
    });

    // HTTPS enforcement for production
    if (process.env.NODE_ENV === 'production') {
      app.use((req, res, next) => {
        if (req.header('x-forwarded-proto') !== 'https') {
          return res.redirect(`https://${req.header('host')}${req.url}`);
        }
        next();
      });
    }
  }
}

module.exports = SecurityHeaders;