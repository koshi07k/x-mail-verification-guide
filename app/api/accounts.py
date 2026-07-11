"""アカウント管理 API"""

import asyncio
import html
import hashlib
import io
import logging
import re
import time
import zipfile
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel

from app.automation.login import (
    check_login_status,
    login_with_authtoken,
    login_with_cookies,
    login_with_credentials,
)
from app.api.tasks import create_task, update_task
from app.config import settings
from app.core.http_client import client_manager
from app.core.delays import between_accounts_delay
from app.core.parallel import run_parallel
from app.models.schemas import (
    AccountCreate,
    AccountResponse,
    AccountUpdate,
    BulkAccountImportRequest,
    BulkLoginRequest,
    CustomImportRequest,
    LoginRequest,
    PublicAccountCheckRequest,
    ShadowbanCheckRequest,
    ShadowbanSearchAccountRequest,
    ShadowbanSearchAccountUpdateRequest,
)
from app.storage.excel import (
    add_account,
    delete_account,
    load_accounts,
    save_accounts,
    update_account,
    update_login_status,
)

logger = logging.getLogger(__name__)
router = APIRouter()

_IMPORT_USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{1,15}$")
_IMPORT_URL_USERNAME_RE = re.compile(r"^/([A-Za-z0-9_]{1,15})(?:/|$)")
_IMPORT_RESERVED_USERNAMES = {
    "home", "explore", "i", "login", "signup", "search", "settings", "messages",
    "notifications", "compose", "tos", "privacy", "intent", "share",
}


def _normalize_import_username(raw: str) -> str:
    token = (raw or "").strip().strip(",")
    if not token:
        return ""

    if token.startswith("@"):
        token = token[1:]

    if _IMPORT_USERNAME_RE.fullmatch(token):
        return "" if token.lower() in _IMPORT_RESERVED_USERNAMES else token

    if token.lower().startswith(("http://", "https://")):
        try:
            parsed = urlparse(token)
        except Exception:
            return ""
        if parsed.netloc.lower() not in {"x.com", "www.x.com", "twitter.com", "www.twitter.com"}:
            return ""
        match = _IMPORT_URL_USERNAME_RE.search(parsed.path or "")
        if not match:
            return ""
        username = match.group(1)
        if not _IMPORT_USERNAME_RE.fullmatch(username):
            return ""
        return "" if username.lower() in _IMPORT_RESERVED_USERNAMES else username

    return ""


@router.get("", response_model=list[AccountResponse])
async def list_accounts():
    """アカウント一覧を取得"""
    accounts = load_accounts()
    return [
        AccountResponse(
            username=a["username"],
            email=a.get("email", ""),
            proxy=a.get("proxy", ""),
            login_method=a.get("login_method", "credentials"),
            status=a.get("status", "unknown"),
            last_login=a.get("last_login", ""),
            notes=a.get("notes", ""),
            edited_icon=a.get("edited_icon", ""),
            edited_name=a.get("edited_name", ""),
            edited_bio=a.get("edited_bio", ""),
            import_group=a.get("import_group", ""),
        )
        for a in accounts
    ]


