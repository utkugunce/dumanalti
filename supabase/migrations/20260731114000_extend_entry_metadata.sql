-- Dumanaltı v7.1.0: tüm kategorilerde tür, etiket ve konum bilgisini koru.
-- Supabase SQL Editor veya CLI ile üretime bir kez uygulanmalıdır.

alter table public.dumanalti_entries
  add column if not exists kind text,
  add column if not exists tag text,
  add column if not exists lat double precision,
  add column if not exists lng double precision;

alter table public.dumanalti_sigara
  add column if not exists kind text,
  add column if not exists tag text,
  add column if not exists lat double precision,
  add column if not exists lng double precision;

alter table public.dumanalti_icki
  add column if not exists kind text,
  add column if not exists tag text,
  add column if not exists lat double precision,
  add column if not exists lng double precision;

update public.dumanalti_entries set kind = 'sigo' where kind is null;
update public.dumanalti_sigara set kind = 'sigara' where kind is null;
update public.dumanalti_icki set kind = 'bira' where kind is null;

alter table public.dumanalti_entries alter column kind set default 'sigo';
alter table public.dumanalti_sigara alter column kind set default 'sigara';
alter table public.dumanalti_icki alter column kind set default 'bira';
