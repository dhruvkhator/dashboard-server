import express from 'express';
import path from 'node:path';
import cors from 'cors';

import authRoutes from './routes/auth.js';
// Access (edit-grants) routes deferred; see PRD Deferred and AUTH.md §15
// import accessRoutes from './routes/access.js';
import agentsRoutes from './routes/agents.js';
import widgetRoutes from './routes/widget.js';




export function createApp() {
  const app = express();
  app.use(cors());
  // Increase JSON body limit to accommodate theme configs (e.g., base64 logos)
  app.use(express.json({ limit: '5mb' }));

  // Minimal test widget loader served as a single file
  // Serve static assets from server/public (for widget.js deployment)
  app.use(express.static(path.join(process.cwd(), 'public')));


  app.use('/auth', authRoutes);
  // Edit-access feature deferred; endpoints disabled for now
  // app.use('/access', accessRoutes);
  app.use('/', agentsRoutes);
  app.use('/', widgetRoutes);

  app.get('/health', (_req, res) => res.json({ ok: true }));

  return app;
}
