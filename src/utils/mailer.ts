
import nodemailer from "nodemailer";

const user = process.env.ETHEREAL_USER;
const pass = process.env.ETHEREAL_PASS;

if (!user || !pass) {
  throw new Error(
    "ETHEREAL_USER and ETHEREAL_PASS must be configured",
  );
}

export const mailer = nodemailer.createTransport({
  host: process.env.ETHEREAL_HOST ?? "smtp.ethereal.email",
  port: Number(process.env.ETHEREAL_PORT ?? 587),
  secure: false,
  auth: { user, pass },
});
