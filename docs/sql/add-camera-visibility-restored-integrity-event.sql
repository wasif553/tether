-- Additive enum update for the neutral camera-visibility-restored event.
-- Mirrors the existing SCREEN_SHARE_RESTORED / DISPLAY_POLICY_RESTORED
-- pattern: fired once when a confirmed sustained no-person episode
-- resolves back to several consecutive, confidently visible frames (see
-- resolveCameraIntegrityState in src/lib/cameraIntegrityDetection.ts).
-- Apply manually through Supabase SQL Editor after backup and verification.
-- Safe to rerun.

ALTER TYPE public."IntegrityEventType"
ADD VALUE IF NOT EXISTS 'CAMERA_VISIBILITY_RESTORED';
