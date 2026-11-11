// Small text helpers with no dependencies (safe to import in offline tests).

// Telegram rejects messages longer than 4096 characters.
export const TELEGRAM_MAX_TEXT = 4096;

export const clip = (text, max) => {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};
