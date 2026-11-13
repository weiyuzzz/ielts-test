-- Settings: 3D digital human on/off. false → the lightweight 2D SVG examiner
-- is used everywhere (exam sidebar, mic check card). Default keeps today's
-- behaviour (3D on) for every existing user.
ALTER TABLE "users" ADD COLUMN "digital_human_3d" boolean DEFAULT true NOT NULL;
