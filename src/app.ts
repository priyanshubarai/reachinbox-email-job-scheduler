import express from "express";
import type { Response, Request } from "express";
import dotenv from "dotenv";
import morgan from "morgan";
import helmet from "helmet";
import slowDown from "express-slow-down";
import cors from 'cors';
import router from "./routes/batch.route.js";

dotenv.config();


const limiter = slowDown({
  windowMs: 15 * 60 * 1000, // 5 minutes
  delayAfter: 10, // allow 10 requests per `windowMs` (5 minutes) without slowing them down
  delayMs: (hits) => hits * 200, // add 200 ms of delay to every request after the 10th
  maxDelayMs: 5000, // max global delay of 5 seconds
});

const port = process.env.PORT || 3000;

const app = express();

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "font-src": ["'self'", "external-website.com"],
        "style-src": null,
      },
    },
    referrerPolicy: { policy: "no-referrer" },
    hsts: {
      maxAge: 86400,
      includeSubDomains: false,
    },
    noSniff: false,
    frameguard: { action: "deny" },
  }),
);

const corsOptions = {
  // origin: 'http://example.com',
  // optionsSuccessStatus: 200 // some legacy browsers (IE11, various SmartTVs) choke on 204
}
app.use(cors(corsOptions));
app.use(morgan("dev"));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});
app.use("/api", limiter);
app.use("/api", router);
app.use("/api", (req: Request, res: Response) => {
  return res.status(200).json({ message: "Server is Running👍" });
});


app
  .listen(port, () => {
    console.log(`SERVER AT ${port}`);
  });


  





