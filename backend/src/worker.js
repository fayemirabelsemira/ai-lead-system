// Background worker: takes queued jobs from the database and runs them.
// All I/O comes in through `deps`, so this file can be tested offline.
//
// ANALYZE_LEAD is written so a retry never repeats finished work:
//   1. a completed analysis already saved  -> the AI is not called again
//   2. the lead is no longer NEW            -> the owner was already sent a card
//   3. last attempt failed                  -> the owner is told to handle it by hand

const BASE_RETRY_SECONDS = 60;

export function createWorker(deps, { workerId = "worker", intervalMs = 5000, batchSize = 5, log = console } = {}) {
  let timer = null;
  let running = false;
  let current = Promise.resolve();

  async function analyzeLead(job) {
    const leadId = job.payload?.lead_id;
    const lead = leadId ? await deps.loadLead(job.business_id, leadId) : null;
    if (!lead) return; // deleted since it was queued: nothing to do
    if (lead.conversation_status !== "NEW") return; // card already sent

    const isLastAttempt = job.attempts >= job.max_attempts;

    if (!(await deps.hasCompletedAnalysis(job.business_id, leadId))) {
      const business = await deps.loadBusiness(job.business_id);
      const used = await deps.aiRequestsLast24h(job.business_id);
      if (used >= business.settings.ai_daily_request_limit) {
        await deps.markLeadNeedsReview(job.business_id, leadId);
        await deps.sendManualNotice(
          leadId,
          "The daily AI limit for this business was reached, so this inquiry was not analyzed."
        );
        return;
      }

      const result = await deps.analyze({
        business,
        inquiry: lead.original_message,
        maxLength: business.settings.max_inquiry_length,
      });
      await deps.saveAnalysis(job.business_id, leadId, job.payload?.interaction_id ?? null, result);

      if (result.status !== "COMPLETED") {
        if (!isLastAttempt) throw new Error(`AI analysis failed: ${result.errorMessage}`);
        await deps.sendManualNotice(leadId, "The AI could not analyze this inquiry after several tries.");
        return;
      }
    }

    try {
      await deps.sendLeadCard(leadId);
    } catch (err) {
      // Another path already created the reply: the owner has a card.
      if (/already has a reply/.test(err.message)) return;
      throw err;
    }
  }

  const handlers = { ANALYZE_LEAD: analyzeLead };

  async function runJob(job) {
    try {
      const handler = handlers[job.job_type];
      if (!handler) throw new Error(`Unknown job type ${job.job_type}`);
      await handler(job);
      await deps.finishJob(job.id, { status: "SUCCEEDED" });
    } catch (err) {
      const dead = job.attempts >= job.max_attempts;
      log.error(`Job ${job.id} (${job.job_type}) failed on attempt ${job.attempts}:`, err.message);
      await deps
        .finishJob(job.id, {
          status: dead ? "DEAD" : "PENDING",
          error: err.message,
          retryInSeconds: BASE_RETRY_SECONDS * 2 ** (job.attempts - 1),
        })
        .catch((e) => log.error(`Could not record the failure of job ${job.id}:`, e.message));
    }
  }

  async function tick() {
    const jobs = await deps.claimJobs(workerId, batchSize);
    for (const job of jobs) await runJob(job);
    return jobs.length;
  }

  function schedule() {
    if (!running) return;
    timer = setTimeout(() => {
      current = tick()
        .catch((err) => log.error("Worker error:", err.message))
        .finally(schedule);
    }, intervalMs);
  }

  return {
    tick,
    start() {
      running = true;
      log.log("Job worker started.");
      schedule();
    },
    // Resolves once the job in progress (if any) has finished.
    async stop() {
      running = false;
      clearTimeout(timer);
      await current;
    },
  };
}
