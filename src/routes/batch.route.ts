import { Router } from "express";
import {
  createBatch,
  getBatchHandler,
  listBatchesHandler,
  scheduleBatchHandler,
} from "../controllers/batch.controller.js";
import { validate } from "../middleware/validate.js";
import { idParamSchema } from "../validators/common.validator.js";
import {
  createBatchSchema,
  listBatchesQuerySchema,
} from "../validators/batch.validator.js";

const router = Router();

router.post("/batches", validate({ body: createBatchSchema }), createBatch);
router.get(
  "/batches",
  validate({ query: listBatchesQuerySchema }),
  listBatchesHandler,
);
router.get(
  "/batches/:id",
  validate({ params: idParamSchema }),
  getBatchHandler,
);
router.post(
  "/batches/:id/schedule",
  validate({ params: idParamSchema }),
  scheduleBatchHandler,
);

export default router;
