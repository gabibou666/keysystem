-- Additive defaults preserve existing custom GUI integrations.
ALTER TABLE developer_projects ADD COLUMN IF NOT EXISTS key_ui_mode TEXT NOT NULL DEFAULT 'custom' CHECK (key_ui_mode IN ('custom','builtin'));
ALTER TABLE developer_projects ADD COLUMN IF NOT EXISTS key_ui_layout TEXT NOT NULL DEFAULT 'compact' CHECK (key_ui_layout IN ('compact','card','sidebar'));
ALTER TABLE developer_projects ADD COLUMN IF NOT EXISTS key_ui_color TEXT NOT NULL DEFAULT 'violet' CHECK (key_ui_color IN ('violet','blue','green','rose','amber'));
ALTER TABLE developer_projects ADD COLUMN IF NOT EXISTS key_ui_button_size TEXT NOT NULL DEFAULT 'medium' CHECK (key_ui_button_size IN ('small','medium','large'));
