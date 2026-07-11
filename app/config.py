"""設定管理モジュール"""

import os
from pathlib import Path
from typing import Any

import yaml

BASE_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = BASE_DIR / "config.yaml"

# .env を軽く読み込む(python-dotenv 非依存)
_ENV_PATH = BASE_DIR / ".env"
if _ENV_PATH.exists():
    for _line in _ENV_PATH.read_text(encoding="utf-8").splitlines():
        _line = _line.strip()
        if not _line or _line.startswith("#") or "=" not in _line:
            continue
        _k, _v = _line.split("=", 1)
        os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))


def load_config() -> dict[str, Any]:
    """config.yamlを読み込む"""
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH, encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    return {}


_config = load_config()


def _env_bool(name: str, default: bool) -> bool:
    """環境変数の真偽値を解釈する"""
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


class Settings:
    """アプリケーション設定"""

    # Server
    host: str = _config.get("server", {}).get("host", "0.0.0.0")
    port: int = _config.get("server", {}).get("port", 8000)

    # Basic Auth (未設定なら認証なし = ローカル開発用)
    auth_user: str = os.environ.get("XPILOT_USER", _config.get("auth", {}).get("user", ""))
    auth_pass: str = os.environ.get("XPILOT_PASS", _config.get("auth", {}).get("pass", ""))

    # HTTP Client
    user_agent: str = _config.get("http_client", {}).get(
        "user_agent",
        _config.get("browser", {}).get(  # 旧config互換
            "user_agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        ),
    )

    # Delays
    action_min: float = _config.get("delays", {}).get("action_min", 2.0)
    action_max: float = _config.get("delays", {}).get("action_max", 5.0)
    between_accounts_min: float = _config.get("delays", {}).get("between_accounts_min", 5.0)
    between_accounts_max: float = _config.get("delays", {}).get("between_accounts_max", 15.0)

    # Paths
    accounts_file: Path = BASE_DIR / _config.get("paths", {}).get("accounts_file", "data/x_accounts.xlsx")
    sessions_dir: Path = BASE_DIR / _config.get("paths", {}).get("sessions_dir", "data/sessions")
    logs_dir: Path = BASE_DIR / _config.get("paths", {}).get("logs_dir", "logs")

    # Farming resources
    resources_dir: Path = BASE_DIR / "data/resources"
    variables_dir: Path = BASE_DIR / "data/resources/variables"
    ngwords_file: Path = BASE_DIR / "data/resources/ngwords.txt"
    images_cache_dir: Path = BASE_DIR / "data/images"
    tweet_media_dir: Path = BASE_DIR / "data/tweet_media"
    jobs_file: Path = BASE_DIR / "data/jobs.json"  # 旧形式 (移行用)
    farming_configs_file: Path = BASE_DIR / "data/farming_configs.json"
    proxies_file: Path = BASE_DIR / "data/proxies.json"
    nurturing_plan_file: Path = BASE_DIR / "data/nurturing_plan.json"

    # Farming settings
    farming_max_tweets_per_run: int = _config.get("farming", {}).get("max_tweets_per_run", 50)
    # 育成動作を純粋API叩きに絞るモード。True なら HTML ページ (x.com/home) 取得を
    # 省略して帯域課金プロキシ向けにトラフィックを最小化する。
    farming_api_only: bool = _env_bool(
        "XPILOT_FARMING_API_ONLY",
        _config.get("farming", {}).get("api_only", True),
    )
    # data/tweet_media および data/images に溜まる画像キャッシュの保持日数。
    # 0 以下に設定するとクリーンアップを無効化する。
    media_cache_max_age_days: int = int(
        os.environ.get(
            "XPILOT_MEDIA_CACHE_MAX_AGE_DAYS",
            _config.get("farming", {}).get("media_cache_max_age_days", 7),
        )
    )

    # Resource limits
    max_clients: int = _config.get("resource_limits", {}).get(
        "max_clients", _config.get("resource_limits", {}).get("max_browser_contexts", 20)
    )
    _configured_client_idle_ttl: int = int(_config.get("resource_limits", {}).get(
        "client_idle_ttl", _config.get("resource_limits", {}).get("context_idle_ttl", 120)
    ))
    client_idle_ttl: int = max(
        60,
        min(
            _configured_client_idle_ttl,
            int(os.environ.get("XPILOT_CLIENT_IDLE_TTL_MAX", 300)),
        ),
    )
    client_badge_poll_enabled: bool = _env_bool(
        "XPILOT_BADGE_POLL_ENABLED",
        _config.get("resource_limits", {}).get("badge_poll_enabled", False),
    )
    max_concurrent_actions: int = _config.get("resource_limits", {}).get("max_concurrent_actions", 3)
    farming_max_concurrent: int = _config.get("resource_limits", {}).get("farming_max_concurrent", 5)

    # Proxy escape / residential session recovery
    proxy_escape_enabled: bool = _env_bool(
        "XPILOT_PROXY_ESCAPE_ENABLED",
        _config.get("proxy_escape", {}).get("enabled", True),
    )
    proxy_escape_consecutive_threshold: int = int(
        os.environ.get(
            "XPILOT_PROXY_ESCAPE_CONSECUTIVE_THRESHOLD",
            _config.get("proxy_escape", {}).get("consecutive_threshold", 2),
        )
    )
    proxy_escape_24h_threshold: int = int(
        os.environ.get(
            "XPILOT_PROXY_ESCAPE_24H_THRESHOLD",
            _config.get("proxy_escape", {}).get("threshold_24h", 3),
        )
    )
    proxy_escape_max_per_24h: int = int(
        os.environ.get(
            "XPILOT_PROXY_ESCAPE_MAX_PER_24H",
            _config.get("proxy_escape", {}).get("max_per_24h", 1),
        )
    )
    proxy_escape_max_per_7d: int = int(
        os.environ.get(
            "XPILOT_PROXY_ESCAPE_MAX_PER_7D",
            _config.get("proxy_escape", {}).get("max_per_7d", 3),
        )
    )
    proxy_escape_min_retry_delay_minutes: int = int(
        os.environ.get(
            "XPILOT_PROXY_ESCAPE_MIN_RETRY_DELAY_MINUTES",
            _config.get("proxy_escape", {}).get("min_retry_delay_minutes", 30),
        )
    )
    proxy_escape_max_retry_delay_minutes: int = int(
        os.environ.get(
            "XPILOT_PROXY_ESCAPE_MAX_RETRY_DELAY_MINUTES",
            _config.get("proxy_escape", {}).get("max_retry_delay_minutes", 90),
        )
    )
    proxy_escape_killswitch_enabled: bool = _env_bool(
        "XPILOT_PROXY_ESCAPE_KILLSWITCH_ENABLED",
        _config.get("proxy_escape", {}).get("killswitch_enabled", False),
    )

    # Headless Chrome cleanup
    chrome_cleanup_enabled: bool = _env_bool(
        "XPILOT_CHROME_CLEANUP_ENABLED",
        _config.get("chrome_cleanup", {}).get("enabled", True),
    )
    chrome_cleanup_min_age_hours: float = float(
        os.environ.get(
            "XPILOT_CHROME_CLEANUP_MIN_AGE_HOURS",
            _config.get("chrome_cleanup", {}).get("min_age_hours", 6),
        )
    )
    chrome_cleanup_interval_minutes: int = int(
        os.environ.get(
            "XPILOT_CHROME_CLEANUP_INTERVAL_MINUTES",
            _config.get("chrome_cleanup", {}).get("interval_minutes", 30),
        )
    )

    # Avatar cache / UI proxy
    # 通常の /avatar はキャッシュだけ返す。外部サービス取得は手動一括更新に寄せる。
    avatar_external_fetch_enabled: bool = _env_bool(
        "XPILOT_AVATAR_EXTERNAL_FETCH_ENABLED",
        _config.get("avatar", {}).get("external_fetch_enabled", False),
    )
    avatar_cache_ttl_days: int = int(
        os.environ.get(
            "XPILOT_AVATAR_CACHE_TTL_DAYS",
            _config.get("avatar", {}).get("cache_ttl_days", 30),
        )
    )

    # Unsplash
    unsplash_access_key: str = (
        os.environ.get("UNSPLASH_ACCESS_KEY")
        or _config.get("unsplash", {}).get("access_key", "")
        or ""
    )

    # Logging
    log_level: str = _config.get("logging", {}).get("level", "INFO")
    log_file: Path = BASE_DIR / _config.get("logging", {}).get("file", "logs/app.log")

    # Public account checker
    public_check_proxy: str = os.environ.get(
        "XPILOT_PUBLIC_CHECK_PROXY",
        _config.get("public_check", {}).get("proxy", ""),
    )
    public_check_headless: bool = _env_bool(
        "XPILOT_PUBLIC_CHECK_HEADLESS",
        _config.get("public_check", {}).get("headless", True),
    )
    public_check_humanize: bool = _env_bool(
        "XPILOT_PUBLIC_CHECK_HUMANIZE",
        _config.get("public_check", {}).get("humanize", True),
    )
    public_check_page_timeout: int = int(
        os.environ.get(
            "XPILOT_PUBLIC_CHECK_PAGE_TIMEOUT",
            _config.get("public_check", {}).get("page_timeout", 20),
        )
    )
    public_check_idle_min: float = float(
        os.environ.get(
            "XPILOT_PUBLIC_CHECK_IDLE_MIN",
            _config.get("public_check", {}).get("idle_min", 0.8),
        )
    )
    public_check_idle_max: float = float(
        os.environ.get(
            "XPILOT_PUBLIC_CHECK_IDLE_MAX",
            _config.get("public_check", {}).get("idle_max", 2.5),
        )
    )
    public_check_scrolls_min: int = int(
        os.environ.get(
            "XPILOT_PUBLIC_CHECK_SCROLLS_MIN",
            _config.get("public_check", {}).get("scrolls_min", 1),
        )
    )
    public_check_scrolls_max: int = int(
        os.environ.get(
            "XPILOT_PUBLIC_CHECK_SCROLLS_MAX",
            _config.get("public_check", {}).get("scrolls_max", 3),
        )
    )
    public_check_retry_attempts: int = int(
        os.environ.get(
            "XPILOT_PUBLIC_CHECK_RETRY_ATTEMPTS",
            _config.get("public_check", {}).get("retry_attempts", 4),
        )
    )
    public_check_retry_wait: float = float(
        os.environ.get(
            "XPILOT_PUBLIC_CHECK_RETRY_WAIT",
            _config.get("public_check", {}).get("retry_wait", 2.5),
        )
    )
    shadowban_page_timeout: int = int(
        os.environ.get(
            "XPILOT_SHADOWBAN_PAGE_TIMEOUT",
            _config.get("shadowban", {}).get("page_timeout", public_check_page_timeout),
        )
    )
    shadowban_retry_attempts: int = int(
        os.environ.get(
            "XPILOT_SHADOWBAN_RETRY_ATTEMPTS",
            _config.get("shadowban", {}).get("retry_attempts", 4),
        )
    )
    shadowban_retry_wait: float = float(
        os.environ.get(
            "XPILOT_SHADOWBAN_RETRY_WAIT",
            _config.get("shadowban", {}).get("retry_wait", 2.5),
        )
    )
    shadowban_method: str = (
        os.environ.get("XPILOT_SHADOWBAN_METHOD")
        or _config.get("shadowban", {}).get("method", "browser")
    )


settings = Settings()
