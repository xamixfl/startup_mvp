CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_created_at
ON chat_messages (chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_user_created_at
ON chat_messages (chat_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_members_user_id
ON chat_members (user_id);

CREATE INDEX IF NOT EXISTS idx_chat_members_chat_id
ON chat_members (chat_id);

CREATE INDEX IF NOT EXISTS idx_chat_members_chat_user
ON chat_members (chat_id, user_id);

CREATE INDEX IF NOT EXISTS idx_meetings_creator_id
ON meetings (creator_id);

CREATE INDEX IF NOT EXISTS idx_meetings_expires_created
ON meetings (expires_at, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_table_connector_user_id
ON "table-connector" (user_id);

CREATE INDEX IF NOT EXISTS idx_table_connector_meeting_id
ON "table-connector" (meeting_id);

CREATE INDEX IF NOT EXISTS idx_table_connector_meeting_user
ON "table-connector" (meeting_id, user_id);

CREATE INDEX IF NOT EXISTS idx_profiles_username
ON profiles (username);

CREATE INDEX IF NOT EXISTS idx_profiles_email
ON profiles (email);

CREATE INDEX IF NOT EXISTS idx_notifications_admin_read_created
ON notifications (admin_profile_id, is_read, created_at DESC);
