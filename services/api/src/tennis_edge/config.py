from functools import lru_cache

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    api_tennis_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("API_TENNIS_KEY", "TENNIS_EDGE_API_TENNIS_KEY"),
    )
    odds_api_io_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("ODDS_API_IO_KEY", "TENNIS_EDGE_ODDS_API_IO_KEY"),
    )
    the_odds_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("THE_ODDS_API_KEY", "TENNIS_EDGE_THE_ODDS_API_KEY"),
    )
    sportradar_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("SPORTRADAR_API_KEY", "TENNIS_EDGE_SPORTRADAR_API_KEY"),
    )
    sportradar_access_level: str = Field(
        default="trial",
        validation_alias=AliasChoices(
            "SPORTRADAR_ACCESS_LEVEL", "TENNIS_EDGE_SPORTRADAR_ACCESS_LEVEL"
        ),
    )
    betradar_uof_token: str | None = Field(
        default=None,
        validation_alias=AliasChoices("BETRADAR_UOF_TOKEN", "TENNIS_EDGE_BETRADAR_UOF_TOKEN"),
    )
    txodds_user: str | None = Field(
        default=None,
        validation_alias=AliasChoices("TXODDS_USER", "TENNIS_EDGE_TXODDS_USER"),
    )
    txodds_password: str | None = Field(
        default=None,
        validation_alias=AliasChoices("TXODDS_PASSWORD", "TENNIS_EDGE_TXODDS_PASSWORD"),
    )
    cloudflare_tunnel_token: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "CLOUDFLARE_TUNNEL_TOKEN", "TENNIS_EDGE_CLOUDFLARE_TUNNEL_TOKEN"
        ),
    )
    private_allowed_emails: str = Field(
        default="",
        validation_alias=AliasChoices("PRIVATE_ALLOWED_EMAILS", "TENNIS_EDGE_PRIVATE_ALLOWED_EMAILS"),
    )
    admin_api_token: str | None = Field(
        default=None,
        validation_alias=AliasChoices("ADMIN_API_TOKEN", "TENNIS_EDGE_ADMIN_API_TOKEN"),
    )
    execution_enabled: bool = Field(
        default=False,
        validation_alias=AliasChoices("EXECUTION_ENABLED", "TENNIS_EDGE_EXECUTION_ENABLED"),
    )
    runtime_profile: str = Field(
        default="enterprise",
        validation_alias=AliasChoices("TENNIS_EDGE_RUNTIME_PROFILE", "RUNTIME_PROFILE"),
    )
    coverage: str = Field(
        default="atp,wta,challenger,itf,grand_slam_men,grand_slam_women",
        validation_alias=AliasChoices("TENNIS_EDGE_COVERAGE", "COVERAGE"),
    )
    score_primary: str = Field(
        default="sportradar",
        validation_alias=AliasChoices("SCORE_PRIMARY", "TENNIS_EDGE_SCORE_PRIMARY"),
    )
    odds_primary: str = Field(
        default="txodds",
        validation_alias=AliasChoices("ODDS_PRIMARY", "TENNIS_EDGE_ODDS_PRIMARY"),
    )
    odds_archive: str = Field(
        default="betradar_uof",
        validation_alias=AliasChoices("ODDS_ARCHIVE", "TENNIS_EDGE_ODDS_ARCHIVE"),
    )
    enterprise_feeds_enabled: bool = Field(
        default=True,
        validation_alias=AliasChoices(
            "ENTERPRISE_FEEDS_ENABLED", "TENNIS_EDGE_ENTERPRISE_FEEDS_ENABLED"
        ),
    )
    monthly_budget_usd: float = Field(
        default=0,
        validation_alias=AliasChoices("TENNIS_EDGE_MONTHLY_BUDGET_USD", "MONTHLY_BUDGET_USD"),
    )
    data_mode: str = Field(
        default="sample",
        validation_alias=AliasChoices("TENNIS_EDGE_DATA_MODE", "DATA_MODE"),
    )
    cors_origin: str = Field(
        default="http://localhost:3000",
        validation_alias=AliasChoices("TENNIS_EDGE_CORS_ORIGIN", "CORS_ORIGIN"),
    )

    model_config = SettingsConfigDict(
        env_file="../../.env",
        extra="ignore",
        populate_by_name=True,
    )

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origin.split(",") if origin.strip()]

    @property
    def coverage_set(self) -> set[str]:
        return {item.strip() for item in self.coverage.split(",") if item.strip()}


@lru_cache
def get_settings() -> Settings:
    return Settings()
