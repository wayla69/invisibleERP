-- A5: force-change the default/weak admin password on next login.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean DEFAULT false;
-- the seeded default admin (admin/admin123) must rotate its password
UPDATE users SET must_change_password = true WHERE username = 'admin';
