// Loads .env from the project root (Node 22 built-in). Copy .env.example to .env first.
import { fileURLToPath } from "url";
try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  // no .env file — rely on already-set environment variables
}

const required = ["ANTHROPIC_API_KEY", "BRAVE_API_KEY"];

export function checkEnv() {
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing settings in .env: ${missing.join(", ")}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

export const env = {
  anthropicKey: () => process.env.ANTHROPIC_API_KEY,
  braveKey: () => process.env.BRAVE_API_KEY,
  emailEnabled: () => process.env.EMAIL_ENABLED === "true",
  reportTo: () => process.env.REPORT_TO,
  alertTo: () => process.env.ALERT_TO,
  smtp: () => ({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  }),
};
