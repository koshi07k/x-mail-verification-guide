"""GraphQL/API ベースのシャドウバンチェック

Shadowban-Test/X の考え方を参考に、ブラウザ検索に代わって X 内部 API を使って
シャドウバン状態を判定する。既存の browser 方式と結果スキーマを統一し、
下位コンポーネント（メタデータ保存・UI 表示・履歴）を変更せずに使える。

チェック方式:
  1. UserByScreenName      → 存在確認 / 凍結 / 鍵アカウント
  2. SearchTimeline (Top / Latest) with "from:username" → 検索表示有無
  3. 1.1/search/typeahead.json → 検索サジェスト有無
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Callable
from urllib.parse import quote

from curl_cffi.requests import AsyncSession

from app.automation.x_api import (
    _COMMON_FEATURES,
    _api_get,
    _ensure_op_ids,
    _get_auth_headers,
    _get_op_id,
)
from app.config import settings
from app.core.http_client import XClient
from app.core.x_transaction import PatchedClientTransaction
from app.storage.shadowban_search_accounts import get_enabled_accounts, set_account_status

logger = logging.getLogger(__name__)

_IMPERSONATE = "chrome136"


@dataclass
class GraphQLRuntimeOptions:
    proxies: list[str] | None = None
    concurrency: int = 1
    checker_accounts: list[dict] | None = None


def build_runtime_options(
    proxy: str = "",
    proxies: list[str] | None = None,
    humanize: bool | None = None,
    concurrency: int | None = None,
) -> GraphQLRuntimeOptions:
    """GraphQL シャドウバンチェック用の実行オプションを構築する。"""
    checker_accounts = get_enabled_accounts()
    desired_concurrency = concurrency if concurrency is not None else max(1, len(checker_accounts) or 1)
    return GraphQLRuntimeOptions(
        proxies=proxies or ([proxy] if proxy else []),
        concurrency=desired_concurrency,
        checker_accounts=checker_accounts,
    )


def _parse_proxy_url(proxy_url: str) -> str:
    """各種プロキシ表記を curl_cffi 用 URL に正規化する。"""
    raw = (proxy_url or "").strip()
    if not raw:
        return ""
    if raw.startswith(("http://", "https://", "socks")):
        return raw
    if "@" in raw:
        auth_part, server_part = raw.rsplit("@", 1)
        return f"http://{auth_part}@{server_part}"
    parts = raw.split(":")
    if len(parts) == 4:
        host, port, user, passwd = parts
        return f"http://{user}:{passwd}@{host}:{port}"
    if len(parts) == 2:
        return f"http://{raw}"
    logger.warning("Proxy format not recognized: %s", raw[:60])
    return f"http://{raw}"


async def _init_checker_xclient(checker: dict) -> XClient | None:
    """シャドウバン検索用アカウント用の XClient を auth_token から作成する。"""
    account_id = f"sbchk_{checker['id']}"
    proxy = (checker.get("proxy") or "").strip()
    auth_token = (checker.get("auth_token") or "").strip()
    if not auth_token:
        logger.warning("Checker %s has no auth_token", account_id)
        return None

    session_opts: dict = {"impersonate": _IMPERSONATE, "timeout": 30}
    if proxy:
        session_opts["proxy"] = _parse_proxy_url(proxy)

    try:
        client = AsyncSession(**session_opts)
    except Exception:
        logger.warning(
            "Impersonate '%s' not supported for checker %s, falling back to chrome124",
            session_opts.get("impersonate"),
            account_id,
        )
        session_opts["impersonate"] = "chrome124"
        try:
            client = AsyncSession(**session_opts)
        except Exception as e:
            logger.warning("Checker %s AsyncSession creation failed: %s", account_id, e)
            return None

    # auth_token を .x.com ドメインでセット
    try:
        client.cookies.set("auth_token", auth_token, domain=".x.com", path="/")
    except Exception as e:
        logger.warning("Checker %s cookie set failed: %s", account_id, e)
        try:
            await client.close()
        except Exception:
            pass
        return None

    xclient = XClient(account_id, client, ct0="", auth_token=auth_token)
    xclient._client_uuid = str(uuid.uuid4())
    xclient._client_transaction = PatchedClientTransaction()

    try:
        resp = await client.get("https://x.com")
        xclient.refresh_ct0()
        if not xclient.ct0:
            logger.warning(
                "Checker %s failed to bootstrap ct0 (status=%s)",
                account_id,
                getattr(resp, "status_code", "?"),
            )
            try:
                await client.close()
            except Exception:
                pass
            return None
    except Exception as e:
        logger.warning("Checker %s bootstrap failed: %s", account_id, e)
        try:
            await client.close()
        except Exception:
            pass
        return None

    # 認証済みかどうかの簡易確認 (twid cookie があれば OK)
    twid = ""
    try:
        twid = client.cookies.get("twid") or ""
    except Exception:
        pass
    if not twid:
        for cookie in client.cookies.jar:
            if getattr(cookie, "name", "") == "twid":
                twid = getattr(cookie, "value", "")
                break
    if not twid:
        logger.warning("Checker %s no twid cookie; auth_token may be invalid", account_id)
        try:
            await client.close()
        except Exception:
            pass
        return None

    # x-client-transaction-id 生成器を初期化（失敗しても継続）
    try:
        await xclient.ensure_transaction_ready()
    except Exception as e:
        logger.debug("Transaction init failed for %s: %s", account_id, e)

    return xclient


async def _ensure_checker_alive(xclient: XClient) -> None:
    """ct0 が切れている可能性があるので、必要に応じて x.com を叩いて更新する。"""
    try:
        if not xclient.ct0:
            await xclient.client.get("https://x.com")
            xclient.refresh_ct0()
    except Exception as e:
        logger.debug("Checker alive refresh failed for %s: %s", xclient.account_id, e)


def _search_features() -> dict:
    """SearchTimeline 用 features。"""
    return {
        **_COMMON_FEATURES,
        "responsive_web_grok_analyze_button_fetch_trends_enabled": False,
        "responsive_web_grok_analyze_post_followups_enabled": True,
        "responsive_web_grok_annotations_enabled": True,
        "responsive_web_grok_share_attachment_enabled": True,
        "responsive_web_grok_show_grok_translated_post": True,
        "responsive_web_jetfuel_frame": True,
        "rweb_tipjar_consumption_enabled": True,
        "creator_subscriptions_tweet_preview_api_enabled": True,
        "communities_web_enable_tweet_community_results_fetch": True,
        "c9s_tweet_anatomy_moderator_badge_enabled": True,
        "articles_preview_enabled": True,
        "longform_notetweets_rich_text_read_enabled": True,
        "longform_notetweets_inline_media_enabled": True,
    }


def _extract_tweet_count(instructions: list) -> int:
    """SearchTimeline の instructions から実ポスト数をカウントする。"""
    count = 0
    for instr in instructions or []:
        if instr.get("type") != "TimelineAddEntries":
            continue
        for entry in instr.get("entries", []):
            eid = entry.get("entryId", "")
            if "cursor" in eid or "promoted" in eid:
                continue
            content = entry.get("content", {})
            if content.get("entryType") == "TimelineTimelineItem":
                if content.get("itemContent", {}).get("tweet_results"):
                    count += 1
            elif content.get("entryType") == "TimelineTimelineModule":
                for item in content.get("items", []):
                    if item.get("item", {}).get("itemContent", {}).get("tweet_results"):
                        count += 1
    return count


async def _fetch_user(xclient: XClient, username: str) -> dict:
    """UserByScreenName を実行し、ユーザー状態を返す。"""
    headers = {
        k: v
        for k, v in _get_auth_headers(
            xclient, referer=f"https://x.com/{username}", method="GET"
        ).items()
        if k != "content-type"
    }
    variables = {
        "screen_name": username.lstrip("@"),
        "withSafetyModeUserFields": True,
    }
    features = {
        "hidden_profile_subscriptions_enabled": True,
        "rweb_tipjar_consumption_enabled": True,
        "responsive_web_graphql_exclude_directive_enabled": True,
        "verified_phone_label_enabled": False,
        "subscriptions_verification_info_is_identity_verified_enabled": True,
        "highlights_tweets_tab_ui_enabled": True,
        "responsive_web_graphql_skip_user_profile_image_extensions_enabled": False,
        "responsive_web_graphql_timeline_navigation_enabled": True,
    }
    op_id = _get_op_id("UserByScreenName")
    if not op_id:
        return {"api_error": True, "error": "UserByScreenName op id not available"}
    url = (
        f"https://x.com/i/api/graphql/{op_id}/UserByScreenName"
        f"?variables={quote(json.dumps(variables))}"
        f"&features={quote(json.dumps(features))}"
    )
    resp = await _api_get(xclient, url, headers)
    if resp is None:
        return {"api_error": True, "error": "API通信失敗"}
    if resp.get("status") != 200:
        return {"api_error": True, "error": f"HTTP {resp.get('status')}"}

    body = resp.get("data", {})
    errors = body.get("errors", [])
    if errors:
        first = errors[0]
        msg = first.get("message", "")
        code = first.get("code") or first.get("extensions", {}).get("code")
        if code == 50 or "not found" in msg.lower():
            return {"not_found": True}
        if code in (32, 215, 88, 89):
            return {"auth_error": True, "error": f"認証エラー ({code})"}
        return {"api_error": True, "error": f"APIエラー: {msg}"}

    user = body.get("data", {}).get("user", {}).get("result", {})
    typename = user.get("__typename", "")
    reason = user.get("reason", "")
    if typename == "UserUnavailable":
        if reason == "Suspended":
            return {"suspend": True}
        # その他の Unavailable も一旦 not_found 扱い
        return {"not_found": True, "error": reason}

    legacy = user.get("legacy", {})
    if user.get("rest_id") or legacy:
        return {
            "found": True,
            "user_id": user.get("rest_id"),
            "protect": bool(legacy.get("protected")),
            "screen_name": legacy.get("screen_name", username),
            "name": legacy.get("name"),
            "followers_count": legacy.get("followers_count"),
            "following_count": legacy.get("friends_count"),
            "statuses_count": legacy.get("statuses_count"),
            "created_at": legacy.get("created_at"),
        }
    return {"not_found": True}


async def _search_timeline(
    xclient: XClient,
    username: str,
    product: str,
) -> dict:
    """SearchTimeline を使って from:username の検索結果を取得する。"""
    op_id = _get_op_id("SearchTimeline")
    if not op_id:
        return {"has_tweets": False, "error": "SearchTimeline op id not available"}

    headers = {
        k: v
        for k, v in _get_auth_headers(
            xclient,
            referer=f"https://x.com/search?q=from%3A{username}&src=typed_query",
            method="GET",
        ).items()
        if k != "content-type"
    }
    variables = {
        "rawQuery": f"from:{username}",
        "count": 20,
        "querySource": "typed_query",
        "product": product,
    }
    url = (
        f"https://x.com/i/api/graphql/{op_id}/SearchTimeline"
        f"?variables={quote(json.dumps(variables))}"
        f"&features={quote(json.dumps(_search_features()))}"
    )
    resp = await _api_get(xclient, url, headers)
    if resp is None:
        return {"has_tweets": False, "error": "API通信失敗"}
    if resp.get("status") != 200:
        return {"has_tweets": False, "error": f"HTTP {resp.get('status')}"}

    body = resp.get("data", {})
    if body.get("errors"):
        first = body["errors"][0]
        return {
            "has_tweets": False,
            "error": f"APIエラー: {first.get('message', 'unknown')}",
        }

    instructions = (
        body.get("data", {})
        .get("search_by_raw_query", {})
        .get("search_timeline", {})
        .get("timeline", {})
        .get("instructions", [])
    )
    count = _extract_tweet_count(instructions)
    return {"has_tweets": count > 0, "count": count}


async def _typeahead(xclient: XClient, username: str) -> dict:
    """検索サジェスト API で対象ユーザーが表示されるか確認する。"""
    headers = {
        k: v
        for k, v in _get_auth_headers(
            xclient, referer="https://x.com/explore", method="GET"
        ).items()
        if k != "content-type"
    }
    url = (
        "https://x.com/i/api/1.1/search/typeahead.json"
        f"?q={quote(username)}&src=search_box&result_type=users"
    )
    resp = await _api_get(xclient, url, headers)
    if resp is None or resp.get("status") != 200:
        return {"banned": False, "error": "typeahead request failed"}

    users = resp.get("data", {}).get("users", [])
    found = any(
        (u.get("screen_name") or "").lower() == username.lower() for u in users
    )
    return {"banned": not found}


def _build_status_label(
    top_ok: bool,
    latest_ok: bool,
    suspend: bool,
    not_found: bool,
    protect: bool,
    error: str | None,
    sensitive_limited: bool = False,
) -> str:
    if error:
        return f"エラー: {error}"
    if suspend:
        return "凍結"
    if not_found:
        return "アカウント不明"
    if protect:
        return "鍵アカウント"
    if sensitive_limited:
        return "センシ限定"
    if top_ok and latest_ok:
        return "検索完全OK"
    if top_ok:
        return "話題のポストOK"
    if latest_ok:
        return "最新OK"
    return "検索表示なし"


def _base_result(username: str, checker: dict | None, **extra) -> dict:
    """browser 方式と統一した結果 dict の雛形。"""
    now = datetime.now().isoformat()
    return {
        "username": username,
        "screen_name": username,
        "top_ok": False,
        "latest_ok": False,
        "search_status": "未実行",
        "search_ban": False,
        "suspend": False,
        "not_found": False,
        "protect": False,
        "error": "",
        "checked_at": now,
        "top_url": f"https://x.com/search?q=from%3A{username}&src=typed_query",
        "latest_url": f"https://x.com/search?q=from%3A{username}&src=typed_query&f=live",
        "top_attempts": 0,
        "latest_attempts": 0,
        "proxy": "",
        "checker_account_id": checker["id"] if checker else "",
        "checker_label": checker.get("label", "") if checker else "",
        "checker_status": "unavailable",
        "top_hit_tweet_id": "",
        "latest_hit_tweet_id": "",
        "latest_post_tweet_id": "",
        "latest_post_search_hit": False,
        "latest_post_search_mode": "",
        "sensitive_limited": False,
        "top_sensitive_filter": False,
        "latest_sensitive_filter": False,
        "search_suggestion_ban": False,
        "no_tweet": False,
        "check_method": "graphql",
        **extra,
    }


async def _check_one(
    xclient: XClient,
    username: str,
    checker: dict,
    runtime: GraphQLRuntimeOptions,
) -> dict:
    proxy = checker.get("proxy") or (runtime.proxies[0] if runtime.proxies else "")
    await _ensure_checker_alive(xclient)

    try:
        _get_auth_headers(xclient, referer=f"https://x.com/{username}", method="GET")
    except ValueError as e:
        set_account_status(checker["id"], "invalid_auth", str(e))
        return _base_result(
            username,
            checker,
            error=f"検索用アカウント認証失敗: {e}",
            checker_status="invalid_auth",
            proxy=proxy,
        )

    user_info = await _fetch_user(xclient, username)
    if user_info.get("auth_error"):
        set_account_status(checker["id"], "invalid_auth", user_info["error"])
        return _base_result(
            username,
            checker,
            error=f"検索用アカウント認証失敗: {user_info['error']}",
            checker_status="invalid_auth",
            proxy=proxy,
        )
    if user_info.get("api_error"):
        return _base_result(
            username,
            checker,
            error=user_info["error"],
            checker_status="ready",
            proxy=proxy,
        )
    if user_info.get("not_found"):
        return _base_result(
            username,
            checker,
            not_found=True,
            search_status="アカウント不明",
            checker_status="ready",
            proxy=proxy,
        )
    if user_info.get("suspend"):
        return _base_result(
            username,
            checker,
            suspend=True,
            search_status="凍結",
            checker_status="ready",
            proxy=proxy,
        )

    protect = bool(user_info.get("protect"))
    if protect:
        search_status = "鍵アカウント"
        top_ok = False
        latest_ok = False
        search_ban = True
        no_tweet = False
        top_attempts = 0
        latest_attempts = 0
    else:
        top = await _search_timeline(xclient, username, "Top")
        latest = await _search_timeline(xclient, username, "Latest")
        top_ok = bool(top.get("has_tweets"))
        latest_ok = bool(latest.get("has_tweets"))
        no_tweet = not top_ok and not latest_ok
        search_ban = not (top_ok and latest_ok)
        search_status = _build_status_label(
            top_ok, latest_ok, False, False, False, None
        )
        top_attempts = 1
        latest_attempts = 1

    suggestion = await _typeahead(xclient, username)
    search_suggestion_ban = bool(suggestion.get("banned"))

    result = _base_result(
        username,
        checker,
        protect=protect,
        top_ok=top_ok,
        latest_ok=latest_ok,
        search_ban=search_ban,
        no_tweet=no_tweet,
        search_status=search_status,
        search_suggestion_ban=search_suggestion_ban,
        checker_status="ready",
        proxy=proxy,
        top_attempts=top_attempts,
        latest_attempts=latest_attempts,
    )
    # プロフィール統計を付加（あれば UI ですぐ確認できる）
    for key in ("name", "followers_count", "following_count", "statuses_count", "created_at"):
        if user_info.get(key) is not None:
            result[key] = user_info[key]
    return result


async def _check_all(
    usernames: list[str],
    progress_callback: Callable[[int, dict], None] | None,
    runtime: GraphQLRuntimeOptions,
) -> list[dict]:
    checker_accounts = runtime.checker_accounts or []
    if not checker_accounts:
        return [
            _base_result(u, None, error="検索用アカウントが登録されていません")
            for u in usernames
        ]

    xclients: list[tuple[dict, XClient]] = []
    for checker in checker_accounts:
        xc = await _init_checker_xclient(checker)
        if xc:
            xclients.append((checker, xc))
        else:
            set_account_status(checker["id"], "invalid_auth", "ct0/bootstrap failed")

    if not xclients:
        return [
            _base_result(u, None, error="有効な検索用アカウントがありません")
            for u in usernames
        ]

    # op id を 1 つ目の有効なクライアントで取得
    try:
        await _ensure_op_ids(xclients[0][1])
    except Exception as e:
        logger.warning("Op ID extraction failed: %s", e)
    if not _get_op_id("SearchTimeline"):
        logger.warning("SearchTimeline op id is not available; search checks may fail")

    semaphore = asyncio.Semaphore(max(1, runtime.concurrency))
    results: list[dict | None] = [None] * len(usernames)

    async def _task(index: int, username: str) -> None:
        checker, xc = xclients[index % len(xclients)]
        async with semaphore:
            try:
                result = await _check_one(xc, username, checker, runtime)
            except Exception as e:
                logger.exception("GraphQL shadowban check error for %s", username)
                result = _base_result(
                    username, checker, error=f"例外: {e}", checker_status="error", proxy=checker.get("proxy", "")
                )
            results[index] = result
            if progress_callback:
                progress_callback(index + 1, result)

    await asyncio.gather(*[_task(i, u) for i, u in enumerate(usernames)])

    for _, xc in xclients:
        try:
            await xc.client.close()
        except Exception:
            pass

    return [r for r in results if r is not None]


def check_accounts(
    usernames: list[str],
    progress_callback: Callable[[int, dict], None] | None = None,
    runtime: GraphQLRuntimeOptions | None = None,
) -> list[dict]:
    """複数アカウントを GraphQL/API でシャドウバンチェックする（browser 方式と同じ I/F）。"""
    runtime = runtime or build_runtime_options()
    if not usernames:
        return []

    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(_check_all(usernames, progress_callback, runtime))
    finally:
        loop.close()
