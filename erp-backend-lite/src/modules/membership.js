// 会员 / 极点路由
import { Router } from 'express';
import config from '../config/index.js';

const router = Router();

// GET /membership/usage-summary
router.get('/membership/usage-summary', (req, res) => {
  const m = config.membership;
  res.json({
    canUse: m.canUse || {},
    usage: m.usage || {},
    caps: m.caps || {},
  });
});

// GET /membership/me
router.get('/membership/me', (req, res) => {
  const m = config.membership;
  res.json({
    tier: m.tier || 'free',
    planName: m.planName || '',
    daysLeft: m.daysLeft ?? 0,
  });
});

// GET /jidian/balance
router.get('/jidian/balance', (req, res) => {
  res.json({ balance: config.membership.jidianBalance ?? 0 });
});

// GET /jidian/pricing
router.get('/jidian/pricing', (req, res) => {
  res.json({
    AI_IMAGE: config.membership.jidianPricing?.AI_IMAGE || { price: 50 },
    _meta: { pointAlias: {} },
  });
});

export default router;
