-- 006_test_data.sql
-- Requires 005. TEST DATA ONLY. Every business name starts with [TEST].
-- Run ONCE in the Supabase SQL Editor (runs as the database owner).

insert into public.businesses
  (id, business_name, industry, business_description, business_email, business_phone,
   business_timezone, services, business_faq, pricing_information, operating_hours)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '[TEST] Sampaguita Realty', 'REAL_ESTATE',
   'Sample real estate agency used only for testing.', 'test-realty@example.com', '+639170000001',
   'Asia/Manila',
   '["House and lot","Condominium units"]'::jsonb,
   '[{"q":"Do you offer installment payment?","a":"Please confirm payment terms with the agent."}]'::jsonb,
   'Prices vary per property. Sample data only.',
   '{"mon-fri":"09:00-18:00","sat":"09:00-13:00"}'::jsonb),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '[TEST] Bayanihan Dental Clinic', 'CLINIC',
   'Sample dental clinic used only for testing.', 'test-clinic@example.com', '+639170000002',
   'Asia/Manila',
   '["Dental consultation","Teeth cleaning"]'::jsonb,
   '[{"q":"Where are you located?","a":"Sample address only."}]'::jsonb,
   'Consultation fee: sample data only.',
   '{"mon-sat":"10:00-19:00"}'::jsonb);

insert into public.leads
  (id, business_id, full_name, email, email_normalized, phone, phone_normalized, source,
   original_message, preferred_language, consent_to_contact,
   lead_score, lead_intent, lead_status, conversation_status)
values
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'Maria Santos', 'maria@example.com', 'maria@example.com', '09171234567', '+639171234567',
   'WEBSITE_FORM', 'Hi po, magkano yung available house?', 'TAGLISH', true,
   'WARM', 'PROPERTY_PRICE', 'ANALYZED', 'WAITING_FOR_APPROVAL'),
  ('22222222-2222-4222-8222-222222222222', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'Juan Dela Cruz', 'juan@example.com', 'juan@example.com', '09181234567', '+639181234567',
   'TALLY', 'I want to schedule a viewing.', 'ENGLISH', true,
   'HOT', 'PROPERTY_VIEWING', 'ANALYZED', 'WAITING_FOR_APPROVAL'),
  ('33333333-3333-4333-8333-333333333333', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'Ana Reyes', 'ana@example.com', 'ana@example.com', '09191234567', '+639191234567',
   'WEBSITE_FORM', 'Just browsing lang po.', 'TAGLISH', true,
   'COLD', 'GENERAL_INQUIRY', 'ANALYZED', 'WAITING_FOR_APPROVAL'),
  -- Same phone as Maria, but a DIFFERENT business: must stay separate
  ('44444444-4444-4444-8444-444444444444', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
   'Maria Santos', 'maria@example.com', 'maria@example.com', '09171234567', '+639171234567',
   'WEBSITE_FORM', 'How much is your consultation?', 'ENGLISH', true,
   'WARM', 'PRICE_INQUIRY', 'ANALYZED', 'WAITING_FOR_APPROVAL'),
  ('55555555-5555-4555-8555-555555555555', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
   'Pedro Garcia', 'pedro@example.com', 'pedro@example.com', '09201234567', '+639201234567',
   'WEBSITE_FORM', 'Can you diagnose this condition?', 'ENGLISH', true,
   null, 'GENERAL_INQUIRY', 'NEEDS_HUMAN_REVIEW', 'NEW');

-- One interaction per lead (this is where replay protection lives)
insert into public.lead_interactions
  (business_id, lead_id, source, external_submission_id, message_text, content_hash, received_at)
select l.business_id, l.id, l.source, 'test-' || l.id::text, l.original_message,
       encode(sha256(convert_to(l.original_message, 'UTF8')), 'hex'), l.first_contact_at
from public.leads l
where l.business_id in ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

-- A normal analysis, and an escalation (no definitive answer is drafted)
insert into public.lead_analyses
  (business_id, lead_id, analysis_status, intent, lead_score, score_reason, urgency,
   detected_language, customer_needs, missing_information, suggested_reply,
   confidence_level, needs_human_review, escalation_reason, provider, model_used, prompt_version)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111',
   'COMPLETED', 'PROPERTY_PRICE', 'WARM', 'Customer is asking about property pricing.', 'LOW',
   'TAGLISH', '["Property pricing information"]'::jsonb, '["Preferred property location"]'::jsonb,
   'Hello Maria! Thank you for your interest. May I know which location or property type you prefer so we can share the right pricing details?',
   'HIGH', false, null, 'test', 'seed-data', 'seed'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '55555555-5555-4555-8555-555555555555',
   'COMPLETED', 'GENERAL_INQUIRY', 'COLD', 'Customer asked for a medical diagnosis.', 'LOW',
   'ENGLISH', '["Medical opinion"]'::jsonb, '[]'::jsonb,
   null, 'LOW', true, 'Customer asked for a medical diagnosis. A human must respond.',
   'test', 'seed-data', 'seed');
