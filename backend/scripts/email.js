// Automatic email setup helper.
//   npm run email -- test <your-email>       check the Gmail login and send yourself a test email
//   npm run email -- on <business-uuid>      approved replies to email leads are sent automatically
//   npm run email -- off <business-uuid>     back to copy-and-send for everyone
import { config } from "../src/config.js";
import { supabase } from "../src/supabase.js";
import { createGmailSender } from "../src/email/gmail.js";
import { composeReplyEmail } from "../src/email/compose.js";
import { normalizeEmail } from "../src/intake/validate.js";

const [command, arg] = process.argv.slice(2);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function usage() {
  console.error("Usage: npm run email -- test <your-email> | on <business-uuid> | off <business-uuid>");
  process.exit(1);
}

function requireGmail() {
  if (!config.gmailUser || !config.gmailAppPassword) {
    throw new Error("Set GMAIL_USER and GMAIL_APP_PASSWORD in .env first.");
  }
  return createGmailSender({ user: config.gmailUser, appPassword: config.gmailAppPassword });
}

try {
  if (command === "test") {
    const to = normalizeEmail(arg);
    if (!to) usage();
    const sender = requireGmail();
    await sender.verify();
    console.log(`Gmail login OK for ${config.gmailUser}.`);
    await sender.sendEmail(
      composeReplyEmail({
        businessName: "Lead Assistant test",
        fromAddress: sender.fromAddress,
        toEmail: to,
        reply: "This is a test email from your lead system. If you can read this, automatic email works.",
      })
    );
    console.log(`Test email sent to ${to}. Check that inbox (and the spam folder).`);
  } else if (command === "on" || command === "off") {
    if (!UUID.test(arg ?? "")) usage();
    if (command === "on") requireGmail();
    const { data, error } = await supabase
      .from("business_settings")
      .update({ email_delivery_enabled: command === "on" })
      .eq("business_id", arg)
      .select("business_id");
    if (error) throw new Error(error.message);
    if (!data.length) throw new Error("No business with that id.");
    console.log(
      command === "on"
        ? "Automatic email is ON for this business. Approved replies to leads with an email are sent from Gmail."
        : "Automatic email is OFF for this business. Every approved reply uses copy-and-send."
    );
  } else {
    usage();
  }
} catch (err) {
  // nodemailer errors never include the password.
  console.error("Failed:", err.message);
  if (err.code === "EAUTH") {
    console.error("Gmail rejected the login. Check GMAIL_USER and that GMAIL_APP_PASSWORD is an App Password (not your normal password).");
  }
  process.exitCode = 1;
}
