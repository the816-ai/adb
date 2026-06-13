const buckets = new Map();

const rateLimitDisabled = process.env.RATE_LIMIT_DISABLED === '1'
  || process.env.NODE_ENV !== 'production';

function createRateLimiter({
  windowMs = 60000,
  max = 120,
  keyFn = (req) => req.ip || req.socket?.remoteAddress || 'unknown',
} = {}) {
  return function rateLimit(req, res, next) {
    if (rateLimitDisabled) return next();

    const key = keyFn(req);
    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket || now - bucket.start >= windowMs) {
      bucket = { start: now, count: 0 };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    if (bucket.count > max) {
      return res.status(429).json({
        error: 'Too many requests — thử lại sau',
        retry_after_ms: windowMs - (now - bucket.start),
      });
    }
    return next();
  };
}

const apiReadLimiter = createRateLimiter({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  max: parseInt(process.env.RATE_LIMIT_READ_MAX || '300', 10),
});

const apiWriteLimiter = createRateLimiter({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  max: parseInt(process.env.RATE_LIMIT_WRITE_MAX || '40', 10),
});

module.exports = {
  createRateLimiter,
  apiReadLimiter,
  apiWriteLimiter,
};
