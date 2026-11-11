// The only file that talks to Gmail. To use another provider later (e.g.
// Resend), add a sibling file with the same sendEmail() shape.
import nodemailer from "nodemailer";

export function createGmailSender({ user, appPassword }) {
  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true, // TLS from the first byte
    auth: { user, pass: appPassword },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });

  return {
    fromAddress: user,
    // Resolves with Gmail's message id, or throws a nodemailer error.
    async sendEmail(message) {
      const info = await transport.sendMail(message);
      return info.messageId ?? null;
    },
    // Checks the login without sending anything.
    verify: () => transport.verify(),
  };
}
