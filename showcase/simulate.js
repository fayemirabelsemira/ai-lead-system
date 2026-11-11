// SIMULATION, used only when the live AI is unavailable. Simple keyword rules
// that return a result in the same shape as the real analysis, so the rest of
// the workflow can be shown. The page always labels these results "Simulated".

const RX = {
  injection: /\b(ignore|disregard)\b.*\b(instruction|rules|prompt)|system prompt|you are now|act as/i,
  complaint: /unacceptable|complain|refund|angry|terrible|worst|disappointed|leak(ing)?|broke|sira/i,
  medical: /medicine|gamot|pain|aching|masakit|swollen|namamaga|diagnos|infection/i,
  discount: /discount|promo|tawad|less ba|cheaper/i,
  hot: /availab|view(ing)?|visit|book|appointment|schedule|sched|quotation|quote|earliest|reserve|tomorrow|bukas/i,
  warm: /how much|magkano|\bhm\b|price|rate|cost|pwede|accept|payment|installment|hmo/i,
  tagalog: /\b(po|ba|yung|magkano|pwede|kami|muna|sa|ng|naman|opo|lang|ako|mo|ko|kayo)\b/i,
  english: /\b(the|is|can|i|you|my|how|what|please|thanks|need|want)\b/i,
};

const INTENT = {
  REAL_ESTATE: { hot: "PROPERTY_VIEWING", warm: "PROPERTY_PRICE" },
  CLINIC: { hot: "APPOINTMENT_REQUEST", warm: "PRICE_INQUIRY" },
  HOME_SERVICE: { hot: "QUOTATION_REQUEST", warm: "PRICE_INQUIRY" },
};

export function simulateAnalysis(business, text) {
  const lang = RX.tagalog.test(text) ? (RX.english.test(text) ? "TAGLISH" : "TAGALOG") : "ENGLISH";
  const map = INTENT[business.industry] ?? { hot: "SERVICE_REQUEST", warm: "GENERAL_INQUIRY" };
  const base = {
    detected_language: lang, urgency: /asap|urgent|now|today|ngayon/i.test(text) ? "HIGH" : "MEDIUM",
    customer_needs: [], missing_information: [], suggested_reply: null, confidence_level: "MEDIUM",
    needs_human_review: false, escalation_reason: null, injection_attempt: false,
  };

  const review = (score, intent, reason, extra = {}) => ({
    ...base, ...extra, lead_score: score, intent, score_reason: reason,
    needs_human_review: true, escalation_reason: reason,
  });
  if (RX.injection.test(text)) return review("COLD", "SPAM", "The message tried to give the AI instructions.", { injection_attempt: true });
  if (RX.complaint.test(text)) return review("WARM", "COMPLAINT", "The customer has a complaint.", { urgency: "HIGH", customer_needs: ["Resolve the problem"] });
  if (business.industry === "CLINIC" && RX.medical.test(text)) return review("HOT", "OUT_OF_SCOPE", "Asks for medical advice, which only a dentist can give.", { urgency: "HIGH", customer_needs: ["Dental consultation"] });
  if (RX.discount.test(text)) return review("WARM", map.warm, "Asks for a discount, which the owner decides.", { customer_needs: ["Price information", "Discount"] });

  const hot = RX.hot.test(text), warm = RX.warm.test(text);
  const score = hot ? "HOT" : warm ? "WARM" : "COLD";
  const intent = hot ? map.hot : warm ? map.warm : "GENERAL_INQUIRY";
  const reason = hot ? "Asks for a concrete next step (booking, viewing or quote)." : warm ? "Interested and asking about price or terms." : "General or browsing message without a clear next step.";
  const tl = lang !== "ENGLISH";
  const reply = hot
    ? (tl ? `Hi po! Salamat sa inquiry ninyo sa ${business.business_name}. Pwede po ba naming malaman ang preferred date at time ninyo? Ico-confirm po namin agad ang schedule.`
          : `Hi! Thank you for reaching out to ${business.business_name}. Could you share your preferred date and time? We'll confirm the schedule with you shortly.`)
    : warm
      ? (tl ? `Hi po! Salamat sa pag-message sa ${business.business_name}. Ipapadala po namin ang buong detalye ng presyo. May iba pa po ba kayong gustong malaman?`
            : `Hi! Thanks for your message to ${business.business_name}. We'll send you the full pricing details. Is there anything else you'd like to know?`)
      : (tl ? `Hi po! Salamat sa pag-message sa ${business.business_name}. Message lang po kayo kung may tanong kayo.`
            : `Hi! Thanks for your message to ${business.business_name}. Feel free to ask if you have any questions.`);
  return {
    ...base, lead_score: score, intent, score_reason: reason, suggested_reply: reply,
    customer_needs: hot ? ["Schedule a next step"] : warm ? ["Price information"] : [],
    missing_information: hot ? ["Preferred date and time"] : [],
  };
}
