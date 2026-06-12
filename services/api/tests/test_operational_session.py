import asyncio
from datetime import date, datetime, timezone

from tennis_edge.config import Settings
from tennis_edge.services.ingestion import OperationalSnapshot
from tennis_edge.services.operational_session import OperationalSession
from tennis_edge.services.repository import AnalysisRepository


class IngestionStub:
    def __init__(self, snapshot: OperationalSnapshot) -> None:
        self.snapshot = snapshot

    async def snapshot_for_date(self, target_date: date) -> OperationalSnapshot:
        return self.snapshot


def test_operational_session_reloads_canonical_persisted_snapshot_after_provider_write() -> None:
    repo = AnalysisRepository(Settings(data_mode="live", persistence_enabled=True))
    base = asyncio.run(
        AnalysisRepository(Settings(data_mode="sample")).analyses_for_date(date.today())
    )[0]
    generated = base.model_copy(
        update={"match": base.match.model_copy(update={"tournament": "Generated Provider"})}
    )
    persisted = base.model_copy(
        update={"match": base.match.model_copy(update={"tournament": "Persisted Canonical"})}
    )

    class StoreStub:
        def latest_analyses(self, target_date: date):
            return [persisted]

    session = OperationalSession(
        IngestionStub(
            OperationalSnapshot(
                analyses=[generated],
                source="provider_live",
                persisted=True,
                generated_at=datetime.now(timezone.utc),
                raw_payloads_saved=1,
            )
        ),
        StoreStub(),
        lambda match, signals: signals,
        repo.dashboard_read_model,
    )

    analyses = asyncio.run(session.analyses_for_date(date.today()))

    assert [analysis.match.tournament for analysis in analyses] == ["Persisted Canonical"]


def test_operational_session_gates_persisted_fallback_signals() -> None:
    repo = AnalysisRepository(Settings(data_mode="sample", persistence_enabled=False))
    base = asyncio.run(repo.analyses_for_date(date.today()))[0]

    class StoreStub:
        def latest_analyses(self, target_date: date):
            raise AssertionError("persisted fallback snapshot should already contain analyses")

    session = OperationalSession(
        IngestionStub(
            OperationalSnapshot(
                analyses=[base],
                source="persisted_fallback",
                persisted=True,
                generated_at=datetime.now(timezone.utc),
            )
        ),
        StoreStub(),
        lambda match, signals: [],
        repo.dashboard_read_model,
    )

    analyses = asyncio.run(session.analyses_for_date(date.today()))

    assert analyses[0].match.id == base.match.id
    assert analyses[0].signals == []
