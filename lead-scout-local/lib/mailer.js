import nodemailer from "nodemailer";
import { env } from "./env.js";

export async function sendMail({ to, subject, html }) {
  if (!env.emailEnabled()) return { skipped: true };
  const transport = nodemailer.createTransport(env.smtp());
  await transport.sendMail({ from: env.smtp().auth.user, to, subject, html });
  return { skipped: false };
}

export async function alertAdmin(subject, body) {
  try {
    await sendMail({ to: env.alertTo(), subject: `[Lead Scout ALERT] ${subject}`, html: `<pre>${body}</pre>` });
  } catch (e) {
    console.error("Alert email failed:", e.message);
  }
}
