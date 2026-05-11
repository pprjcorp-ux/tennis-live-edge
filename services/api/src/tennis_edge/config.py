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
    execution_venue: str = Field(
        default="betfair",
        validation_alias=AliasChoices("EXECUTION_VENUE", "TENNIS_EDGE_EXECUTION_VENUE"),
    )
    execution_stage: str = Field(
        default="paper",
        validation_alias=AliasChoices("EXECUTION_STAGE", "TENNIS_EDGE_EXECUTION_STAGE"),
    )
    bankroll_base_currency: str = Field(
        default="USD",
        validation_alias=AliasChoices("BANKROLL_BASE_CURRENCY", "TENNIS_EDGE_BANKROLL_BASE_CURRENCY"),
    )
    bankroll_starting_balance: float = Field(
        default=10000,
        validation_alias=AliasChoices(
            "BANKROLL_STARTING_BALANCE", "TENNIS_EDGE_BANKROLL_STARTING_BALANCE"
        ),
    )
    max_order_stake_fraction: float = Field(
        default=0.015,
        validation_alias=AliasChoices(
            "MAX_ORDER_STAKE_FRACTION", "TENNIS_EDGE_MAX_ORDER_STAKE_FRACTION"
        ),
    )
    max_open_exposure_fraction: float = Field(
        default=0.03,
        validation_alias=AliasChoices(
            "MAX_OPEN_EXPOSURE_FRACTION", "TENNIS_EDGE_MAX_OPEN_EXPOSURE_FRACTION"
        ),
    )
    daily_loss_limit_fraction: float = Field(
        default=0.005,
        validation_alias=AliasChoices(
            "DAILY_LOSS_LIMIT_FRACTION", "TENNIS_EDGE_DAILY_LOSS_LIMIT_FRACTION"
        ),
    )
    weekly_drawdown_limit_fraction: float = Field(
        default=0.015,
        validation_alias=AliasChoices(
            "WEEKLY_DRAWDOWN_LIMIT_FRACTION", "TENNIS_EDGE_WEEKLY_DRAWDOWN_LIMIT_FRACTION"
        ),
    )
    betfair_app_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("BETFAIR_APP_KEY", "TENNIS_EDGE_BETFAIR_APP_KEY"),
    )
    betfair_username: str | None = Field(
        default=None,
        validation_alias=AliasChoices("BETFAIR_USERNAME", "TENNIS_EDGE_BETFAIR_USERNAME"),
    )
    betfair_cert_path: str | None = Field(
        default=None,
        validation_alias=AliasChoices("BETFAIR_CERT_PATH", "TENNIS_EDGE_BETFAIR_CERT_PATH"),
    )
    betfair_key_path: str | None = Field(
        default=None,
        validation_alias=AliasChoices("BETFAIR_KEY_PATH", "TENNIS_EDGE_BETFAIR_KEY_PATH"),
    )
    betfair_password_secret_ref: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "BETFAIR_PASSWORD_SECRET_REF", "TENNIS_EDGE_BETFAIR_PASSWORD_SECRET_REF"
        ),
    )
    betfair_live_key_approved: bool = Field(
        default=False,
        validation_alias=AliasChoices(
            "BETFAIR_LIVE_KEY_APPROVED", "TENNIS_EDGE_BETFAIR_LIVE_KEY_APPROVED"
        ),
    )
    real_execution_hard_block: bool = Field(
        default=True,
        validation_alias=AliasChoices(
            "REAL_EXECUTION_HARD_BLOCK", "TENNIS_EDGE_REAL_EXECUTION_HARD_BLOCK"
        ),
    )
    model_champion_version: str = Field(
        default="baseline_v0",
        validation_alias=AliasChoices(
            "MODEL_CHAMPION_VERSION", "TENNIS_EDGE_MODEL_CHAMPION_VERSION"
        ),
    )
    min_paper_signals_for_real_review: int = Field(
        default=500,
        validation_alias=AliasChoices(
            "MIN_PAPER_SIGNALS_FOR_REAL_REVIEW",
            "TENNIS_EDGE_MIN_PAPER_SIGNALS_FOR_REAL_REVIEW",
        ),
    )
    min_paper_days_for_real_review: int = Field(
        default=60,
        validation_alias=AliasChoices(
            "MIN_PAPER_DAYS_FOR_REAL_REVIEW", "TENNIS_EDGE_MIN_PAPER_DAYS_FOR_REAL_REVIEW"
        ),
    )
    odds_ws_resync_required_blocks_signals: bool = Field(
        default=True,
        validation_alias=AliasChoices(
            "ODDS_WS_RESYNC_REQUIRED_BLOCKS_SIGNALS",
            "TENNIS_EDGE_ODDS_WS_RESYNC_REQUIRED_BLOCKS_SIGNALS",
        ),
    )
    model_promotion_require_clv: bool = Field(
        default=True,
        validation_alias=AliasChoices(
            "MODEL_PROMOTION_REQUIRE_CLV", "TENNIS_EDGE_MODEL_PROMOTION_REQUIRE_CLV"
        ),
    )
    openclaw_autopilot_enabled: bool = Field(
        default=True,
        validation_alias=AliasChoices(
            "OPENCLAW_AUTOPILOT_ENABLED", "TENNIS_EDGE_OPENCLAW_AUTOPILOT_ENABLED"
        ),
    )
    openclaw_channel: str = Field(
        default="dashboard,telegram",
        validation_alias=AliasChoices("OPENCLAW_CHANNEL", "TENNIS_EDGE_OPENCLAW_CHANNEL"),
    )
    openclaw_triage_model: str = Field(
        default="gpt-5.4-mini",
        validation_alias=AliasChoices(
            "OPENCLAW_TRIAGE_MODEL", "TENNIS_EDGE_OPENCLAW_TRIAGE_MODEL"
        ),
    )
    openclaw_critical_model: str = Field(
        default="gpt-5.5",
        validation_alias=AliasChoices(
            "OPENCLAW_CRITICAL_MODEL", "TENNIS_EDGE_OPENCLAW_CRITICAL_MODEL"
        ),
    )
    openclaw_router_policy: str = Field(
        default="cost_optimized",
        validation_alias=AliasChoices(
            "OPENCLAW_ROUTER_POLICY", "TENNIS_EDGE_OPENCLAW_ROUTER_POLICY"
        ),
    )
    openclaw_daily_model_budget_usd: float = Field(
        default=15,
        validation_alias=AliasChoices(
            "OPENCLAW_DAILY_MODEL_BUDGET_USD",
            "TENNIS_EDGE_OPENCLAW_DAILY_MODEL_BUDGET_USD",
        ),
    )
    openclaw_telegram_allowed_user_ids: str = Field(
        default="",
        validation_alias=AliasChoices(
            "OPENCLAW_TELEGRAM_ALLOWED_USER_IDS",
            "TENNIS_EDGE_OPENCLAW_TELEGRAM_ALLOWED_USER_IDS",
        ),
    )
    runtime_profile: str = Field(
        default="lean_atp",
        validation_alias=AliasChoices("TENNIS_EDGE_RUNTIME_PROFILE", "RUNTIME_PROFILE"),
    )
    coverage: str = Field(
        default="atp_main,grand_slam_men",
        validation_alias=AliasChoices("TENNIS_EDGE_COVERAGE", "COVERAGE"),
    )
    score_primary: str = Field(
        default="api_tennis",
        validation_alias=AliasChoices("SCORE_PRIMARY", "TENNIS_EDGE_SCORE_PRIMARY"),
    )
    odds_primary: str = Field(
        default="odds_api_io_ws",
        validation_alias=AliasChoices("ODDS_PRIMARY", "TENNIS_EDGE_ODDS_PRIMARY"),
    )
    odds_archive: str = Field(
        default="theoddsapi",
        validation_alias=AliasChoices("ODDS_ARCHIVE", "TENNIS_EDGE_ODDS_ARCHIVE"),
    )
    enterprise_feeds_enabled: bool = Field(
        default=False,
        validation_alias=AliasChoices(
            "ENTERPRISE_FEEDS_ENABLED", "TENNIS_EDGE_ENTERPRISE_FEEDS_ENABLED"
        ),
    )
    monthly_budget_usd: float = Field(
        default=500,
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

    @property
    def openclaw_channels(self) -> list[str]:
        return [channel.strip() for channel in self.openclaw_channel.split(",") if channel.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
