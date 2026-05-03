"""Initial migration

Revision ID: init
Revises: 
Create Date: 2026-05-02 20:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = 'init'
down_revision = None
branch_labels = None
depends_on = None

def upgrade() -> None:
    op.create_table('users',
    sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
    sa.Column('username', sa.String(), nullable=False),
    sa.Column('identity_key_pub', sa.String(), nullable=False),
    sa.Column('signed_prekey_pub', sa.String(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_users_username'), 'users', ['username'], unique=True)
    
    op.create_table('chats',
    sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
    sa.Column('type', sa.Enum('DIRECT', 'GROUP', name='chattype'), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    
    op.create_table('chat_members',
    sa.Column('chat_id', postgresql.UUID(as_uuid=True), nullable=False),
    sa.Column('user_id', postgresql.UUID(as_uuid=True), nullable=False),
    sa.Column('role', sa.String(), nullable=True),
    sa.ForeignKeyConstraint(['chat_id'], ['chats.id'], ),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
    sa.PrimaryKeyConstraint('chat_id', 'user_id')
    )
    
    op.create_table('messages',
    sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
    sa.Column('chat_id', postgresql.UUID(as_uuid=True), nullable=True),
    sa.Column('sender_id', postgresql.UUID(as_uuid=True), nullable=True),
    sa.Column('encrypted_payload', sa.Text(), nullable=False),
    sa.Column('is_media', sa.Boolean(), nullable=True),
    sa.Column('status', sa.Enum('SENT', 'DELIVERED', 'READ', name='messagestatus'), nullable=True),
    sa.Column('timestamp', sa.DateTime(), nullable=True),
    sa.ForeignKeyConstraint(['chat_id'], ['chats.id'], ),
    sa.ForeignKeyConstraint(['sender_id'], ['users.id'], ),
    sa.PrimaryKeyConstraint('id')
    )

def downgrade() -> None:
    op.drop_table('messages')
    op.drop_table('chat_members')
    op.drop_table('chats')
    op.drop_index(op.f('ix_users_username'), table_name='users')
    op.drop_table('users')
    op.execute("DROP TYPE chattype;")
    op.execute("DROP TYPE messagestatus;")
