import { Router } from "express";
import { createBatch } from "../controllers/batch.controller.js";

const router = Router();

router.post("/batches", createBatch);

export default router;