@router.post("")
async def create_account(data: AccountCreate):
    """アカウントを追加"""
    account = {
        "username": data.username,
        "password": data.password,
        "email": data.email,
        "auth_token": data.auth_token,
        "proxy": data.proxy,
        "login_method": data.login_method,
        "status": "未ログイン",
        "last_login": "",
        "notes": data.notes,
    }
    try:
        add_account(account)
        return {"message": f"アカウント '{data.username}' を追加しました"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/{username}")
async def edit_account(username: str, data: AccountUpdate):
    """アカウント情報を更新"""
    updates = {k: v for k, v in data.model_dump().items() if v is not None}
    try:
        update_account(username, updates)
        return {"message": f"アカウント '{username}' を更新しました"}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/{username}/detail")
async def account_detail(username: str):
    """アカウントの全情報(機密含む)を返す"""
    accounts = load_accounts()
    account = next((a for a in accounts if a["username"] == username), None)
    if not account:
        raise HTTPException(status_code=404, detail=f"Account '{username}' not found")
    # パスワード・auth_token 等を含む全フィールドを返す
    return {
        "username": account.get("username", ""),
        "password": account.get("password", ""),
        "email": account.get("email", ""),
        "auth_token": account.get("auth_token", ""),
        "proxy": account.get("proxy", ""),
        "login_method": account.get("login_method", ""),
        "status": account.get("status", ""),
        "last_login": account.get("last_login", ""),
        "notes": account.get("notes", ""),
        "edited_icon": account.get("edited_icon", ""),
        "edited_name": account.get("edited_name", ""),
        "edited_bio": account.get("edited_bio", ""),
        "cookies": account.get("cookies", ""),
        "import_group": account.get("import_group", ""),
    }


class BulkPasswordUpdate(BaseModel):
    """一括パスワード変更のリクエスト"""
    password: str
    usernames: list[str] = []  # 空なら全アカウント


@router.post("/bulk-password")
async def bulk_password_update(req: BulkPasswordUpdate):
    """選択アカウントのパスワードを一括変更(ローカル保存のみ)"""
    accounts = load_accounts()
    if req.usernames:
        targets = [a for a in accounts if a["username"] in req.usernames]
    else:
        targets = accounts

    if not targets:
        raise HTTPException(status_code=400, detail="対象アカウントがありません")

    updated = 0
    for account in targets:
        account["password"] = req.password
        updated += 1

    save_accounts(accounts)
    return {"message": f"{updated}アカウントのパスワードを更新しました", "updated": updated}


class ChangePasswordRequest(BaseModel):
    """X側パスワード変更リクエスト"""
    new_password: str
    usernames: list[str] = []  # 空なら全アカウント


@router.post("/change-password")
async def change_password_on_x(req: ChangePasswordRequest):
    """X側のパスワードを実際に変更する (バックグラウンドタスク)"""
    from app.automation.password_changer import change_password

    accounts = load_accounts()
    if req.usernames:
        targets = [a for a in accounts if a["username"] in req.usernames]
    else:
        targets = [a for a in accounts if a.get("status") == "active"]

    if not targets:
        raise HTTPException(status_code=400, detail="対象のログイン済みアカウントがありません")

    # パスワードが保存されていないアカウントを除外
    valid_targets = [a for a in targets if a.get("password")]
    if not valid_targets:
        raise HTTPException(status_code=400, detail="現在のパスワードが保存されているアカウントがありません")

    task = create_task("change_password", len(valid_targets))

    async def _run():
        for i, account in enumerate(valid_targets):
            username = account["username"]
            current_pw = account.get("password", "")
            try:
                xclient = await client_manager.get_client(
                    username, proxy=account.get("proxy") or None
                )
                result = await change_password(xclient, username, current_pw, req.new_password)
                if result.get("success"):
                    # 成功したらローカル保存も更新
                    try:
                        update_account(username, {"password": req.new_password})
                    except Exception:
                        pass
                update_task(task["task_id"], progress=i + 1, result={
                    "username": username, **result,
                })
            except Exception as e:
                update_task(task["task_id"], progress=i + 1, result={
                    "username": username,
                    "success": False,
                    "message": str(e),
                })

            if i < len(valid_targets) - 1:
                await between_accounts_delay()

        update_task(task["task_id"], status="completed")

    asyncio.create_task(_run())
    return task


@router.delete("/{username}")
async def remove_account(username: str, reason: str = "manual"):
    """アカウントを削除（行動履歴付きアーカイブ保存）"""
    from app.storage.account_metadata import get_metadata, delete_metadata
    from app.storage.deleted_accounts import archive_account
    from app.config import settings
    import json as _json

    accounts = load_accounts()
    account = next((a for a in accounts if a["username"] == username), None)
    if not account:
        raise HTTPException(status_code=404, detail=f"Account '{username}' not found")

    # ── メタデータ取得 ──
    metadata = get_metadata(username) or {}

    # ── farming ジョブ履歴を収集 ──
    farming_jobs = []
    try:
        if settings.jobs_file.exists():
            jobs_data = _json.loads(settings.jobs_file.read_text("utf-8"))
            for batch in jobs_data.get("batches", []):
                user_jobs = [j for j in batch.get("jobs", []) if j.get("username") == username]
                if user_jobs:
                    farming_jobs.append({
                        "batch_id": batch.get("batch_id"),
                        "batch_name": batch.get("name"),
                        "mode": batch.get("mode"),
                        "created_at": batch.get("created_at"),
                        "jobs": user_jobs,
                    })
    except Exception as e:
        logger.warning("farming jobs 収集失敗 for %s: %s", username, e)

    # ── アーカイブに保存 ──
    archive_account(account, metadata=metadata, farming_jobs=farming_jobs, reason=reason)

    # ── 本体を削除 ──
    try:
        delete_account(username)
        delete_metadata(username)
        try:
            from app.scheduler.farming_scheduler import farming_config_manager

            farming_config_manager.unschedule_account(username)
            farming_config_manager.sync_managed_plan_accounts()
        except Exception as e:
            logger.warning("farming schedule cleanup failed for %s: %s", username, e)
        if client_manager.is_client_open(username):
            await client_manager.close_client(username)
        return {"message": f"アカウント '{username}' を削除しました（履歴はアーカイブに保存済み）"}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/{username}/login")
async def login_account(username: str, req: Optional[LoginRequest] = None):
    """単一アカウントをログイン"""
    accounts = load_accounts()
    account = next((a for a in accounts if a["username"] == username), None)
    if not account:
        raise HTTPException(status_code=404, detail=f"Account '{username}' not found")

    method = (req.method if req else "auto")
    if method == "auto":
        method = account.get("login_method", "credentials")

    if method == "cookie" and account.get("cookies"):
        result = await login_with_cookies(
            account_id=username,
            cookie_str=account["cookies"],
            proxy=account.get("proxy", ""),
        )
    elif method in ("authtoken", "cookie") and account.get("auth_token"):
        # cookie データがなくても auth_token があればフォールバック
        result = await login_with_authtoken(
            account_id=username,
            auth_token=account["auth_token"],
            proxy=account.get("proxy", ""),
        )
    elif account.get("password"):
        result = await login_with_credentials(
            account_id=username,
            username=username,
            password=account["password"],
            email=account.get("email", ""),
            proxy=account.get("proxy", ""),
        )
    else:
        raise HTTPException(status_code=400, detail="ログイン情報が不足しています")

    status = "active" if result["success"] else "error"
    try:
        update_login_status(username, status)
    except Exception:
        pass
    # メタデータ側の login_error / needs_admin_action をログイン結果に合わせて更新
    try:
        from app.storage.account_metadata import get_metadata, update_metadata as _upd
        current = (get_metadata(username) or {}).get("ops") or {}
        current["needs_admin_action"] = not result["success"]
        current["last_login_error"] = "" if result["success"] else result.get("message", "")
        _upd(username, {"ops": current})
    except Exception:
        pass

    return result


@router.post("/login-all")
async def login_all(req: Optional[BulkLoginRequest] = None):
    """一括ログイン(バックグラウンドタスク)"""
    accounts = load_accounts()
    if req and req.usernames:
        accounts = [a for a in accounts if a["username"] in req.usernames]

    if not accounts:
        raise HTTPException(status_code=400, detail="対象アカウントがありません")

    task = create_task("bulk_login", len(accounts))

    async def worker(account, _ctx):
        """ログインは独自にコンテキスト作成するので _ctx は使わない"""
        username = account["username"]
        method = account.get("login_method", "credentials")
        try:
            if method == "cookie" and account.get("cookies"):
                result = await login_with_cookies(
                    account_id=username,
                    cookie_str=account["cookies"],
                    proxy=account.get("proxy", ""),
                )
            elif method in ("authtoken", "cookie") and account.get("auth_token"):
                result = await login_with_authtoken(
                    account_id=username,
                    auth_token=account["auth_token"],
                    proxy=account.get("proxy", ""),
                )
            elif account.get("password"):
                result = await login_with_credentials(
                    account_id=username,
                    username=username,
                    password=account["password"],
                    email=account.get("email", ""),
                    proxy=account.get("proxy", ""),
                )
            else:
                result = {"success": False, "message": "ログイン情報なし"}

            status = "active" if result["success"] else "error"
            try:
                update_login_status(username, status)
            except Exception:
                pass
            try:
                from app.storage.account_metadata import get_metadata, update_metadata as _upd
                current = (get_metadata(username) or {}).get("ops") or {}
                current["needs_admin_action"] = not result["success"]
                current["last_login_error"] = "" if result["success"] else result.get("message", "")
                _upd(username, {"ops": current})
            except Exception:
                pass
            return {"username": username, **result}
        except Exception as e:
            update_task(task["task_id"], error=f"{username}: {e}")
            return None

    asyncio.create_task(
        run_parallel(task["task_id"], accounts, worker, max_concurrent=3, require_session=False)
    )
    return task


@router.post("/{username}/open")
async def open_account_in_browser(username: str):
    """アカウントを非ヘッドレスのブラウザウィンドウで開く(手動操作用)"""
    accounts = load_accounts()
    account = next((a for a in accounts if a["username"] == username), None)
    if not account:
        raise HTTPException(status_code=404, detail=f"Account '{username}' not found")

    result = await client_manager.open_interactive(
        account_id=username,
        proxy=account.get("proxy", ""),
    )  # httpxモードでは非対応 — エラーメッセージが返る
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("message", "起動失敗"))
    return result


@router.post("/{username}/close-browser")
async def close_account_browser(username: str):
    """対話ブラウザを閉じる"""
    await client_manager.close_interactive(username)  # httpxモードでは何もしない
    return {"message": f"@{username} のブラウザを閉じました"}


@router.get("/{username}/status")
async def account_status(username: str):
    """ログイン状態を確認"""
    accounts = load_accounts()
    account = next((a for a in accounts if a["username"] == username), None)
    if not account:
        raise HTTPException(status_code=404, detail=f"Account '{username}' not found")

    return await check_login_status(username, proxy=account.get("proxy", ""))


@router.get("/{username}/warmup")
async def account_warmup_status(username: str):
    """アカウント warmup フェーズを返す。

    imported_at が未記録なら active 扱い (既存アカウントの挙動を壊さない)。
    新規 import アカウントは 0-48h が readonly、48-120h が soft_ramp、
    それ以降が active。

    戻り値:
        {
            "username": ...,
            "tracked": bool,
            "phase": "readonly" | "soft_ramp" | "active",
            "imported_at": ISO8601 | None,
            "hours_since_import": float | None,
            "readonly_end_hours": float,
            "soft_ramp_end_hours": float,
            "allow_prob": float,
            "message": str,
        }
    """
    from app.core.warmup import get_warmup_status
    return get_warmup_status(username)


@router.post("/{username}/warmup/reset")
async def account_warmup_reset(username: str):
    """warmup タイマーをリセット (現在時刻から再スタート)。手動介入用。"""
    from datetime import datetime as _dt
    from app.core.session import merge_session_meta
    merged = merge_session_meta(
        username, {"imported_at": _dt.now().isoformat()}
    )
    if not merged:
        raise HTTPException(
            status_code=404,
            detail=f"session file not found for @{username}",
        )
    logger.info("Warmup timer reset for @%s", username)
    return {"username": username, "imported_at": merged.get("imported_at")}


