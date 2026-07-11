"""Pydantic モデル定義"""

from typing import Optional

from pydantic import BaseModel, Field


# --- Account ---
class AccountCreate(BaseModel):
    username: str
    password: str = ""
    email: str = ""
    auth_token: str = ""
    proxy: str = ""
    login_method: str = "credentials"  # "credentials" or "authtoken"
    notes: str = ""


class AccountUpdate(BaseModel):
    password: Optional[str] = None
    email: Optional[str] = None
    auth_token: Optional[str] = None
    proxy: Optional[str] = None
    login_method: Optional[str] = None
    notes: Optional[str] = None
    premium: Optional[bool] = None


class AccountResponse(BaseModel):
    username: str
    email: str
    proxy: str
    login_method: str
    status: str
    last_login: str
    notes: str
    edited_icon: str = ""
    edited_name: str = ""
    edited_bio: str = ""
    import_group: str = ""


# --- Login ---
class LoginRequest(BaseModel):
    method: str = "auto"  # "credentials", "authtoken", "auto"


class BulkLoginRequest(BaseModel):
    usernames: list[str] = []  # 空なら全アカウント


class ShadowbanCheckRequest(BaseModel):
    usernames: list[str] = Field(default_factory=list)
    proxy: str = ""
    proxies: list[str] = Field(default_factory=list)
    humanize: bool | None = None
    concurrency: int | None = None
    method: Optional[str] = "browser"  # "browser" or "graphql"


class ShadowbanSearchAccountRequest(BaseModel):
    label: str = ""
    auth_token: str
    proxy: str = ""
    enabled: bool = True


class ShadowbanSearchAccountUpdateRequest(BaseModel):
    label: Optional[str] = None
    auth_token: Optional[str] = None
    proxy: Optional[str] = None
    enabled: Optional[bool] = None


# --- Tweet ---
class TweetRequest(BaseModel):
    account_ids: list[str]
    text: str
    media_paths: list[str] = Field(default_factory=list)


class ScheduledTweetRequest(BaseModel):
    account_ids: list[str]
    text: str
    scheduled_at: str  # ISO形式: "2026-04-01T12:00:00"
    media_paths: list[str] = Field(default_factory=list)


# --- Profile ---
class ProfileUpdateRequest(BaseModel):
    account_ids: list[str]
    display_name: Optional[str] = None
    bio: Optional[str] = None
    icon_path: Optional[str] = None
    header_path: Optional[str] = None


# --- Profile (icon search / CSV bulk) ---
class IconSearchRequest(BaseModel):
    keyword: str
    max_results: int = 30
    offset: int = 0  # スクロール回数オフセット（次の30件用）


class IconApproveRequest(BaseModel):
    """承認した画像URLリスト + 適用先アカウント"""
    image_urls: list[str]  # ユーザーが承認した画像のフルURL
    account_ids: list[str]  # 適用先アカウント(上から順に割当)


class CSVProfileRow(BaseModel):
    display_name: str = ""
    bio: str = ""


class CSVProfileApplyRequest(BaseModel):
    rows: list[dict]  # [{display_name, bio, ...}, ...]
    account_ids: list[str]


class UsernameChangeApplyRequest(BaseModel):
    mappings: list[dict]  # [{current_username, new_username}, ...]
    account_ids: list[str] = []  # 対象アカウント（フロントから送る）


class BulkAccountImportRequest(BaseModel):
    text: str  # 複数行テキスト (1行1アカウント)


class CustomImportRequest(BaseModel):
    text: str                   # 複数行テキスト
    delimiter: str              # 区切り文字 ("|", "----", ":", ",", "\t", etc.)
    field_mapping: list[str]    # 列ごとのフィールド名 ["username","password","","email",...]
    space_separator: bool = False  # True = 半角スペースで次のアカウントに移行
    # 空文字列 = スキップ


class PublicAccountCheckRequest(BaseModel):
    text: str  # 1行1件: username / @username / https://x.com/username
    proxy: str = ""
    proxies: list[str] = Field(default_factory=list)
    humanize: bool = True
    concurrency: int = 1
    save_screenshots: bool = True


# --- Bulk Actions ---
class BulkActionRequest(BaseModel):
    account_ids: list[str]
    targets: list[str]  # URLまたはユーザー名
    concurrency: Optional[int] = None


# --- Farming (育成工場) ---
class FarmingConfigCreate(BaseModel):
    name: str = ""
    mode: str  # "template" | "random_template" | "target" | "unsplash"
    params: dict = {}
    account_ids: list[str]
    slots_per_day: int = 1
    hour_start: int = 9
    hour_end: int = 23
    auto_add_after_warmup: bool = False


class FarmingConfigUpdate(BaseModel):
    name: Optional[str] = None
    mode: Optional[str] = None
    params: Optional[dict] = None
    account_ids: Optional[list[str]] = None
    slots_per_day: Optional[int] = None
    hour_start: Optional[int] = None
    hour_end: Optional[int] = None
    enabled: Optional[bool] = None
    auto_add_after_warmup: Optional[bool] = None


class FarmingConfigAccountAppend(BaseModel):
    account_ids: list[str] = Field(default_factory=list)


class FarmingPreviewRequest(BaseModel):
    mode: str
    params: dict = {}


class NGWordsUpdate(BaseModel):
    words: list[str]


# --- Task ---
class TaskStatus(BaseModel):
    task_id: str
    action: str
    status: str  # "running", "completed", "failed", "cancelled"
    progress: int = 0
    total: int = 0
    errors: list[str] = []
    results: list[dict] = []
