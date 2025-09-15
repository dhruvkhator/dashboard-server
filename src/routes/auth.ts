import { Router } from 'express';
import { reissueInvite, validatePassword, passwordChangeAudit, createInvite, adminResendInvite, listInvites, whoami, finalizeInvite, listOrgs, updateDisplayName } from '../controllers/authController.js';

const router = Router();

router.post('/reissue-invite', reissueInvite);
router.post('/validate-password', validatePassword);
router.post('/password-change-audit', passwordChangeAudit);
router.post('/invite', createInvite);
router.post('/invite/resend', adminResendInvite);
router.get('/invites', listInvites);
router.get('/whoami', whoami);
router.post('/finalize-invite', finalizeInvite);
router.get('/orgs', listOrgs);
router.post('/update-display-name', updateDisplayName);

export default router;
