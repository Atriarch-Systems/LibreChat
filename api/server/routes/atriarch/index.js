const express = require('express');
const { requireJwtAuth } = require('~/server/middleware');
const usageController = require('~/server/controllers/atriarch/UsageController');

const router = express.Router();

/**
 * Atriarch fork-only routes. Mounted at /api/atriarch from server/index.js with a single line so
 * the merge surface with upstream stays minimal. Auth uses the same JWT middleware as other /api
 * routes, so the client calls it exactly like any authenticated LibreChat endpoint.
 */
router.get('/usage', requireJwtAuth, usageController);

module.exports = router;
