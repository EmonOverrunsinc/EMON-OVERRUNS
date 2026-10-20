# Builds ONE paste-safe file that sets up a new, empty Supabase project with the whole E-Portal (all updates up to 3.0).
import re, sys
SRC = "/home/user/emon-overruns/supabase/"
FILES = ["portal_init", "002_customers_invoices_payments", "003_statements", "004_update_1_1", "005_update_1_2", "006_update_1_3",
         "007_update_1_4", "008_update_1_5", "009_update_1_6", "010_update_1_7", "011_update_1_8", "012_update_1_9",
         "013_update_2_0", "014_update_2_1", "015_update_2_2", "016_update_2_3", "017_play_store", "018_invoice_po", "019_link_payment", "020_invoice_return", "021_join_us", "022_update_2_9", "023_purchase_orders", "024_eo_office", "025_qc_simple", "026_eo_office_fixes", "027_ebill_release"]
parts = []
for f in FILES:
    t = open(SRC + f + ".sql", encoding="utf-8").read().replace("\r", "")
    assert "$sql$" not in t and "$run$" not in t, f
    parts.append(f"\n-- ======== {f}.sql ========\n" + t.rstrip() + "\n")
body = "".join(parts)
chars = sorted({c for c in body if ord(c) > 127})
for c in chars:
    body = body.replace(c, "[[U+%04X]]" % ord(c))
assert all(ord(c) < 128 for c in body)
restore = "".join(f"  s := replace(s, '[[U+{ord(c):04X}]]', chr({ord(c)}));\n" for c in chars)
head = """-- =====================================================================
-- EMON OVERRUNS E-PORTAL - NEW SERVER SETUP (everything up to update 2.2) in ONE file. RUN ONLY THIS FILE, ONCE,
-- on the NEW, EMPTY project.
-- Supabase > your new project > SQL Editor > New query > paste ALL of this file > Run (if asked: "Run this query").
-- At the end it shows: E-PORTAL SERVER READY. If anything fails, nothing is changed and it can be run again.
-- Run it only ONCE: on a project that is already set up it stops with "already exists" and changes nothing.
-- The file has only plain letters (special characters are written [[U+....]] and put back before it runs), and
-- Windows line breaks are taken out, so copy and paste works.
-- Then: the first account that signs up on the E-Portal becomes the Director (Admin).
-- =====================================================================
do $run$
declare
  s text := $sql$"""
tail = """$sql$;
begin
  s := replace(s, chr(13), '');  -- Windows line breaks
""" + restore + """  execute s;
end
$run$;

-- ---------- the result ----------
select case when to_regclass('public.customers') is not null
             and to_regclass('public.contact_messages') is not null
             and to_regclass('public.main_director') is not null
             and to_regprocedure('public.statement_amounts(uuid,date)') is not null
             and to_regprocedure('public.director_edit_customer(uuid,jsonb)') is not null
             and exists (select 1 from storage.buckets where id = 'records')
             and exists (select 1 from pg_trigger where tgname = 'statements_follow')
        then 'E-PORTAL SERVER READY - ' || (select count(*) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE')
             || ' tables, ' || (select count(*) from pg_proc where pronamespace = 'public'::regnamespace) || ' functions. Next: sign up on the E-Portal.'
        else 'NOT COMPLETE: tell Claude' end as result;
"""
out = head + body + tail
open(SRC + "NEW_SERVER_SETUP.sql", "w", encoding="ascii").write(out)
print(len(out), "bytes;", len(chars), "special characters:", " ".join("%04X" % ord(c) for c in chars))