@router.delete("/{username}/warmup")
async def account_warmup_clear(username: str):
    """warmup タイマーをクリア (imported_at を削除 → 即 active 扱い)。

    手動で "このアカウントは十分に慣らしたから通常運転で良い" と判断した時に使う。
    """
    from app.core.session import load_session_meta, merge_session_meta
    meta = load_session_meta(username)
    if not meta:
        raise HTTPException(
            status_code=404,
            detail=f"session file not found for @{username}",
        )
    # merge_session_meta は上書き merge なので、キー削除は別経路で実装
    import json
    from app.core.session import _session_path
    path = _session_path(username)
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"read failed: {e}")
    if isinstance(raw, dict) and "meta" in raw:
        raw["meta"].pop("imported_at", None)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(raw, f, ensure_ascii=False, indent=2)
    logger.info("Warmup imported_at cleared for @%s", username)
    return {"username": username, "imported_at": None, "phase": "active"}


@router.get("/warmup/candidates")
async def warmup_candidates(only_not_in_farming: bool = True):
    """warmup 対象としてマークすべきアカウントの候補を返す。

    data/sessions/ にセッションファイルが存在し、かつ `imported_at` が
    未記録のアカウントを列挙する。これらは「deploy 前に投入されたため
    warmup タイマーが付いていない」状態なので、育成に乗せる前に
    `POST /warmup/bulk-mark` でタイマーを開始するのが推奨。

    Query:
        only_not_in_farming: True (デフォルト) の場合、現在どの farming
            config にも入っていないアカウントだけを返す。既に育成中の
            アカウントは (意図せず readonly に戻されるのを防ぐため) 除外する。
    """
    from app.config import settings
    from app.core.session import load_session_meta
    from app.scheduler.farming_scheduler import farming_config_manager

    # 全 farming config から使われているアカウントを集める
    used_accounts: set[str] = set()
    for cfg in farming_config_manager._configs.values():
        for aid in cfg.get("account_ids", []):
            used_accounts.add(aid)

    candidates: list[dict] = []
    already_tracked: int = 0
    for path in sorted(settings.sessions_dir.glob("*.json")):
        username = path.stem
        meta = load_session_meta(username)
        if meta.get("imported_at"):
            already_tracked += 1
            continue
        in_farming = username in used_accounts
        if only_not_in_farming and in_farming:
            continue
        candidates.append({
            "username": username,
            "in_farming_config": in_farming,
            "imported_at": None,
        })

    return {
        "count": len(candidates),
        "already_tracked_count": already_tracked,
        "only_not_in_farming": only_not_in_farming,
        "candidates": candidates,
    }


class BulkWarmupMarkRequest(BaseModel):
    usernames: list[str]
    force: bool = False  # 既に imported_at があるアカウントも上書きするか
    imported_at: Optional[str] = None  # 省略時は現在時刻


@router.get("/warmup/list")
async def warmup_list(phase: Optional[str] = None):
    """現在追跡中 (imported_at 記録済み) のアカウント一覧を返す。

    各エントリに現在の phase, 残り時間, 次フェーズ予定時刻, allow_prob,
    farming config 参加状況, 直近のアクティビティ種別を含む。

    Query:
        phase: "readonly" / "soft_ramp" / "active" で絞り込み (省略時は全件)
    """
    from datetime import datetime as _dt, timedelta as _td
    from app.config import settings
    from app.core.session import load_session_meta
    from app.core.warmup import (
        READONLY_HOURS, SOFT_RAMP_END_HOURS, _soft_ramp_prob,
    )
    from app.scheduler.farming_scheduler import farming_config_manager

    # farming config に使われているアカウントを集める
    farming_accounts: set[str] = set()
    for cfg in farming_config_manager._configs.values():
        if not cfg.get("enabled", True):
            continue
        for aid in cfg.get("account_ids", []):
            farming_accounts.add(aid)

    # 直近 history entry を username ごとに最新 1 件だけ拾っておく
    latest_history: dict[str, dict] = {}
    try:
        for h in reversed(farming_config_manager._history[-1000:]):
            u = h.get("username")
            if u and u not in latest_history:
                latest_history[u] = h
    except Exception:
        pass

    results: list[dict] = []
    now = _dt.now()
    for path in sorted(settings.sessions_dir.glob("*.json")):
        username = path.stem
        meta = load_session_meta(username)
        iso = meta.get("imported_at")
        if not iso:
            continue  # imported_at 未記録は候補 API で別管理
        try:
            imported = _dt.fromisoformat(iso)
        except Exception:
            continue
        hrs = (now - imported).total_seconds() / 3600.0

        if hrs < READONLY_HOURS:
            current = "readonly"
            remaining_hours = READONLY_HOURS - hrs
            next_phase = "soft_ramp"
            allow_prob = 0.0
        elif hrs < SOFT_RAMP_END_HOURS:
            current = "soft_ramp"
            remaining_hours = SOFT_RAMP_END_HOURS - hrs
            next_phase = "active"
            allow_prob = _soft_ramp_prob(hrs)
        else:
            current = "active"
            remaining_hours = 0.0
            next_phase = None
            allow_prob = 1.0

        if phase and current != phase:
            continue

        next_phase_at = None
        if next_phase == "soft_ramp":
            next_phase_at = (imported + _td(hours=READONLY_HOURS)).isoformat()
        elif next_phase == "active":
            next_phase_at = (imported + _td(hours=SOFT_RAMP_END_HOURS)).isoformat()

        lh = latest_history.get(username) or {}
        results.append({
            "username": username,
            "imported_at": iso,
            "hours_since_import": round(hrs, 2),
            "phase": current,
            "remaining_hours": round(remaining_hours, 2),
            "next_phase": next_phase,
            "next_phase_at": next_phase_at,
            "allow_prob": round(allow_prob, 3),
            "in_farming_config": username in farming_accounts,
            "last_activity_at": lh.get("run_at"),
            "last_activity_status": lh.get("status"),
            "last_warmup_phase": lh.get("warmup_phase"),
            "last_warmup_steps": lh.get("warmup_steps"),
        })

    # phase 順 (readonly 優先) → 残り時間昇順
    phase_order = {"readonly": 0, "soft_ramp": 1, "active": 2}
    results.sort(
        key=lambda r: (phase_order.get(r["phase"], 99), r["remaining_hours"])
    )

    return {
        "now": now.isoformat(),
        "readonly_end_hours": READONLY_HOURS,
        "soft_ramp_end_hours": SOFT_RAMP_END_HOURS,
        "counts": {
            "total": len(results),
            "readonly": sum(1 for r in results if r["phase"] == "readonly"),
            "soft_ramp": sum(1 for r in results if r["phase"] == "soft_ramp"),
            "active": sum(1 for r in results if r["phase"] == "active"),
            "in_farming": sum(1 for r in results if r["in_farming_config"]),
        },
        "accounts": results,
    }


@router.get("/warmup/activity")
async def warmup_activity(limit: int = 50):
    """直近の warmup 関連 history entry を返す。

    farming_scheduler の history から `status == "warmup_readonly"` の
    エントリを抽出する。管理タブで「今どのアカウントが何をしたか」を
    時系列で見るのに使う。
    """
    from app.scheduler.farming_scheduler import farming_config_manager
    try:
        history = farming_config_manager._history
    except Exception:
        history = []
    entries: list[dict] = []
    for h in reversed(history):
        if h.get("status") != "warmup_readonly" and not h.get("warmup_phase"):
            continue
        entries.append({
            "username": h.get("username"),
            "run_at": h.get("run_at"),
            "status": h.get("status"),
            "warmup_phase": h.get("warmup_phase"),
            "warmup_hours": h.get("warmup_hours"),
            "warmup_reason": h.get("warmup_reason"),
            "warmup_steps": h.get("warmup_steps"),
            "warmup_errors": h.get("warmup_errors"),
            "config_id": h.get("config_id"),
        })
        if len(entries) >= limit:
            break
    return {"count": len(entries), "entries": entries}


