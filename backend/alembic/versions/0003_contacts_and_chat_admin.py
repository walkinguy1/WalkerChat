"""Add contact requests, accepted contacts and blocks.

Revision ID: 0003_contacts_and_chat_admin
Revises: 0002_supabase_identity
Create Date: 2026-10-20
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0003_contacts_and_chat_admin"
down_revision = "0002_supabase_identity"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("username_normalized", sa.String(), nullable=True))
    op.execute("UPDATE users SET username_normalized = lower(trim(username))")
    op.create_index("ix_users_username_normalized", "users", ["username_normalized"], unique=True)
    op.create_table(
        "contacts",
        sa.Column("user_low_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_high_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_low_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["user_high_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("user_low_id", "user_high_id"),
        sa.CheckConstraint("user_low_id < user_high_id", name="ck_contact_pair_ordered"),
    )
    op.create_index("ix_contacts_user_high_id", "contacts", ["user_high_id"])
    op.create_table(
        "contact_requests",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("requester_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("target_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["requester_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["target_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("requester_id", "target_id", name="uq_contact_request_pair"),
        sa.CheckConstraint("requester_id <> target_id", name="ck_contact_request_not_self"),
    )
    op.create_index("ix_contact_requests_requester_id", "contact_requests", ["requester_id"])
    op.create_index("ix_contact_requests_target_id", "contact_requests", ["target_id"])
    op.create_table(
        "contact_blocks",
        sa.Column("blocker_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("blocked_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["blocker_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["blocked_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("blocker_id", "blocked_id"),
        sa.CheckConstraint("blocker_id <> blocked_id", name="ck_contact_block_not_self"),
    )
    op.create_index("ix_contact_blocks_blocked_id", "contact_blocks", ["blocked_id"])
    op.create_index("ix_chat_members_user_id", "chat_members", ["user_id"])


def downgrade() -> None:
    raise RuntimeError(
        "This migration is forward-only. Do not delete contact data or downgrade automatically; "
        "restore a verified backup or prepare a separately reviewed forward migration."
    )
