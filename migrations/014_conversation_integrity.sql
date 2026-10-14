ALTER TABLE rooms ADD COLUMN behavior jsonb NOT NULL DEFAULT '{"history_mode":"all","history_count":20,"history_tokens":8192,"image_history":"recent_two","start_message_id":null}';
ALTER TABLE runs ADD COLUMN behavior jsonb,
 ADD COLUMN replacement_message_id uuid REFERENCES messages(id),
 ADD COLUMN history_before_order bigint,
 ADD COLUMN history_before_sequence bigint,
 ADD COLUMN original_user_message_id uuid REFERENCES messages(id);
CREATE TABLE conversation_defaults(owner_id uuid PRIMARY KEY REFERENCES owners(id), revision integer NOT NULL DEFAULT 1, behavior jsonb NOT NULL);