@router.post("/warmup/bulk-mark")
async def warmup_bulk_mark(req: BulkWarmupMarkRequest):
    """複数アカウントの imported_at を一斉に現在時刻 (または指定時刻) で設定する。

    deploy 前に投入したアカウントや、手動で warmup を開始したいアカウントに
    対して使う。デフォルトは安全側 (`force=False`) で、既に imported_at が
    記録されているアカウントは上書きしない。

    Body:
        usernames: 対象アカウントのリスト
        force: 既存 imported_at も上書きするか (default: False)
        imported_at: タイマーの起点 ISO8601 (default: 現在時刻)
            過去の時刻を指定すれば "既に N 時間前から育成開始済み" 扱いも可能。
    """
    from datetime import datetime as _dt
    from app.core.session import load_session_meta, merge_session_meta

    now_iso = req.imported_at or _dt.now().isoformat()
    # 指定された場合は一応 parse して検証
    try:
        _dt.fromisoformat(now_iso)
    except Exception:
        raise HTTPException(
            status_code=400,
            detail=f"imported_at が ISO8601 形式ではありません: {now_iso}",
        )

    marked: list[str] = []
    skipped: list[dict] = []
    for username in req.usernames:
        if not client_manager.has_saved_session(username):
            skipped.append({"username": username, "reason": "no session file"})
            continue
        existing = load_session_meta(username).get("imported_at")
        if existing and not req.force:
            skipped.append({
                "username": username,
                "reason": "already tracked (use force=true to overwrite)",
                "existing_imported_at": existing,
            })
            continue
        merge_session_meta(username, {"imported_at": now_iso})
        marked.append(username)

    logger.info(
        "Bulk-marked %d accounts as newly imported (skipped %d, force=%s)",
        len(marked), len(skipped), req.force,
    )
    return {
        "marked_count": len(marked),
        "skipped_count": len(skipped),
        "imported_at": now_iso,
        "marked": marked,
        "skipped": skipped,
    }


@router.post("/shadowban-check")
async def bulk_shadowban_check(req: Optional[ShadowbanCheckRequest] = None):
    """検索結果ベースのシャドウバンチェック"""
    from app.automation.shadowban import (
        build_runtime_options as browser_build_runtime_options,
        check_accounts as browser_check_accounts,
        is_authoritative_result,
    )
    from app.automation.shadowban_graphql import (
        build_runtime_options as graphql_build_runtime_options,
        check_accounts as graphql_check_accounts,
    )
    from app.core.account_eligibility import shadowban_check_eligibility, shadowban_check_policy_label
    from app.storage.account_metadata import get_all_metadata as _get_all_meta
    from app.storage.account_metadata import update_bulk as _update_meta_bulk
    from app.storage.shadowban_history import append_shadowban_run

    accounts = load_accounts()
    if req and req.usernames:
        accounts = [a for a in accounts if a["username"] in req.usernames]

    metadata_lookup = _get_all_meta()
    original_count = len(accounts)
    policy_skipped = []
    eligible_accounts = []
    for account in accounts:
        username = account["username"]
        eligibility = shadowban_check_eligibility(account, metadata_lookup.get(username, {}))
        if eligibility["eligible"]:
            eligible_accounts.append(account)
        else:
            policy_skipped.append(eligibility)
    accounts = eligible_accounts

    if not accounts:
        raise HTTPException(
            status_code=400,
            detail=(
                "対象アカウントがありません "
                f"(条件: {shadowban_check_policy_label()}, "
                f"除外 {len(policy_skipped)}/{original_count} 件)"
            ),
        )

    task = create_task("shadowban_check", len(accounts))
    method = (req.method if req and req.method else settings.shadowban_method).lower()
    if method == "graphql":
        build_runtime_options = graphql_build_runtime_options
        check_accounts = graphql_check_accounts
    else:
        build_runtime_options = browser_build_runtime_options
        check_accounts = browser_check_accounts

    runtime = build_runtime_options(
        proxy=req.proxy if req else "",
        proxies=req.proxies if req else None,
        humanize=req.humanize if req else True,
        concurrency=req.concurrency if req else 3,
    )

    async def _run():
        from datetime import datetime
        try:
            logger.info(
                "Shadowban check: %d eligible / %d requested targets "
                "(%s, %d parallel, proxies=%d, humanize=%s)",
                len(accounts),
                original_count,
                method,
                runtime.concurrency,
                len(runtime.proxies or []),
                getattr(runtime, "humanize", True),
            )

            progress_counter = {"done": 0}
            metadata_updates: dict[str, dict] = {}

            def _on_progress(progress: int, result: dict):
                progress_counter["done"] = progress
                update_task(task["task_id"], progress=progress, result=result)
                if not is_authoritative_result(result):
                    return
                checked_at = result.get("checked_at") or datetime.now().isoformat()
                metadata_updates[result["username"]] = {
                    "shadowban": {
                        "search_ban": result.get("search_ban", False),
                        "top_search_ok": result.get("top_ok", False),
                        "latest_search_ok": result.get("latest_ok", False),
                        "search_status": result.get("search_status", ""),
                        "suspend": result.get("suspend", False),
                        "not_found": result.get("not_found", False),
                        "protect": result.get("protect", False),
                        "search_suggestion_ban": False,
                        "ghost_ban": False,
                        "reply_deboosting": False,
                        "media_ban": False,
                        "proxy": result.get("proxy", ""),
                        "top_attempts": result.get("top_attempts", 0),
                        "latest_attempts": result.get("latest_attempts", 0),
                        "checker_account_id": result.get("checker_account_id", ""),
                        "checker_label": result.get("checker_label", ""),
                        "checker_status": result.get("checker_status", ""),
                        "top_hit_tweet_id": result.get("top_hit_tweet_id", ""),
                        "latest_hit_tweet_id": result.get("latest_hit_tweet_id", ""),
                        "latest_post_tweet_id": result.get("latest_post_tweet_id", ""),
                        "latest_post_search_hit": result.get("latest_post_search_hit", False),
                        "latest_post_search_mode": result.get("latest_post_search_mode", ""),
                        "sensitive_limited": result.get("sensitive_limited", False),
                        "top_sensitive_filter": result.get("top_sensitive_filter", False),
                        "latest_sensitive_filter": result.get("latest_sensitive_filter", False),
                        "error": result.get("error", ""),
                    },
                    "checked_at": checked_at,
                }

            results = await asyncio.to_thread(
                check_accounts,
                [acc["username"] for acc in accounts],
                _on_progress,
                runtime,
            )
            if metadata_updates:
                _update_meta_bulk(metadata_updates)
            authoritative_results = [result for result in results if is_authoritative_result(result)]
            append_shadowban_run(
                run_id=f"manual-{task['task_id']}",
                source="manual",
                results=authoritative_results,
            )
            skipped_count = len(results) - len(authoritative_results)
            if results and not authoritative_results:
                update_task(
                    task["task_id"],
                    status="failed",
                    error="検索用アカウントが利用できず、全件未実行でした",
                )
            else:
                update_task(task["task_id"], status="completed")
            logger.info(
                "Shadowban check completed: %d/%d eligible (saved=%d skipped=%d policy_skipped=%d)",
                progress_counter["done"],
                len(accounts),
                len(authoritative_results),
                skipped_count,
                len(policy_skipped),
            )
        except Exception as e:
            logger.exception("Shadowban check failed")
            update_task(task["task_id"], status="failed", error=str(e))

    asyncio.create_task(_run())
    return task


@router.get("/shadowban-search-accounts")
async def list_shadowban_search_accounts():
    """シャドウバン検索用アカウント一覧"""
    from app.storage.shadowban_search_accounts import list_accounts

    rows = list_accounts(include_secret=False)
    return {
        "accounts": rows,
        "enabled_count": sum(1 for row in rows if row.get("enabled", True)),
        "total_count": len(rows),
    }


