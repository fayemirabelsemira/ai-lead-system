// Reads settings from environment variables.
// `npm run dev` loads them from the project's .env file.
export function required(name) {
  const value = process.env[name];
  if (!value || value.startsWith("your-")) {
    // Only the NAME is shown, never the value.
    throw new Error(`Missing or placeholder environment variable: ${name}`);
  }
  return value;
}

function optional(name) {
  const value = process.env[name];
  return value && !value.startsWith("your-") ? value : null;
}

const list = (value) =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  supabaseUrl: required("SUPABASE_URL"),
  supabaseSecretKey: required("SUPABASE_SECRET_KEY"),
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  isProduction: process.env.NODE_ENV === "production",
  port: Number(process.env.PORT) || 3000,
  // The address customers use to reach this server, e.g. https://leads.example.com
  // (used to print form links). Defaults to this computer.
  publicBaseUrl: (optional("PUBLIC_BASE_URL") ?? `http://localhost:${Number(process.env.PORT) || 3000}`).replace(/\/+$/, ""),
  // Websites allowed to post to the intake API from a browser, e.g. https://forms.example.com
  intakeAllowedOrigins: list(process.env.INTAKE_ALLOWED_ORIGINS),
  // Set to "true" only when running behind a proxy that sets X-Forwarded-For (most hosts do).
  trustProxy: process.env.TRUST_PROXY === "true",
  // Automatic email (optional). Both must be set to turn the email worker on.
  gmailUser: optional("GMAIL_USER"),
  gmailAppPassword: optional("GMAIL_APP_PASSWORD")?.replace(/\s+/g, ""), // Google shows it with spaces
};
