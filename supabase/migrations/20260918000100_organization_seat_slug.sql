-- The workspace's current seat address. A column rather than a lookup because
-- a seat slug is chosen once by an operator and never reissued: retired slugs
-- keep working and live in organization_seat_slugs, which the baseline creates.
-- Nullable because a workspace that has never claimed a seat has no address,
-- and that is not the same as an empty one.
ALTER TABLE public.organizations ADD COLUMN seat_slug text;

-- Unique across every workspace, not per workspace: the slug is the local part
-- of an inbound address, so two workspaces sharing one would make the recipient
-- ambiguous and inbound mail unroutable.
CREATE UNIQUE INDEX organizations_seat_slug_uq ON public.organizations (seat_slug);