@router.post("/shadowban-search-accounts")
async def create_shadowban_search_account(req: ShadowbanSearchAccountRequest):
    """シャドウバン検索用アカウントを追加"""
    from app.storage.shadowban_search_accounts import add_account, list_accounts

    if not req.auth_token.strip():
        raise HTTPException(status_code=400, detail="Auth Token が空です")

    add_account(
        label=req.label,
        auth_token=req.auth_token,
        proxy=req.proxy,
        enabled=req.enabled,
    )
    rows = list_accounts(include_secret=False)
    return {
        "message": "検索用アカウントを追加しました",
        "accounts": rows,
        "enabled_count": sum(1 for row in rows if row.get("enabled", True)),
        "total_count": len(rows),
    }


@router.put("/shadowban-search-accounts/{account_id}")
async def update_shadowban_search_account(account_id: str, req: ShadowbanSearchAccountUpdateRequest):
    """シャドウバン検索用アカウントを更新"""
    from app.storage.shadowban_search_accounts import list_accounts, update_account

    updates = req.model_dump()
    if updates.get("auth_token") is not None and not str(updates.get("auth_token") or "").strip():
        raise HTTPException(status_code=400, detail="Auth Token が空です")

    row = update_account(account_id, updates)
    if not row:
        raise HTTPException(status_code=404, detail="検索用アカウントが見つかりません")
    rows = list_accounts(include_secret=False)
    return {
        "message": "検索用アカウントを更新しました",
        "accounts": rows,
        "enabled_count": sum(1 for row in rows if row.get("enabled", True)),
        "total_count": len(rows),
    }


@router.delete("/shadowban-search-accounts/{account_id}")
async def delete_shadowban_search_account(account_id: str):
    """シャドウバン検索用アカウントを削除"""
    from app.storage.shadowban_search_accounts import delete_account, list_accounts

    ok = delete_account(account_id)
    if not ok:
        raise HTTPException(status_code=404, detail="検索用アカウントが見つかりません")
    rows = list_accounts(include_secret=False)
    return {
        "message": "検索用アカウントを削除しました",
        "accounts": rows,
        "enabled_count": sum(1 for row in rows if row.get("enabled", True)),
        "total_count": len(rows),
    }


@router.post("/public-check")
async def public_account_check(req: PublicAccountCheckRequest):
    """公開Xアカウントの注意表示・凍結状態を txt からチェック"""
    from datetime import datetime

    from app.automation.public_account_checker import (
        build_runtime_options,
        check_targets,
        parse_targets,
    )
    from app.storage.public_account_checks import prepare_check_artifacts, save_latest_check

    usernames = parse_targets(req.text)
    if not usernames:
        raise HTTPException(
            status_code=400,
            detail="有効なユーザー名または x.com URL が見つかりません",
        )

    task = create_task("public_account_check", len(usernames))
    artifacts = prepare_check_artifacts(req.save_screenshots)
    runtime = build_runtime_options(
        proxy=req.proxy,
        proxies=req.proxies,
        humanize=req.humanize,
        concurrency=req.concurrency,
        save_screenshots=req.save_screenshots,
        screenshot_dir=artifacts["screenshot_dir"],
        screenshot_base_url=artifacts["screenshot_base_url"],
    )

    async def _run():
        try:
            results = await asyncio.to_thread(
                check_targets,
                usernames,
                lambda progress, result: update_task(
                    task["task_id"], progress=progress, result=result
                ),
                runtime,
            )
            save_latest_check(
                {
                    "created_at": datetime.now().isoformat(),
                    "total": len(results),
                    "results": results,
                    "proxy_enabled": bool(runtime.proxies),
                    "proxy_count": len(runtime.proxies or []),
                    "humanize": runtime.humanize,
                    "concurrency": runtime.concurrency,
                    "save_screenshots": runtime.save_screenshots,
                    "run_id": artifacts["run_id"],
                }
            )
            update_task(task["task_id"], status="completed")
        except Exception as e:
            logger.exception("公開アカウントチェック失敗")
            update_task(task["task_id"], status="failed", error=str(e))

    asyncio.create_task(_run())
    return {"task_id": task["task_id"], "total": len(usernames)}


@router.get("/public-check/latest")
async def get_latest_public_check():
    """直近の公開アカウントチェック結果を返す"""
    from app.storage.public_account_checks import load_latest_check

    return load_latest_check()


@router.get("/public-check/latest/restricted-screenshots.zip")
async def download_latest_restricted_screenshots():
    """直近チェック結果のうち制限系アカウントのスクリーンショットをZIPで返す"""
    from app.storage.public_account_checks import get_latest_restricted_screenshots, load_latest_check

    payload = load_latest_check()
    entries = get_latest_restricted_screenshots()
    if not entries:
        raise HTTPException(status_code=404, detail="制限系アカウントのスクリーンショットがありません")

    created_at = (payload.get("created_at") or "").replace(":", "").replace("-", "")
    zip_name = f"public-check-restricted-{created_at[:15] or 'latest'}.zip"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for idx, entry in enumerate(entries, start=1):
            ext = entry["path"].suffix or ".png"
            filename = f"{idx:02d}_{entry['status']}_{entry['username']}{ext}"
            zf.write(entry["path"], arcname=filename)
    buf.seek(0)

    headers = {
        "Content-Disposition": f'attachment; filename="{zip_name}"',
    }
    return StreamingResponse(buf, media_type="application/zip", headers=headers)


@router.get("/metadata")
async def get_accounts_metadata():
    """全アカウントのメタデータ (プロフィール情報・シャドウバン結果) を返す"""
    from app.storage.account_metadata import get_all_metadata
    return get_all_metadata()


@router.post("/fetch-stats")
async def fetch_account_stats(req: Optional[BulkLoginRequest] = None):
    """選択アカウントのプロフィール統計 (作成年・投稿数・フォロー/フォロワー) を、
    シャドウバンチェック用アカウント（認証済みブラウザセッション）で並列取得して
    メタデータキャッシュに保存する。並列数は有効チェッカー数に自動追随する。"""
    from app.automation.profile_harvester import build_runtime_options, harvest_profiles
    from app.storage.account_metadata import update_metadata as _update_meta
    from app.storage.shadowban_search_accounts import get_enabled_accounts

    accounts = load_accounts()
    if req and req.usernames:
        accounts = [a for a in accounts if a["username"] in req.usernames]

    if not accounts:
        raise HTTPException(status_code=400, detail="対象アカウントがありません")

    checker_accounts = get_enabled_accounts()
    if not checker_accounts:
        raise HTTPException(
            status_code=400,
            detail="有効なシャドウバンチェック用アカウントがありません。『シャドウバンチェック用アカウント』から追加してください。",
        )

    task = create_task("fetch_stats", len(accounts))
    runtime = build_runtime_options()

    async def _run():
        from datetime import datetime
        try:
            logger.info(
                "fetch-stats: %d targets, %d checker accounts (parallel=%d, humanize=%s)",
                len(accounts),
                len(checker_accounts),
                runtime.concurrency,
                runtime.humanize,
            )

            def _on_progress(progress: int, result: dict):
                username = result.get("username", "")
                if result.get("success"):
                    try:
                        _update_meta(
                            username,
                            {
                                "profile": {
                                    "followers_count": int(result.get("followers_count", 0) or 0),
                                    "following_count": int(result.get("following_count", 0) or 0),
                                    "statuses_count": int(result.get("statuses_count", 0) or 0),
                                    "created_at": result.get("created_at", "") or "",
                                    "display_name": result.get("display_name", "") or "",
                                    "bio": result.get("bio", "") or "",
                                },
                                "stats_fetched_at": datetime.now().isoformat(),
                                "stats_checker_id": result.get("checker_account_id", ""),
                                "stats_checker_label": result.get("checker_label", ""),
                            },
                        )
                    except Exception as e:
                        logger.warning("metadata update failed for %s: %s", username, e)
                update_task(
                    task["task_id"],
                    progress=progress,
                    result={
                        "username": username,
                        "success": bool(result.get("success")),
                        "error": result.get("error", ""),
                    },
                )

            await asyncio.to_thread(
                harvest_profiles,
                [acc["username"] for acc in accounts],
                _on_progress,
                runtime,
            )
            update_task(task["task_id"], status="completed")
            logger.info("fetch-stats completed for %d accounts", len(accounts))
        except Exception as e:
            logger.exception("fetch-stats failed")
            update_task(task["task_id"], status="failed", error=str(e))

    asyncio.create_task(_run())
    return task


