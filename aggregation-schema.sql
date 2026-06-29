-- ERONIX aggregation layer — Postgres system of record (Supabase / Neon).
-- The Blobs implementation in _aggregation.mjs mirrors this exactly; swapping to
-- Postgres means reimplementing that module's functions against these tables, with
-- no change to any caller.

create table master_cartons (
  mc        text primary key,
  item      text not null,
  batch     text not null,
  packed_at timestamptz not null default now()
);

create table outer_cartons (
  oc        text primary key,
  mc        text not null references master_cartons(mc),
  item      text not null,
  batch     text not null,
  packed_at timestamptz not null default now()
);
create index on outer_cartons (mc);

create table units (
  serial    text primary key,                       -- ERX… primary serial (the only thing Zoho knows)
  item      text not null,
  batch     text not null,
  oc        text not null references outer_cartons(oc),
  mc        text not null references master_cartons(mc),
  status    text not null default 'in_stock'        -- in_stock | invoiced | dispatched
            check (status in ('in_stock','invoiced','dispatched')),
  packed_at timestamptz not null default now()
);
create index on units (oc);
create index on units (mc);
create index on units (status);

-- Every operational question is one indexed query:

--   which OC / MC holds a serial (bottom-up)
-- select oc, mc, status from units where serial = $1;

--   contents of an OC / MC (top-down)
-- select serial from units where oc = $1;
-- select serial from units where mc = $1;

--   is this MC half-emptied?
-- select count(*) filter (where status='in_stock') as in_stock, count(*) as total
-- from units where mc = $1;     -- in_stock = total → intact; 0 → empty; else → opened

--   per-OC remaining inside an MC
-- select oc, count(*) filter (where status='in_stock') as in_stock, count(*) as total
-- from units where mc = $1 group by oc;

--   warranty / anti-diversion: which dealer got a serial
--   (join to the orders/invoice records, which carry the serial manifest)
