// Builds the email for an approved reply. Pure function: tested offline.
// Plain text only: no HTML, so nothing in the reply can be rendered as markup.

// Header values must never contain line breaks (header injection).
const oneLine = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();

export function composeReplyEmail({ businessName, fromAddress, toEmail, reply }) {
  const name = oneLine(businessName).slice(0, 100) || "Our team";
  return {
    // nodemailer quotes and encodes the display name safely.
    from: { name, address: fromAddress },
    to: toEmail,
    subject: `Re: your inquiry to ${name}`,
    text: `${reply.trim()}\n\n— ${name}`,
  };
}

// Decides what to do after a failed send, without risking a double send.
//   RETRY       the email definitely did not go out (try again later)
//   FAILED      it will never work (e.g. the address does not exist)
//   NEEDS_CHECK it may or may not have gone out: a person must check
export function classifySendError(err) {
  const code = err?.responseCode;
  if (typeof code === "number") {
    if (code >= 500 && err?.code !== "EAUTH") return "FAILED";
    if (code >= 400) return "RETRY";
  }
  if (err?.code === "EENVELOPE") return "FAILED"; // the address itself is unusable
  // Failures before the message was handed over: safe to retry.
  // (EAUTH = wrong Gmail app password: retried so a fixed password still delivers.)
  if (["EAUTH", "EDNS", "ECONNECTION", "ECONNREFUSED", "ENOTFOUND"].includes(err?.code)) {
    return "RETRY";
  }
  return "NEEDS_CHECK";
}