@router.post("/import")
async def import_accounts_from_excel():
    """Excelファイルからアカウントを再読込"""
    accounts = load_accounts()
    return {"message": f"{len(accounts)} アカウントを読み込みました", "count": len(accounts)}


def _parse_account_line(line: str) -> dict | None:
    """1行のアカウント情報をパースする。

    対応形式:
      A) ID|PassWord|2FA Setup Key|BackUpMail|MailPassWord|auth_token=xxxx|...(Cookie等)
      B) 登录账号----登录密码----2FA----辅助邮箱----邮箱密码----token

    区切り文字を自動判定: "----" が含まれていれば形式B、それ以外は形式A("|" 区切り)。
    """
    line = line.strip()
    if not line:
        return None

    # ---- 形式判定 ----
    if "----" in line:
        return _parse_dash_format(line)
    return _parse_pipe_format(line)


def _parse_dash_format(line: str) -> dict | None:
    """形式B: username----password----mail----mailpass----SMSnumber----2fa----auth_token"""
    parts = [p.strip() for p in line.split("----")]
    if len(parts) < 2:
        return None

    username = _normalize_import_username(parts[0])
    password = parts[1] if len(parts) > 1 else ""
    backup_mail = parts[2] if len(parts) > 2 else ""
    mail_password = parts[3] if len(parts) > 3 else ""
    sms_number = parts[4] if len(parts) > 4 else ""
    two_fa_key = parts[5] if len(parts) > 5 else ""
    token_raw = parts[6] if len(parts) > 6 else ""

    if not username:
        return None

    # token フィールドの正規化: "auth_token=xxx" でも "xxx" でも受け付ける
    auth_token = token_raw
    if auth_token.lower().startswith("auth_token="):
        auth_token = auth_token.split("=", 1)[1].strip()

    login_method = "authtoken" if auth_token else "credentials"

    notes_parts = []
    if two_fa_key:
        notes_parts.append(f"2FA:{two_fa_key}")
    if mail_password:
        notes_parts.append(f"MailPW:{mail_password}")
    if sms_number:
        notes_parts.append(f"SMS:{sms_number}")

    return {
        "username": username,
        "password": password,
        "email": backup_mail,
        "auth_token": auth_token,
        "cookies": "",
        "proxy": "",
        "login_method": login_method,
        "status": "未ログイン",
        "last_login": "",
        "notes": " | ".join(notes_parts),
    }


def _parse_pipe_format(line: str) -> dict | None:
    """形式A: ID|PassWord|2FA Setup Key|BackUpMail|MailPassWord|auth_token=xxxx|..."""
    parts = line.split("|")
    if len(parts) < 2:
        return None

    username = _normalize_import_username(parts[0])
    password = parts[1].strip() if len(parts) > 1 else ""

    # parts[2]以降で auth_token= が出現する位置を特定
    # それより前のフィールドだけを 2FA / BackupMail / MailPassword として扱う
    auth_token = ""
    full_cookie_str = ""
    auth_idx = None
    for idx, part in enumerate(parts):
        if idx < 2:
            continue
        if part.strip().lower().startswith("auth_token="):
            auth_idx = idx
            break

    if auth_idx is not None:
        # auth_token フィールド以降を全て "|" で再結合 → Cookie文字列として保存
        cookie_tail = "|".join(parts[auth_idx:])
        full_cookie_str = cookie_tail.replace("|", "; ")

        raw_val = parts[auth_idx].strip().split("=", 1)[1].strip()
        auth_token = raw_val.split(";")[0].strip()

    # auth_token より前のフィールドを意味あるデータとして取得
    meaningful = parts[2:auth_idx] if auth_idx is not None else parts[2:]
    meaningful = [p for p in meaningful if "=" not in p or p.strip().lower().startswith("auth_token=")]

    two_fa_key = meaningful[0].strip() if len(meaningful) > 0 else ""
    backup_mail = meaningful[1].strip() if len(meaningful) > 1 else ""
    mail_password = meaningful[2].strip() if len(meaningful) > 2 else ""

    if not username:
        return None

    if full_cookie_str:
        login_method = "cookie"
    elif auth_token:
        login_method = "authtoken"
    else:
        login_method = "credentials"

    notes_parts = []
    if two_fa_key:
        notes_parts.append(f"2FA:{two_fa_key}")
    if mail_password:
        notes_parts.append(f"MailPW:{mail_password}")

    return {
        "username": username,
        "password": password,
        "email": backup_mail,
        "auth_token": auth_token,
        "cookies": full_cookie_str,
        "proxy": "",
        "login_method": login_method,
        "status": "未ログイン",
        "last_login": "",
        "notes": " | ".join(notes_parts),
    }


def _expand_import_lines(raw_text: str) -> list[str]:
    """インポートテキストを1アカウント1行に正規化する。

    形式B (----区切り) はアカウント間がスペース区切りで1行に複数並ぶ場合がある。
    例: "user1----pw1----...----tok1 user2----pw2----...----tok2"
    これを改行区切りの個別行に展開する。
    形式A (|区切り) は従来通り改行区切り。
    """
    lines: list[str] = []
    for raw_line in raw_text.strip().split("\n"):
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        # ---- 形式かつスペースを含む → スペースで分割して各チャンクを判定
        if "----" in raw_line and " " in raw_line:
            # スペースで分割し、---- を含むチャンクを1つのアカウントとする
            # ただし連続チャンクが ---- を含まない場合は前のチャンクに結合しない
            chunks = raw_line.split(" ")
            buf = ""
            for chunk in chunks:
                if not chunk:
                    continue
                if "----" in chunk:
                    # 前のバッファがあればフラッシュ
                    if buf:
                        lines.append(buf)
                    buf = chunk
                else:
                    # ---- を含まないチャンク = フィールド内のスペースの可能性は低い
                    # 新しいアカウントの開始(ユーザー名のみ等)と判断せず無視
                    # ただし buf が空なら形式A行かもしれないので単独追加
                    if buf:
                        buf += " " + chunk  # フィールド内スペース(まれ)
                    else:
                        lines.append(chunk)
            if buf:
                lines.append(buf)
        else:
            lines.append(raw_line)
    return lines


@router.post("/bulk-import")
async def bulk_import_accounts(req: BulkAccountImportRequest):
    """テキスト貼り付けによるアカウント一括インポート。

    対応形式:
      A) ID|PassWord|2FA|BackUpMail|MailPassWord|auth_token=xxxx  (改行区切り)
      B) user----pw----mail----mailpw----sms----2fa----token      (スペース区切りで複数)
    """
    from datetime import datetime

    lines = _expand_import_lines(req.text)
    if not lines:
        raise HTTPException(status_code=400, detail="テキストが空です")

    existing = load_accounts()
    existing_names = {a["username"] for a in existing}

    # 同時インポートされたアカウントに同じグループIDを付与
    group_id = datetime.now().strftime("imp_%Y%m%d_%H%M%S")

    imported = 0
    skipped = 0
    errors = []

    for i, line in enumerate(lines, 1):
        parsed = _parse_account_line(line)
        if parsed is None:
            if line.strip():
                errors.append(f"行{i}: パース失敗")
            continue
        if parsed["username"] in existing_names:
            skipped += 1
            errors.append(f"行{i}: @{parsed['username']} は既に登録済み")
            continue
        parsed["import_group"] = group_id
        existing.append(parsed)
        existing_names.add(parsed["username"])
        imported += 1

    if imported > 0:
        save_accounts(existing)
        try:
            from app.storage.llm_generation import assign_missing_prompt_profiles

            imported_names = [a["username"] for a in existing if a.get("import_group") == group_id]
            assign_missing_prompt_profiles(imported_names)
        except Exception as e:
            logger.warning("LLM prompt profile assignment failed after bulk import: %s", e)

    return {
        "message": f"{imported}アカウントをインポートしました" + (f" ({skipped}件スキップ)" if skipped else ""),
        "imported": imported,
        "skipped": skipped,
        "errors": errors,
    }


