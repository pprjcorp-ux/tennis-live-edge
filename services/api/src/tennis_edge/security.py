from fastapi import Depends, Header, HTTPException, status

from tennis_edge.config import Settings, get_settings


def require_admin_token(
    x_admin_token: str | None = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> None:
    if not settings.admin_api_token:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="ADMIN_API_TOKEN must be configured before using operational endpoints.",
        )
    if not x_admin_token or x_admin_token != settings.admin_api_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Admin token required.",
        )
