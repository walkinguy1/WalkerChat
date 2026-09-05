"""
Check the Alembic baseline against the SQLAlchemy models.

The previous migration drifted badly from the models -- wrong column name on
``messages``, missing ``users.password_hash``, two tables absent entirely -- and nobody
noticed for a long time because ``create_all`` ran at startup and Alembic was never
exercised. Now that Alembic is the only thing that builds the schema, that drift would
be a hard startup failure instead of a silent inconsistency.

This runs without a database: it executes the migration with a recording stub in place
of ``op`` and diffs the resulting table and column names against ``Base.metadata``.

Usage:  python scripts/check_migration_matches_models.py
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import sqlalchemy as sa  # noqa: E402

from app.models import Base  # noqa: E402

MIGRATION = (
    Path(__file__).resolve().parents[1] / "alembic" / "versions" / "0001_e2ee_baseline.py"
)


class RecordingOp:
    """Stands in for ``alembic.op``, capturing schema calls instead of emitting SQL."""

    def __init__(self) -> None:
        self.tables: dict[str, set[str]] = {}
        self.indexes: list[tuple[str, str]] = []

    def create_table(self, name: str, *args: Any, **_kwargs: Any) -> None:
        self.tables[name] = {
            argument.name for argument in args if isinstance(argument, sa.Column)
        }

    def create_index(self, name: str, table: str, *_args: Any, **_kwargs: Any) -> None:
        self.indexes.append((table, name))

    def f(self, name: str) -> str:
        return name

    def __getattr__(self, _name: str):
        # Ignore anything else the migration calls (drop_table, execute, ...).
        return lambda *args, **kwargs: None


def main() -> int:
    recorder = RecordingOp()

    source = MIGRATION.read_text(encoding="utf-8")
    namespace: dict[str, Any] = {"context": SimpleNamespace()}
    exec(compile(source, str(MIGRATION), "exec"), namespace)  # noqa: S102

    # Swap in the recorder *after* executing the module: its own `from alembic import
    # op` would otherwise overwrite a pre-seeded stub. `upgrade` resolves `op` from the
    # module globals when called, so replacing it here is enough.
    namespace["op"] = recorder
    namespace["upgrade"]()

    problems: list[str] = []

    model_tables = set(Base.metadata.tables)
    migration_tables = set(recorder.tables)

    for table in sorted(model_tables - migration_tables):
        problems.append(f"table '{table}' is in the models but not in the migration")
    for table in sorted(migration_tables - model_tables):
        problems.append(f"table '{table}' is in the migration but not in the models")

    for table in sorted(model_tables & migration_tables):
        model_columns = {column.name for column in Base.metadata.tables[table].columns}
        migration_columns = recorder.tables[table]

        for column in sorted(model_columns - migration_columns):
            problems.append(f"{table}.{column} is in the models but not in the migration")
        for column in sorted(migration_columns - model_columns):
            problems.append(f"{table}.{column} is in the migration but not in the models")

    if problems:
        print("Migration does not match the models:\n")
        for problem in problems:
            print("  - " + problem)
        return 1

    print(
        f"Migration matches the models ({len(model_tables)} tables, "
        f"{sum(len(columns) for columns in recorder.tables.values())} columns)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