# ============================================================
# カスタムインポート (区切り文字 + フィールドマッピング指定)
# ============================================================
# マッピング可能なフィールド一覧
_CUSTOM_IMPORT_FIELDS = {
    "username", "password", "email", "auth_token", "cookies",
    "proxy", "notes", "login_method",
    # 特殊フィールド — notes にまとめる
    "2fa", "mail_password", "sms", "backup_code",
}


def _build_custom_import_account(parts: list[str], field_mapping: list[str], group_id: str = "") -> dict | None:
    acct: dict = {
        "username": "", "password": "", "email": "", "auth_token": "",
        "cookies": "", "proxy": "", "login_method": "credentials",
        "status": "未ログイン", "last_login": "", "notes": "",
        "edited_icon": "", "edited_name": "", "edited_bio": "",
        "import_group": group_id,
    }
    notes_extras: list[str] = []

    for col_idx, field_name in enumerate(field_mapping):
        if not field_name:
            continue
        val = parts[col_idx].strip() if col_idx < len(parts) else ""
        if not val:
            continue

        if field_name == "2fa":
            notes_extras.append(f"2FA:{val}")
        elif field_name == "mail_password":
            notes_extras.append(f"MailPW:{val}")
        elif field_name == "sms":
            notes_extras.append(f"SMS:{val}")
        elif field_name == "backup_code":
            notes_extras.append(f"BackupCode:{val}")
        elif field_name == "auth_token":
            if val.lower().startswith("auth_token="):
                val = val.split("=", 1)[1].strip()
            acct["auth_token"] = val
            if not acct["login_method"] or acct["login_method"] == "credentials":
                acct["login_method"] = "authtoken"
        elif field_name == "cookies":
            acct["cookies"] = val
            acct["login_method"] = "cookie"
        elif field_name == "username":
            acct["username"] = _normalize_import_username(val)
        elif field_name == "notes":
            notes_extras.append(val)
        else:
            acct[field_name] = val

    if notes_extras:
        existing_notes = acct.get("notes", "")
        all_notes = [existing_notes] + notes_extras if existing_notes else notes_extras
        acct["notes"] = " | ".join(all_notes)

    if not acct["username"]:
        return None
    return acct


def _expand_custom_lines(raw_text: str, delimiter: str, space_separator: bool) -> list[str]:
    """カスタムインポート用行展開。

    space_separator=True の場合、1行内で半角スペースを「次のアカウント」と見なす。
    ただし区切り文字自体がスペースの場合は無効化する。
    """
    out: list[str] = []
    for raw_line in raw_text.strip().split("\n"):
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        if space_separator and delimiter != " " and " " in raw_line:
            # スペースで分割 → 区切り文字を含むチャンクを1アカウントとみなす
            chunks = raw_line.split(" ")
            buf = ""
            for chunk in chunks:
                if not chunk:
                    continue
                if delimiter in chunk:
                    if buf:
                        out.append(buf)
                    buf = chunk
                else:
                    # 区切り文字を含まない断片 → 前のチャンクに結合 or 単独アカウント
                    if buf:
                        buf += " " + chunk
                    else:
                        out.append(chunk)
            if buf:
                out.append(buf)
        else:
            out.append(raw_line)
    return out


@router.post("/custom-import")
async def custom_import_accounts(req: CustomImportRequest):
    """区切り文字とフィールドマッピングを指定してアカウントを一括インポート"""
    from datetime import datetime

    if not req.text.strip():
        raise HTTPException(status_code=400, detail="テキストが空です")
    if not req.delimiter:
        raise HTTPException(status_code=400, detail="区切り文字が未指定です")
    if not req.field_mapping or all(not f for f in req.field_mapping):
        raise HTTPException(status_code=400, detail="フィールドマッピングが未指定です")
    if "username" not in req.field_mapping:
        raise HTTPException(status_code=400, detail="username 列の指定が必須です")

    # 無効なフィールド名チェック
    for f in req.field_mapping:
        if f and f not in _CUSTOM_IMPORT_FIELDS:
            raise HTTPException(status_code=400, detail=f"不明なフィールド: {f}")

    existing = load_accounts()
    existing_names = {a["username"] for a in existing}
    group_id = datetime.now().strftime("imp_%Y%m%d_%H%M%S")

    imported = 0
    skipped = 0
    errors: list[str] = []

    # スペース区切りモード対応の行展開
    expanded = _expand_custom_lines(req.text, req.delimiter, req.space_separator)

    for i, line in enumerate(expanded, 1):
        parts = line.split(req.delimiter)
        acct = _build_custom_import_account(parts, req.field_mapping, group_id)

        # バリデーション
        if not acct:
            errors.append(f"行{i}: username が空です")
            continue
        if acct["username"] in existing_names:
            skipped += 1
            errors.append(f"行{i}: @{acct['username']} は既に登録済み")
            continue

        existing.append(acct)
        existing_names.add(acct["username"])
        imported += 1

    if imported > 0:
        save_accounts(existing)

    return {
        "message": f"{imported}アカウントをインポートしました" + (f" ({skipped}件スキップ)" if skipped else ""),
        "imported": imported,
        "skipped": skipped,
        "errors": errors,
    }


# ============================================================
# アバター画像プロキシ（キャッシュ付き）
# ============================================================
_AVATAR_CACHE_DIR: Path | None = None
_AVATAR_CACHE_TTL = 3600 * 24 * max(1, settings.avatar_cache_ttl_days)
_AVATAR_BROWSER_CACHE_SECONDS = 3600 * 24

def _get_avatar_cache_dir() -> Path:
    global _AVATAR_CACHE_DIR
    if _AVATAR_CACHE_DIR is None:
        from app.config import BASE_DIR
        _AVATAR_CACHE_DIR = BASE_DIR / "data" / "avatar_cache"
        _AVATAR_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return _AVATAR_CACHE_DIR


@router.post("/avatar-cache/clear")
async def clear_avatar_cache():
    """アバターキャッシュを全クリア"""
    cache_dir = _get_avatar_cache_dir()
    count = 0
    for f in cache_dir.glob("*"):
        f.unlink(missing_ok=True)
        count += 1
    return {"message": f"{count}件のキャッシュを削除しました"}


