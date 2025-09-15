import { Router } from 'express';
import { updateAgent, updateTheme, createAgent, listAllAgents, getAgentById, getLatestTheme, getPublicAgentByPublicId, getPublicThemeByPublicId } from '../controllers/agentsController.js';

const router = Router();

router.post('/agents/update', updateAgent);
router.post('/themes/update', updateTheme);
router.post('/agents/create', createAgent);
router.get('/agents', listAllAgents);
router.get('/agents/:id', getAgentById);
router.get('/themes/:agentId', getLatestTheme);

// Public (by public_id)
router.get('/pub/agents/:publicId', getPublicAgentByPublicId);
router.get('/pub/themes/:publicId', getPublicThemeByPublicId);

export default router;
