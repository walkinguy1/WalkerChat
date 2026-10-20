"""Add stable Supabase Auth identity mapping.

Revision ID: 0002_supabase_identity
Revises: 0001_e2ee_baseline
Create Date: 2026-10-19
"""

from alembic import op
import sqlalchemy as sa

revision = "0002_supabase_identity"
down_revision = "0001_e2ee_baseline"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Existing accounts remain intact and can be explicitly linked after proving
    # both their local password and a verified Supabase identity.
    op.alter_column("users", "password_hash", existing_type=sa.String(), nullable=True)
    op.add_column("users", sa.Column("display_name", sa.String(), nullable=True))
    op.add_column("users", sa.Column("supabase_subject", sa.String(255), nullable=True))
    op.create_index(
        "ix_users_supabase_subject", "users", ["supabase_subject"], unique=True
    )


def downgrade() -> None:
    raise RuntimeError(
        "This identity migration is forward-only. Do not downgrade it automatically; "
        "restore a verified backup or prepare a separately reviewed forward migration."
    )
