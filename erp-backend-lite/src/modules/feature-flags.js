// 灰度路由
import { Router } from 'express';
import config from '../config/index.js';

const router = Router();

// GET /feature-flags/me
router.get('/feature-flags/me', (req, res) => {
  res.json(config.featureFlags);
});

export default router;
