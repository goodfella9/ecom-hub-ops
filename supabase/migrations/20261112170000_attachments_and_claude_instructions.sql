-- 1) Email attachments: metadata only (part_id, filename, mime, size, inline). Files stay in Gmail.
alter table ticket_messages add column if not exists attachments jsonb not null default '[]'::jsonb;

-- 2) "Tell Claude": Brian leaves an instruction on a ticket; status for_claude until Claude finishes or hands it back.
alter table tickets add column if not exists instruction text;
alter table tickets add column if not exists instruction_by text;
alter table tickets add column if not exists instruction_at timestamptz;
alter table tickets drop constraint if exists tickets_status_check;
alter table tickets add constraint tickets_status_check
  check (status = any (array['new', 'needs_you', 'awaiting_approval', 'for_claude', 'replied', 'done']));
