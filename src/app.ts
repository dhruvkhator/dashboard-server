import express from 'express';
import cors from 'cors';

import authRoutes from './routes/auth.js';
// Access (edit-grants) routes deferred; see PRD Deferred and AUTH.md §15
// import accessRoutes from './routes/access.js';
import agentsRoutes from './routes/agents.js';




export function createApp() {
  const app = express();
  app.use(cors());
  // Increase JSON body limit to accommodate theme configs (e.g., base64 logos)
  app.use(express.json({ limit: '5mb' }));

  // Minimal test widget loader served as a single file


  app.use('/auth', authRoutes);
  // Edit-access feature deferred; endpoints disabled for now
  // app.use('/access', accessRoutes);
  app.use('/', agentsRoutes);

  app.get('/health', (_req, res) => res.json({ ok: true }));

  return app;
}
