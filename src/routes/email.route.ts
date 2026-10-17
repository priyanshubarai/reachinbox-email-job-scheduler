import { Router } from "express";
import {
  getEmailHandler,
  listEmailsHandler,
} from "../controllers/email.controller.js";
import { validate } from "../middleware/validate.js";
import { idParamSchema } from "../validators/common.validator.js";
import { listEmailsQuerySchema } from "../validators/email.validator.js";

const router = Router();

router.get(
  "/emails",
  validate({ query: listEmailsQuerySchema }),
  listEmailsHandler,
);
router.get("/emails/:id", validate({ params: idParamSchema }), getEmailHandler);

export default router;