@router.post("/avatar-cache/refresh-all")
async def refresh_all_avatars():
    """全アカウントのアバターをX.com GraphQL APIから一括再取得（バックグラウンド）"""
    accounts = load_accounts()
    if not accounts:
        raise HTTPException(status_code=400, detail="アカウントがありません")

    task = create_task("avatar_refresh", total=len(accounts))

    async def _worker():
        cache_dir = _get_avatar_cache_dir()
        success = 0
        failed = 0

        # ── 1) ログイン済みアカウントを探す ──
        logged_in_acc = None
        for acc in accounts:
            if client_manager.has_saved_session(acc["username"]):
                logged_in_acc = acc
                break

        xclient = None
        headers = None
        if logged_in_acc:
            try:
                from app.automation.x_api import (
                    _get_auth_headers, _api_get,
                    GRAPHQL_BASE,
                )
                xclient = await client_manager.get_client(
                    logged_in_acc["username"],
                    proxy=logged_in_acc.get("proxy") or None,
                )
                headers = _get_auth_headers(xclient)
            except Exception as e:
                logger.warning("Avatar refresh: API setup failed: %s", e)
                xclient = None

        _ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"

        for i, acc in enumerate(accounts):
            uname = acc["username"]
            avatar_url = None

            # ── GraphQL API で取得 (最も正確) ──
            if xclient and headers:
                try:
                    from app.automation.x_api import _api_get, GRAPHQL_BASE
                    import json as _json
                    from urllib.parse import quote as _quote

                    variables = {
                        "screen_name": uname,
                        "withSafetyModeUserFields": True,
                    }
                    features = {
                        "hidden_profile_subscriptions_enabled": True,
                        "responsive_web_graphql_exclude_directive_enabled": True,
                        "verified_phone_label_enabled": False,
                        "responsive_web_graphql_skip_user_profile_image_extensions_enabled": False,
                        "responsive_web_graphql_timeline_navigation_enabled": True,
                    }
                    url = (
                        f"{GRAPHQL_BASE}/k5XapwcSikNsEsILW5FvgA/UserByScreenName"
                        f"?variables={_quote(_json.dumps(variables))}"
                        f"&features={_quote(_json.dumps(features))}"
                    )
                    resp = await _api_get(xclient, url, headers)
                    if resp and resp.get("status") == 200:
                        legacy = (
                            resp.get("data", {})
                            .get("data", {})
                            .get("user", {})
                            .get("result", {})
                            .get("legacy", {})
                        )
                        raw_url = legacy.get("profile_image_url_https", "")
                        if raw_url:
                            for tag in ("_normal", "_bigger", "_mini", "_200x200"):
                                if tag in raw_url:
                                    raw_url = raw_url.replace(tag, "_400x400")
                                    break
                            avatar_url = raw_url
                except Exception as e:
                    logger.debug("GraphQL avatar failed for %s: %s", uname, e)

            # ── フォールバック: 外部サービス ──
            if not avatar_url:
                async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as hc:
                    for src in [
                        f"https://unavatar.io/x/{uname}",
                        f"https://abyss.to/api/avatar/x/{uname}",
                    ]:
                        try:
                            r = await hc.get(src, headers={"User-Agent": _ua, "Accept": "image/*"})
                            if r.status_code == 200 and len(r.content) > 500:
                                ct = r.headers.get("content-type", "")
                                if "image" in ct or len(r.content) > 1000:
                                    cache_path = cache_dir / f"{uname}.jpg"
                                    cache_path.write_bytes(r.content)
                                    success += 1
                                    avatar_url = "__saved__"
                                    break
                        except Exception:
                            continue

            # ── avatar_url を DL してキャッシュ ──
            if avatar_url and avatar_url != "__saved__":
                try:
                    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as hc:
                        r = await hc.get(avatar_url, headers={
                            "User-Agent": _ua,
                            "Referer": "https://x.com/",
                        })
                        if r.status_code == 200 and len(r.content) > 500:
                            cache_path = cache_dir / f"{uname}.jpg"
                            cache_path.write_bytes(r.content)
                            success += 1
                        else:
                            failed += 1
                except Exception:
                    failed += 1
            elif avatar_url != "__saved__":
                failed += 1

            update_task(task["task_id"], progress=i + 1)

        # ── クリーンアップ ──
        if logged_in_acc:
            client_manager.touch_client(logged_in_acc["username"])

        update_task(
            task["task_id"],
            status="completed",
            result={"success": success, "failed": failed},
        )
        logger.info("Avatar refresh done: success=%d, failed=%d", success, failed)

    asyncio.create_task(_worker())
    return {"task_id": task["task_id"], "total": len(accounts)}


# ── 個別アバター取得用ヘルパー ──
async def _fetch_avatar_external(
    username: str, http_client: httpx.AsyncClient
) -> bytes | None:
    """外部サービスからアバター画像バイナリを取得"""
    _ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
    for src_url in [
        f"https://unavatar.io/x/{username}",
        f"https://abyss.to/api/avatar/x/{username}",
    ]:
        try:
            resp = await http_client.get(src_url, headers={
                "User-Agent": _ua, "Accept": "image/*",
            })
            if resp.status_code == 200 and len(resp.content) > 500:
                ct = resp.headers.get("content-type", "")
                if "image" in ct or len(resp.content) > 1000:
                    return resp.content
        except Exception:
            continue
    return None


def _make_initial_svg(username: str) -> str:
    """イニシャルアバター SVG を生成"""
    initial = html.escape(username[0].upper() if username else "?")
    hue = int(hashlib.md5(username.encode()).hexdigest()[:6], 16) % 360
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
  <rect width="200" height="200" rx="100" fill="hsl({hue}, 40%, 30%)"/>
  <text x="100" y="130" text-anchor="middle" font-size="90" font-weight="bold"
        font-family="-apple-system, BlinkMacSystemFont, sans-serif" fill="hsl({hue}, 50%, 70%)">
    {initial}
  </text>
</svg>'''


@router.get("/{username}/avatar")
async def get_avatar(username: str, refresh: bool = False):
    """アバター画像を取得（通常はキャッシュのみ）。

    一覧画面からの大量表示で外部アバターサービスを叩かないため、通常アクセスでは
    キャッシュが無ければイニシャルSVGを返す。外部取得は手動一括更新、または
    refresh=1 / XPILOT_AVATAR_EXTERNAL_FETCH_ENABLED=1 の時だけ許可する。
    """
    cache_dir = _get_avatar_cache_dir()

    # ── キャッシュ存在チェック ──
    for ext in (".jpg", ".png", ".webp"):
        cache_file = cache_dir / f"{username}{ext}"
        if cache_file.exists():
            age = time.time() - cache_file.stat().st_mtime
            if age < _AVATAR_CACHE_TTL:
                ct = {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp"}
                return FileResponse(
                    cache_file,
                    media_type=ct.get(ext.lstrip("."), "image/jpeg"),
                    headers={"Cache-Control": f"public, max-age={_AVATAR_BROWSER_CACHE_SECONDS}"},
                )

    cache_file = cache_dir / f"{username}.jpg"

    if refresh or settings.avatar_external_fetch_enabled:
        async with httpx.AsyncClient(timeout=12.0, follow_redirects=True) as client:
            # ── 1) 外部サービス (明示更新時のみ) ──
            img_bytes = await _fetch_avatar_external(username, client)
            if img_bytes:
                cache_file.write_bytes(img_bytes)
                return FileResponse(
                    cache_file, media_type="image/jpeg",
                    headers={"Cache-Control": f"public, max-age={_AVATAR_BROWSER_CACHE_SECONDS}"},
                )

    # ── 2) 全ソース失敗 → イニシャル SVG ──
    svg = _make_initial_svg(username)
    return Response(
        content=svg, media_type="image/svg+xml",
        headers={"Cache-Control": f"public, max-age={_AVATAR_BROWSER_CACHE_SECONDS}"},
    )


# ============================================================
# 削除済みアカウント アーカイブ
# ============================================================
@router.get("/deleted/list")
async def list_deleted_accounts():
    """削除済みアカウントの一覧を返す"""
    from app.storage.deleted_accounts import list_deleted
    return list_deleted()


@router.delete("/deleted/{username}")
async def purge_deleted_account(username: str):
    """アーカイブから完全に削除"""
    from app.storage.deleted_accounts import delete_archive
    if delete_archive(username):
        return {"message": f"@{username} のアーカイブを完全に削除しました"}
    raise HTTPException(status_code=404, detail="アーカイブに見つかりません")


@router.delete("/deleted-all")
async def purge_all_deleted():
    """全アーカイブを削除"""
    from app.storage.deleted_accounts import clear_all
    count = clear_all()
    return {"message": f"{count}件のアーカイブを削除しました"}
