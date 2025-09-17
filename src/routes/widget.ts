import { Router } from 'express';
import { getWidgetConfig } from '../controllers/widget/configController.js';
import { chatStream } from '../controllers/widget/streamController.js';
import { postIngestMessages } from '../controllers/widget/ingestController.js';
import { postWidgetEvents } from '../controllers/widget/eventsController.js';

const router = Router();

// Implemented now
router.get('/v1/widget/config', getWidgetConfig);
router.get('/chat/stream', chatStream);

// Implement next
router.post('/v1/widget/events', postWidgetEvents);
router.post('/v1/ingest/messages', postIngestMessages);

// Minimal CORS preflight handling for implemented endpoints (global cors() exists)
router.options('/v1/widget/config', (_req, res) => res.status(204).end());
router.options('/chat/stream', (_req, res) => res.status(204).end());
router.options('/v1/widget/events', (_req, res) => res.status(204).end());
router.options('/v1/ingest/messages', (_req, res) => res.status(204).end());

export default router;
