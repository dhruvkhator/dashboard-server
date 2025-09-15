import { Router } from 'express';
import { updateAgent, updateTheme, createAgent, listAllAgents, getAgentById, getLatestTheme } from '../controllers/agentsController.js';

const router = Router();

router.post('/agents/update', updateAgent);
router.post('/themes/update', updateTheme);
router.post('/agents/create', createAgent);
router.get('/agents', listAllAgents);
router.get('/agents/:id', getAgentById);
router.get('/themes/:agentId', getLatestTheme);

export default router;
