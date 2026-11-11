// Checks and cleans a website-form submission. Pure functions: no I/O.
// Everything a customer sends is untrusted; only the cleaned `value` is saved.

const MAX_NAME = 200;
const MAX_MESSAGE = 5000;
const MAX_EMAIL = 320;
const MAX_PHONE = 40;

const SUBMISSION_ID = /^[A-Za-z0-9_-]{8,100}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;

// Control characters except tab and newline.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

const str = (v) => (typeof v === "string" ? v : "");

export function normalizeEmail(raw) {
  const email = str(raw).trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL || !EMAIL.test(email)) return null;
  return email;
}

// Philippine mobile numbers in their common local forms, or any number already
// in international format. Returns E.164 ("+639171234567") or null.
export function normalizePhone(raw) {
  const digits = str(raw).trim().replace(/[\s\-().]/g, "");
  if (/^09\d{9}$/.test(digits)) return `+63${digits.slice(1)}`;
  if (/^9\d{9}$/.test(digits)) return `+63${digits}`;
  if (/^639\d{9}$/.test(digits)) return `+${digits}`;
  if (E164.test(digits)) return digits;
  return null;
}

export function validateSubmission(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: { form: "Invalid submission." } };
  }
  const errors = {};

  const fullName = str(body.full_name).replace(CONTROL, "").replace(/\s+/g, " ").trim();
  if (!fullName) errors.full_name = "Please enter your name.";
  else if (fullName.length > MAX_NAME) errors.full_name = `Please use at most ${MAX_NAME} characters.`;

  const message = str(body.message).replace(CONTROL, "").replace(/\r\n?/g, "\n").trim();
  if (!message) errors.message = "Please enter your message.";
  else if (message.length > MAX_MESSAGE) errors.message = `Please use at most ${MAX_MESSAGE} characters.`;

  const emailRaw = str(body.email).trim();
  const emailNormalized = emailRaw ? normalizeEmail(emailRaw) : null;
  if (emailRaw && !emailNormalized) errors.email = "Please enter a valid email address.";

  const phoneRaw = str(body.phone).trim();
  const phoneNormalized = phoneRaw ? normalizePhone(phoneRaw) : null;
  if (phoneRaw && (!phoneNormalized || phoneRaw.length > MAX_PHONE)) {
    errors.phone = "Please enter a valid mobile number, e.g. 0917 123 4567.";
  }

  if (!emailRaw && !phoneRaw) errors.contact = "Please give an email address or a mobile number.";

  if (body.consent !== true) errors.consent = "Please agree to be contacted about your inquiry.";

  const submissionId = str(body.submission_id);
  if (submissionId && !SUBMISSION_ID.test(submissionId)) errors.form = "Invalid submission.";

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    // A filled-in hidden field means a bot, not a person.
    isSpam: str(body.website).trim() !== "",
    value: {
      externalId: submissionId || null,
      fullName,
      email: emailNormalized ? emailRaw.slice(0, MAX_EMAIL) : null,
      emailNormalized,
      phone: phoneNormalized ? phoneRaw : null,
      phoneNormalized,
      message,
    },
  };
}
