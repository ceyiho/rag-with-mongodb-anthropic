// GET /api/health: whether the server can reach the database. The page calls it when a
// request fails, to tell a stopped server (no reply at all) from an unreachable
// database (503), e.g. after an IP address change that Atlas Network Access refuses.

const express = require('express');
const { ApiError } = require('./errors');

// How long the ping may take. Without a limit, the driver keeps trying for 30 s.
const PING_TIMEOUT_MS = 5000;

module.exports = function healthRoutes(db) {
  const router = express.Router();

  router.get('/health', async (req, res) => {
    try {
      await db.command({ ping: 1 }, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
    } catch (err) {
      console.error('Health check: database unreachable:', err.message);
      throw new ApiError(503, 'dbUnavailable', "The server can't reach the database.");
    }
    res.json({ db: 'ok' });
  });

  return router;
};
