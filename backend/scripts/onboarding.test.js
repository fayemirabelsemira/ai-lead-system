// Offline tests for the business file checker used by `npm run add-business`.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseBusinessFile, isTestBusiness } from "../src/onboarding.js";

const good = () => ({
  business_name: " Bayanihan Dental ",
  industry: "CLINIC",
  description: "Family dental clinic in Quezon City.",
  email: "",
  services: ["Cleaning", " Braces "],
  pricing: "Cleaning: PHP 1,200.",
  faq: [{ q: "Do you accept HMO?", a: "Yes, Maxicare and Intellicare." }],
  operating_hours: { "mon-sat": "09:00-18:00" },
  telegram_chat_id: 123456789,
  owner: { email: "Owner@Example.com", telegram_user_id: 123456789 },
  automatic_email: true,
});

test("a complete file is accepted and tidied", () => {
  const r = parseBusinessFile(good());
  assert.equal(r.ok, true);
  assert.equal(r.business.business_name, "Bayanihan Dental");
  assert.deepEqual(r.business.services, ["Cleaning", "Braces"]);
  assert.equal(r.business.business_email, null);
  assert.equal(r.business.business_timezone, "Asia/Manila");
  assert.equal(r.owner.email, "owner@example.com");
  assert.equal(r.automaticEmail, true);
});

test("the untouched example file is refused, naming every placeholder", () => {
  const example = JSON.parse(readFileSync(new URL("../business.example.json", import.meta.url), "utf8"));
  const r = parseBusinessFile(example);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("business_name still says REPLACE_ME")));
  assert.ok(r.errors.some((e) => e.includes("faq.0.q")));
  assert.ok(r.errors.some((e) => e.startsWith("telegram_chat_id")));
  assert.ok(r.errors.some((e) => e.startsWith("owner.telegram_user_id")));
});

test("wrong shapes are explained", () => {
  const bad = { ...good(), industry: "BAKERY", services: "Cleaning", faq: [{ q: "Hi?" }], operating_hours: ["9-5"] };
  const r = parseBusinessFile(bad);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 4);
});

test("a group chat id may be negative, a user id may not", () => {
  assert.equal(parseBusinessFile({ ...good(), telegram_chat_id: -1001234 }).ok, true);
  assert.equal(parseBusinessFile({ ...good(), owner: { email: "a@b.co", telegram_user_id: -5 } }).ok, false);
  assert.equal(parseBusinessFile({ ...good(), telegram_chat_id: "123" }).ok, false);
});

test("sample businesses are recognised by their [TEST] name", () => {
  assert.equal(isTestBusiness("[TEST] Sampaguita Realty"), true);
  assert.equal(isTestBusiness("Sampaguita Realty"), false);
});
