// The "ready to send" message the owner copies from after approving.
// Pure function: no I/O, so it is tested offline.
//
// The reply goes in a `pre` entity, so tapping it in Telegram copies it.
// Formatting is applied with `entities` (exact character ranges), never
// parse_mode, so nothing the customer or AI wrote can inject formatting.
import { clip, TELEGRAM_MAX_TEXT } from "./text.js";

export function buildCopyMessage(
  lead,
  reply,
  {
    title = "📤 READY TO SEND",
    instruction = "Tap the reply below to copy it, then send it to the customer yourself.",
  } = {}
) {
  const head = [
    title,
    instruction,
    "",
    `To: ${clip(lead.full_name, 200)}`,
    `Phone: ${lead.phone ?? "not provided"}`,
    `Email: ${lead.email ?? "not provided"}`,
    "",
    "",
  ].join("\n");
  const tail = '\n\nAfter you send it, tap "I sent it".';

  // The reply is never clipped; the header is small enough that it always fits.
  const body = clip(reply, TELEGRAM_MAX_TEXT - head.length - tail.length);
  return {
    text: head + body + tail,
    // Offsets are in UTF-16 code units, which is also how JS measures strings.
    entities: [{ type: "pre", offset: head.length, length: body.length }],
  };
}
