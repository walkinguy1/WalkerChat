"""E2EE baseline schema

Replaces the previous "init" revision, which had drifted badly from the models: it
declared ``messages.timestamp`` where the model says ``sent_at``, omitted
``users.password_hash`` entirely, and never created ``one_time_prekeys`` or
``media_objects``. It only appeared to work because ``init_database()`` called
``Base.metadata.create_all`` on startup and bypassed Alembic altogether. That crutch has
been removed, so this revision is now the single source of truth for the schema.

This is a clean baseline rather than an upgrade path. The X3DH rollout is a deliberate
hard break: the old static-ECDH ciphertexts cannot be decrypted by the new protocol, and
the old plaintext-fallback envelopes must not survive at all.

Revision ID: 0001_e2ee_baseline
Revises:
Create Date: 2026-09-05 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0001_e2ee_baseline"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("username", sa.String(), nullable=False),
        sa.Column("password_hash", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_users_username"), "users", ["username"], unique=True)

    op.create_table(
        "devices",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("device_id", sa.String(), nullable=False),
        sa.Column("display_name", sa.String(), nullable=True),
        sa.Column("identity_key_pub", sa.String(), nullable=False),
        sa.Column("identity_key_changed_at", sa.DateTime(), nullable=True),
        sa.Column("signed_prekey_id", sa.String(), nullable=False),
        sa.Column("signed_prekey_pub", sa.String(), nullable=False),
        sa.Column("signed_prekey_sig", sa.String(), nullable=False),
        sa.Column("signed_prekey_created_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "device_id", name="uq_devices_user_device"),
    )
    op.create_index(op.f("ix_devices_user_id"), "devices", ["user_id"], unique=False)

    op.create_table(
        "chats",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("type", sa.Enum("DIRECT", "GROUP", name="chattype"), nullable=True),
        sa.Column("name", sa.String(), nullable=True),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "chat_members",
        sa.Column("chat_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("role", sa.String(), nullable=True),
        sa.ForeignKeyConstraint(["chat_id"], ["chats.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("chat_id", "user_id"),
    )

    op.create_table(
        "messages",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("chat_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("sender_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("sender_device_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("client_message_id", sa.String(), nullable=False),
        sa.Column("is_media", sa.Boolean(), nullable=True),
        sa.Column(
            "status",
            sa.Enum("SENT", "DELIVERED", "READ", name="messagestatus"),
            nullable=True,
        ),
        sa.Column("sent_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["chat_id"], ["chats.id"]),
        sa.ForeignKeyConstraint(["sender_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["sender_device_id"], ["devices.id"]),
        sa.PrimaryKeyConstraint("id"),
        # Server-side idempotency for WebSocket resends.
        sa.UniqueConstraint(
            "chat_id", "client_message_id", name="uq_messages_chat_client_id"
        ),
    )

    op.create_table(
        "message_envelopes",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("message_id", postgresql.UUID(as_uuid=True), nullable=False),
        # Null for group messages: Sender Keys produce one ciphertext for everyone.
        sa.Column("recipient_device_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("encrypted_payload", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(["message_id"], ["messages.id"]),
        sa.ForeignKeyConstraint(["recipient_device_id"], ["devices.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "message_id", "recipient_device_id", name="uq_envelopes_message_device"
        ),
    )
    op.create_index(
        op.f("ix_message_envelopes_message_id"),
        "message_envelopes",
        ["message_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_message_envelopes_recipient_device_id"),
        "message_envelopes",
        ["recipient_device_id"],
        unique=False,
    )

    op.create_table(
        "one_time_prekeys",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("device_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("key_id", sa.String(), nullable=False),
        sa.Column("public_key", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["device_id"], ["devices.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("device_id", "key_id", name="uq_one_time_prekeys_device_key"),
    )
    op.create_index(
        op.f("ix_one_time_prekeys_device_id"),
        "one_time_prekeys",
        ["device_id"],
        unique=False,
    )

    op.create_table(
        "media_objects",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("chat_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("uploader_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("object_key", sa.String(length=255), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["chat_id"], ["chats.id"]),
        sa.ForeignKeyConstraint(["uploader_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("object_key"),
    )


def downgrade() -> None:
    op.drop_table("media_objects")
    op.drop_index(op.f("ix_one_time_prekeys_device_id"), table_name="one_time_prekeys")
    op.drop_table("one_time_prekeys")
    op.drop_index(
        op.f("ix_message_envelopes_recipient_device_id"), table_name="message_envelopes"
    )
    op.drop_index(op.f("ix_message_envelopes_message_id"), table_name="message_envelopes")
    op.drop_table("message_envelopes")
    op.drop_table("messages")
    op.drop_table("chat_members")
    op.drop_table("chats")
    op.drop_index(op.f("ix_devices_user_id"), table_name="devices")
    op.drop_table("devices")
    op.drop_index(op.f("ix_users_username"), table_name="users")
    op.drop_table("users")
    sa.Enum(name="chattype").drop(op.get_bind(), checkfirst=True)
    sa.Enum(name="messagestatus").drop(op.get_bind(), checkfirst=True)
