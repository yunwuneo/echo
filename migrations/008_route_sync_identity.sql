-- Independent IDs keep the seven capability records distinct in client caches.
ALTER TABLE model_routes ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE;
