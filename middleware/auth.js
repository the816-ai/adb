function getApiKey() {
  const key = process.env.API_KEY || process.env.API_SECRET || '';
  return String(key).trim();
}

function isAuthEnabled() {
  return getApiKey().length >= 8;
}

function extractKey(req) {
  const header = req.headers['x-api-key'];
  if (header) return String(header).trim();
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function requireApiKey(req, res, next) {
  if (!isAuthEnabled()) return next();
  const provided = extractKey(req);
  if (provided && provided === getApiKey()) return next();
  return res.status(401).json({
    error: 'Unauthorized — thiếu hoặc sai API key',
    hint: 'Gửi header X-API-Key hoặc Authorization: Bearer <key>',
  });
}

function authStatus() {
  return {
    enabled: isAuthEnabled(),
    method: 'X-API-Key | Authorization Bearer',
  };
}

module.exports = {
  getApiKey,
  isAuthEnabled,
  requireApiKey,
  authStatus,
};
