const jwt = require('jsonwebtoken');

// Token blacklist for logout
const tokenBlacklist = new Set();

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];

  // Check if token is blacklisted
  if (tokenBlacklist.has(token)) {
    return res.status(401).json({ error: 'Token has been invalidated' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Role-based access control middleware
const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    next();
  };
};

// Function to invalidate token (for logout)
const invalidateToken = (token) => {
  tokenBlacklist.add(token);
  
  // Clean up old tokens periodically (keep last 1000)
  if (tokenBlacklist.size > 1000) {
    const tokensArray = Array.from(tokenBlacklist);
    tokenBlacklist.clear();
    tokensArray.slice(-500).forEach(t => tokenBlacklist.add(t));
  }
};

module.exports = { authMiddleware, requireRole, invalidateToken };