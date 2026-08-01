-- Additive enum update for neutral camera-stream interruption reporting.
-- Apply manually through Supabase SQL Editor after backup and verification.
-- Safe to rerun.

ALTER TYPE public."IntegrityEventType"
ADD VALUE IF NOT EXISTS 'CAMERA_STREAM_UNAVAILABLE';
