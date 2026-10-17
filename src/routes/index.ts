import { Router } from "express";
import batchRouter from "./batch.route.js";
import emailRouter from "./email.route.js";
import dashboardRouter from "./dashboard.route.js";

/** All `/api` routes. Mounted once, after the rate limiter and auth. */
const router = Router();

router.use(batchRouter);
router.use(emailRouter);
router.use(dashboardRouter);

export default router;
