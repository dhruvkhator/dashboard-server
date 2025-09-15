import { Router } from 'express';
import { approveAccess, requestAccess, revokeAccess, activeFor } from '../controllers/accessController.js';

const router = Router();

router.post('/request', requestAccess);
router.post('/approve', approveAccess);
router.post('/revoke', revokeAccess);
router.post('/active-for', activeFor);

export default router;
