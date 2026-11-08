// Reads settings from environment variables.
// `npm run dev` loads them from the project's .env file.
function required(name) {
  const value = process.env[name];
  if (!value || value.startsWith("your-")) {
    // Only the NAME is shown, never the value.
    throw new Error(`Missing or placeholder environment variable: ${name}`);
  }
  return value;
}

export const config = {
  supabaseUrl: required("SUPABASE_URL"),
  supabaseSecretKey: required("SUPABASE_SECRET_KEY"),
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
};
