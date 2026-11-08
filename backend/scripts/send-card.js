import { sendLeadCard } from "../src/approvals.js";

// Default: Maria Santos from the test data. Pass another lead id to use it.
const leadId = process.argv[2] ?? "11111111-1111-4111-8111-111111111111";

if (!/^[0-9a-f-]{36}$/.test(leadId)) {
  console.error("Usage: npm run send-card -- <lead-uuid>");
  process.exit(1);
}

try {
  const result = await sendLeadCard(leadId);
  console.log(result.escalated ? "Escalation notice sent." : "Approval card sent.");
} catch (err) {
  console.error("Failed:", err.message);
  process.exitCode = 1;
}
