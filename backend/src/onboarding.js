// Checks a business file (see business.example.json) before anything is
// written to the database. Pure function: no I/O, so it is tested offline.

const INDUSTRIES = ["REAL_ESTATE", "CLINIC", "HOME_SERVICE", "OTHER"];
const PLACEHOLDER = /REPLACE_ME/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseBusinessFile(input) {
  const errors = [];
  const fail = (msg) => errors.push(msg);
  const f = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (f !== input) fail("The file must contain one JSON object.");

  // Every leftover "REPLACE_ME" from the example is an error, wherever it is.
  const walk = (value, path) => {
    if (typeof value === "string" && PLACEHOLDER.test(value)) fail(`${path} still says REPLACE_ME.`);
    else if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(f, "");

  const text = (key, { required = false, max = 2000 } = {}) => {
    const v = f[key];
    if (v === undefined || v === null || v === "") {
      if (required) fail(`${key} is required.`);
      return null;
    }
    if (typeof v !== "string") return fail(`${key} must be text.`), null;
    const t = v.trim();
    if (required && !t) fail(`${key} is required.`);
    if (t.length > max) fail(`${key} is too long (max ${max} characters).`);
    return t || null;
  };

  const telegramId = (value, label, { allowNegative = false } = {}) => {
    if (!Number.isSafeInteger(value) || value === 0 || (!allowNegative && value < 0)) {
      fail(`${label} must be a number (find it with: npm run add-business -- --show-ids).`);
      return null;
    }
    return value;
  };

  const business = {
    business_name: text("business_name", { required: true, max: 200 }),
    industry: f.industry,
    business_description: text("description", { max: 2000 }),
    business_email: text("email", { max: 320 }),
    business_phone: text("phone", { max: 40 }),
    business_timezone: text("timezone", { max: 64 }) ?? "Asia/Manila",
    pricing_information: text("pricing", { max: 4000 }),
    services: [],
    business_faq: [],
    operating_hours: {},
    telegram_chat_id: telegramId(f.telegram_chat_id, "telegram_chat_id", { allowNegative: true }),
  };

  if (!INDUSTRIES.includes(f.industry)) fail(`industry must be one of: ${INDUSTRIES.join(", ")}.`);
  if (business.business_email && !EMAIL.test(business.business_email)) fail("email is not a valid email address.");

  if (f.services !== undefined) {
    if (!Array.isArray(f.services) || !f.services.every((s) => typeof s === "string" && s.trim()))
      fail("services must be a list of text, e.g. [\"Teeth cleaning\", \"Braces\"].");
    else business.services = f.services.map((s) => s.trim());
  }

  if (f.faq !== undefined) {
    const ok =
      Array.isArray(f.faq) &&
      f.faq.every((x) => x && typeof x.q === "string" && x.q.trim() && typeof x.a === "string" && x.a.trim());
    if (!ok) fail('faq must be a list of {"q": "question", "a": "answer"}, both filled in.');
    else business.business_faq = f.faq.map((x) => ({ q: x.q.trim(), a: x.a.trim() }));
  }

  if (f.operating_hours !== undefined) {
    const h = f.operating_hours;
    const ok = h && typeof h === "object" && !Array.isArray(h) && Object.values(h).every((v) => typeof v === "string");
    if (!ok) fail('operating_hours must look like {"mon-fri": "09:00-18:00", "sat": "09:00-12:00"}.');
    else business.operating_hours = h;
  }

  const o = f.owner && typeof f.owner === "object" ? f.owner : {};
  if (!f.owner) fail("owner is required.");
  const ownerEmail = typeof o.email === "string" ? o.email.trim().toLowerCase() : "";
  if (!EMAIL.test(ownerEmail)) fail("owner.email must be a valid email address.");
  const owner = { email: ownerEmail, telegram_user_id: telegramId(o.telegram_user_id, "owner.telegram_user_id") };

  if (f.automatic_email !== undefined && typeof f.automatic_email !== "boolean")
    fail("automatic_email must be true or false.");

  if (errors.length) return { ok: false, errors: [...new Set(errors)] };
  return { ok: true, business, owner, automaticEmail: f.automatic_email === true };
}

// Sample businesses from migration 006 are named "[TEST] ...".
export const isTestBusiness = (name) => /^\[TEST\]/.test(name ?? "");
