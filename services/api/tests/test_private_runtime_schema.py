from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[3]


def _load_private_runtime_checker():
    scripts_dir = str(ROOT / "scripts")
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    spec = spec_from_file_location(
        "check_private_runtime",
        ROOT / "scripts/check_private_runtime.py",
    )
    assert spec and spec.loader
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_schema_duplicate_column_checker_accepts_current_schema() -> None:
    checker = _load_private_runtime_checker()

    duplicates = checker.duplicate_schema_columns((ROOT / "infra/schema.sql").read_text())

    assert duplicates == []


def test_api_last_core_contract_checker_accepts_current_repo() -> None:
    checker = _load_private_runtime_checker()

    errors = checker.validate_api_last_core_contract(ROOT)

    assert errors == []


def test_schema_duplicate_column_checker_reports_table_and_column() -> None:
    checker = _load_private_runtime_checker()

    duplicates = checker.duplicate_schema_columns(
        """
        CREATE TABLE IF NOT EXISTS model_versions (
          id TEXT PRIMARY KEY,
          promoted BOOLEAN NOT NULL DEFAULT false,
          promoted BOOLEAN NOT NULL DEFAULT false
        );
        """
    )

    assert duplicates == ["model_versions.promoted"]


def test_required_text_checker_reports_missing_marker() -> None:
    checker = _load_private_runtime_checker()
    errors = []

    checker._require_text(
        errors,
        label="contract",
        text="ScoreProviderAdapter",
        required=["ScoreProviderAdapter", "OddsProviderAdapter"],
    )

    assert errors == ["contract missing OddsProviderAdapter"]
