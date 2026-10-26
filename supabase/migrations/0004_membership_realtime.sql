begin;

alter table public.larp_group_members replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'larp_group_members'
  ) then
    alter publication supabase_realtime add table public.larp_group_members;
  end if;
end;
$$;

commit;
