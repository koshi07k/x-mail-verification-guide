"""X 内部 API クライアント — httpx 直接版

httpx.AsyncClient で X の内部 GraphQL / REST API を直接叩く。
Playwright 不要 — Cookie ベース認証 (auth_token + ct0) のみ。
"""

import asyncio
import base64
import json
import logging
import random
import re
import math
from pathlib import Path
from typing import Optional, TYPE_CHECKING
from urllib.parse import quote, urlparse

from curl_cffi.requests.exceptions import ProxyError

from app.config import BASE_DIR
from app.core.delays import random_delay
from app.core.humanize import (
    pre_action_delay,
    post_action_delay,
    activity_multiplier,
    warmup_session,
)
from app.core.limiter import account_limiter

if TYPE_CHECKING:
    from app.core.http_client import XClient

logger = logging.getLogger(__name__)

# ── 定数 ──────────────────────────────────────────

BEARER_TOKEN = (
    "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs"
    "%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"
)

GRAPHQL_BASE = "https://x.com/i/api/graphql"
REST_BASE = "https://x.com/i/api/1.1"

_FALLBACK_OP_IDS = {
    "CreateTweet": "R5EPiGHgSqbTYFyozd-gFw",
    "FavoriteTweet": "lI07N6Otwv1PhnEgXILM7A",
    "UnfavoriteTweet": "ZYKSe-w7KEslx3JhSIk5LA",
    "CreateBookmark": "",
    "DeleteBookmark": "",
    "CreateRetweet": "ojPdsZsimiJrUGLR1sjVsA",
    "DeleteRetweet": "iQtK4dl5hBmXewYZuEOKVw",
    "UpdateProfile": "aB4Lhk3TpZITZqfDpGUFkQ",
    "UserByScreenName": "k5XapwcSikNsEsILW5FvgA",
    "UserTweets": "RyDU3I9VJtPF-Pnl6vrRlw",
    "UserTweetsAndReplies": "plVqzvVGaDxbFEPoOe_i-A",
    "UserMedia": "Ecl7YvFIuRaUPonVOHzoOA",
    # シャドウバンチェック (GraphQL方式) で from:username 検索に使用
    "SearchTimeline": "",
    # シャドウドロップ検知: 投稿後に tweet_id が実在するかを確認するのに使用
    "TweetResultByRestId": "tmhPpO5sDermwYmq3h034A",
    # warmup で HomeTimeline を叩くために使用
    "HomeTimeline": "HJFjzBgCs16TqxewQOeLNg",
}

_CREATE_TWEET_FEATURES = {
    "articles_preview_enabled": True,
    "c9s_tweet_anatomy_moderator_badge_enabled": True,
    "communities_web_enable_tweet_community_results_fetch": True,
    "content_disclosure_ai_generated_indicator_enabled": True,
    "content_disclosure_indicator_enabled": True,
    "freedom_of_speech_not_reach_fetch_enabled": True,
    "graphql_is_translatable_rweb_tweet_is_translatable_enabled": True,
    "longform_notetweets_consumption_enabled": True,
    "longform_notetweets_inline_media_enabled": False,
    "longform_notetweets_rich_text_read_enabled": True,
    "post_ctas_fetch_enabled": False,
    "premium_content_api_read_enabled": False,
    "profile_label_improvements_pcf_label_in_post_enabled": True,
    "responsive_web_edit_tweet_api_enabled": True,
    "responsive_web_graphql_skip_user_profile_image_extensions_enabled": False,
    "responsive_web_graphql_timeline_navigation_enabled": True,
    "responsive_web_grok_analysis_button_from_backend": True,
    "responsive_web_grok_analyze_button_fetch_trends_enabled": False,
    "responsive_web_grok_analyze_post_followups_enabled": True,
    "responsive_web_grok_annotations_enabled": True,
    "responsive_web_grok_community_note_auto_translation_is_enabled": True,
    "responsive_web_grok_image_annotation_enabled": True,
    "responsive_web_grok_imagine_annotation_enabled": True,
    "responsive_web_grok_share_attachment_enabled": True,
    "responsive_web_grok_show_grok_translated_post": True,
    "responsive_web_jetfuel_frame": True,
    "responsive_web_profile_redirect_enabled": False,
    "responsive_web_twitter_article_tweet_consumption_enabled": True,
    "rweb_cashtags_composer_attachment_enabled": True,
    "rweb_cashtags_enabled": True,
    "rweb_conversational_replies_downvote_enabled": False,
    "rweb_tipjar_consumption_enabled": False,
    "standardized_nudges_misinfo": True,
    "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled": True,
    "verified_phone_label_enabled": False,
    "view_counts_everywhere_api_enabled": True,
}

_COMMON_FEATURES = {
    "creator_subscriptions_quote_tweet_preview_enabled": True,
    "communities_web_enable_tweet_community_results_fetch": True,
    "c9s_tweet_anatomy_moderator_badge_enabled": True,
    "articles_preview_enabled": True,
    "responsive_web_edit_tweet_api_enabled": True,
    "graphql_is_translatable_rweb_tweet_is_translatable_enabled": True,
    "view_counts_everywhere_api_enabled": True,
    "longform_notetweets_consumption_enabled": True,
    "responsive_web_twitter_article_tweet_consumption_enabled": True,
    "tweet_awards_web_tipping_enabled": False,
    "creator_subscriptions_tweet_preview_api_enabled": True,
    "freedom_of_speech_not_reach_fetch_enabled": True,
    "standardized_nudges_misinfo": True,
    "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled": True,
    "rweb_video_timestamps_enabled": True,
    "longform_notetweets_rich_text_read_enabled": True,
    "longform_notetweets_inline_media_enabled": True,
    "responsive_web_graphql_exclude_directive_enabled": True,
    "verified_phone_label_enabled": False,
    "responsive_web_graphql_skip_user_profile_image_extensions_enabled": False,
    "responsive_web_graphql_timeline_navigation_enabled": True,
    "responsive_web_enhance_cards_enabled": False,
    "rweb_tipjar_consumption_enabled": True,
}

# ── 内部ストア ────────────────────────────────────

_op_ids: dict[str, str] = {}
_op_ids_loaded = False
_op_ids_loaded_at: float = 0.0  # 最後にop_idを取得した時刻
_OP_IDS_TTL = 4 * 3600  # 4時間でop_idを再取得

# ── アカウント毎のエラーバックオフ ──────────────────
import time as _time
import json as _backoff_json
from pathlib import Path as _BackoffPath

from app.config import BASE_DIR as _BACKOFF_BASE_DIR

_account_backoff: dict[str, float] = {}  # account_id -> 再試行可能な時刻
_account_backoff_reason: dict[str, str] = {}  # account_id -> 理由
_last_compose_nav_at: dict[str, float] = {}  # account_id -> unix ts
_last_profile_settings_nav_at: dict[str, float] = {}  # account_id -> unix ts
_COMPOSE_NAV_COOLDOWN = 15 * 60
_PROFILE_SETTINGS_NAV_COOLDOWN = 15 * 60
_DAILY_LIMIT_BACKOFF_HOURS = 72.0

_BACKOFF_FILE: _BackoffPath = _BACKOFF_BASE_DIR / "data" / "backoffs.json"


def _save_backoffs_to_disk() -> None:
    """現在のバックオフ状態をディスクに保存。期限切れは除外する。"""
    now = _time.time()
    data: dict[str, dict] = {}
    for aid, until in list(_account_backoff.items()):
        if until > now:
            data[aid] = {
                "until_ts": until,
                "reason": _account_backoff_reason.get(aid, ""),
            }
    try:
        _BACKOFF_FILE.parent.mkdir(parents=True, exist_ok=True)
        _BACKOFF_FILE.write_text(
            _backoff_json.dumps(data, ensure_ascii=False, indent=2),
            "utf-8",
        )
    except Exception as e:
        logger.warning("Failed to persist backoffs: %s", e)


def _load_backoffs_from_disk() -> None:
    """起動時にバックオフ状態を復元する。期限切れは読み捨て。"""
    if not _BACKOFF_FILE.exists():
        return
    try:
        data = _backoff_json.loads(_BACKOFF_FILE.read_text("utf-8"))
    except Exception as e:
        logger.warning("Failed to load backoffs: %s", e)
        return
    if not isinstance(data, dict):
        return
    now = _time.time()
    restored = 0
    for aid, info in data.items():
        if not isinstance(info, dict):
            continue
        try:
            until = float(info.get("until_ts") or 0)
        except (TypeError, ValueError):
            continue
        if until > now:
            _account_backoff[aid] = until
            _account_backoff_reason[aid] = info.get("reason", "")
            restored += 1
    if restored:
        logger.info("Restored %d active backoffs from disk", restored)


def is_account_backed_off(account_id: str) -> bool:
    """アカウントがバックオフ中かどうか"""
    until = _account_backoff.get(account_id, 0)
    return _time.time() < until


def _set_backoff(account_id: str, hours: float, reason: str) -> None:
    """アカウントにバックオフを設定してディスクに永続化"""
    _account_backoff[account_id] = _time.time() + hours * 3600
    _account_backoff_reason[account_id] = reason
    logger.warning("Backoff set for %s: %.1f hours (%s)", account_id, hours, reason)
    _save_backoffs_to_disk()


def get_backoff_info(account_id: str) -> dict | None:
    """特定アカウントのバックオフ情報を取得。未設定なら None。"""
    until = _account_backoff.get(account_id, 0)
    if _time.time() >= until:
        return None
    return {
        "account_id": account_id,
        "until_ts": until,
        "remaining_hours": (until - _time.time()) / 3600,
        "reason": _account_backoff_reason.get(account_id, ""),
    }


def list_backoffs() -> list[dict]:
    """現在バックオフ中の全アカウントを返す。"""
    now = _time.time()
    out = []
    for aid, until in list(_account_backoff.items()):
        if now < until:
            out.append({
                "account_id": aid,
                "until_ts": until,
                "remaining_hours": (until - now) / 3600,
                "reason": _account_backoff_reason.get(aid, ""),
            })
    return sorted(out, key=lambda x: -x["remaining_hours"])


def clear_backoff(account_id: str) -> bool:
    """バックオフをクリア (手動復帰用) してディスクに反映"""
    existed = account_id in _account_backoff
    _account_backoff.pop(account_id, None)
    _account_backoff_reason.pop(account_id, None)
    if existed:
        _save_backoffs_to_disk()
    return existed


# モジュール import 時に永続化済みバックオフを復元
_load_backoffs_from_disk()


def _should_visit_compose(account_id: str) -> bool:
    last_at = _last_compose_nav_at.get(account_id, 0.0)
    now = _time.time()
    if last_at <= 0 or (now - last_at) >= _COMPOSE_NAV_COOLDOWN:
        _last_compose_nav_at[account_id] = now
        return True
    return False


def _should_visit_profile_settings(account_id: str) -> bool:
    last_at = _last_profile_settings_nav_at.get(account_id, 0.0)
    now = _time.time()
    if last_at <= 0 or (now - last_at) >= _PROFILE_SETTINGS_NAV_COOLDOWN:
        _last_profile_settings_nav_at[account_id] = now
        return True
    return False


# ══════════════════════════════════════════════════
#  認証ヘッダー
# ══════════════════════════════════════════════════

def _get_auth_headers(xclient: "XClient", referer: str = "https://x.com/home", method: str = "POST") -> dict:
    """XClient から認証ヘッダーを構築 (同期)。ct0 は Cookie jar から毎回最新化。"""
    xclient.refresh_ct0()
    if not xclient.ct0 or not xclient.auth_token:
        raise ValueError(
            "認証Cookie (ct0, auth_token) が不足しています。先にログインしてください。"
        )
    headers = xclient.auth_headers(referer=referer)
    # 本物のChromeはPOSTのみcontent-typeを送る。GETには不要。
    if method.upper() == "POST":
        headers["content-type"] = "application/json"
    return headers


def _cookie_domain_rank(domain: str) -> int:
    d = (domain or "").lower()
    if d == ".x.com":
        return 0
    if d == "x.com":
        return 1
    if not d:
        return 2
    if "twitter.com" in d:
        return 3
    return 4


def _build_full_cookie_header(xclient: "XClient") -> str:
    """CreateTweet用に、保存済みCookie jar全体を明示Cookieヘッダー化する。

    研究用の直POST検証では auth_token/ct0 だけではなく、手動成功時に近い
    Cookieのまとまりを送る方が安定した。X-Pilotでは手動capture済みCookieが
    全アカウント分あるわけではないため、現行session jarから送信可能なCookieを
    まとめ、auth_token と ct0 は必ず補完する。
    """
    xclient.refresh_ct0()
    selected: dict[str, tuple[int, int, str]] = {}
    for idx, cookie in enumerate(xclient.client.cookies.jar):
        name = getattr(cookie, "name", "") or ""
        value = getattr(cookie, "value", None)
        if not name or value is None:
            continue
        rank = _cookie_domain_rank(getattr(cookie, "domain", "") or "")
        existing = selected.get(name)
        if existing is None or (rank, -idx) < (existing[0], -existing[1]):
            selected[name] = (rank, idx, str(value))

    if xclient.auth_token and "auth_token" not in selected:
        selected["auth_token"] = (0, len(selected), xclient.auth_token)
    if xclient.ct0:
        selected["ct0"] = (0, len(selected), xclient.ct0)

    ordered = sorted(selected.items(), key=lambda item: (item[1][0], item[1][1], item[0]))
    return "; ".join(f"{name}={value}" for name, (_, _, value) in ordered)


def _prepare_create_tweet_headers(xclient: "XClient") -> dict:
    """手動CreateTweetに近いヘッダーセットを組み立てる。"""
    headers = _get_auth_headers(xclient, referer="https://x.com/compose/post")
    cookie_header = _build_full_cookie_header(xclient)
    if cookie_header:
        headers["cookie"] = cookie_header
    headers.setdefault("priority", "u=1, i")
    headers.setdefault("sec-fetch-dest", "empty")
    headers.setdefault("sec-fetch-mode", "cors")
    headers.setdefault("sec-fetch-site", "same-origin")
    headers.setdefault("x-twitter-auth-type", "OAuth2Session")
    headers.setdefault("x-twitter-active-user", "yes")
    headers["x-twitter-client-language"] = "en"
    return headers


# ══════════════════════════════════════════════════
#  operation ID 自動取得
# ══════════════════════════════════════════════════

async def _ensure_op_ids(xclient: "XClient") -> None:
    """main.*.js から GraphQL operation ID を抽出してキャッシュ (4時間でリフレッシュ)"""
    global _op_ids, _op_ids_loaded, _op_ids_loaded_at
    if _op_ids_loaded and (_time.time() - _op_ids_loaded_at < _OP_IDS_TTL):
        return
    # TTL超過時はリセットして再取得
    if _op_ids_loaded:
        logger.info("Op IDs TTL expired (%.1fh), re-extracting...",
                     (_time.time() - _op_ids_loaded_at) / 3600)

    try:
        # x.com の HTML を取得して script タグの URL を抽出
        # 認証付きでアクセスし、Set-Cookie の ct0 更新を受け取る
        # curl_cffi impersonate が accept/UA を自動セットするため最小限に
        resp = await xclient.client.get("https://x.com")
        # Set-Cookie で ct0 が更新される → 反映
        xclient.refresh_ct0()
        html = resp.text

        # <script src="...main.*.js"> を正規表現で抽出
        script_urls = re.findall(r'src="(https://[^"]*?(?:main|api|endpoints|client-web)[^"]*?\.js)"', html)

        found: dict[str, str] = {}
        ops_to_find = set(_FALLBACK_OP_IDS.keys())

        for script_url in script_urls[:10]:
            try:
                js_resp = await xclient.client.get(script_url)
                js_text = js_resp.text
                if not js_text:
                    continue

                for op_name in list(ops_to_find):
                    patterns = [
                        rf'queryId:"([^"]+)",operationName:"{op_name}"',
                        rf'operationName:"{op_name}",queryId:"([^"]+)"',
                        rf'queryId:"([^"]+)"[^{{}}]*?operationName:"{op_name}"',
                    ]
                    for pat in patterns:
                        m = re.search(pat, js_text)
                        if m:
                            found[op_name] = m.group(1)
                            ops_to_find.discard(op_name)
                            logger.info("Found op ID: %s = %s", op_name, m.group(1))
                            break

                if not ops_to_find:
                    break
            except Exception as e:
                logger.debug("Script parse failed for %s: %s", script_url, e)

        if found:
            _op_ids.update(found)
            logger.info("Extracted %d operation IDs from JS bundles", len(found))
        else:
            logger.info("Could not extract op IDs from JS — using fallback")

    except Exception as e:
        logger.warning("Operation ID extraction failed: %s", e)

    _op_ids_loaded = True
    _op_ids_loaded_at = _time.time()


def _get_op_id(name: str) -> str:
    return _op_ids.get(name) or _FALLBACK_OP_IDS.get(name, "")


# ══════════════════════════════════════════════════
#  低レベル API 実行 (httpx 直接)
# ══════════════════════════════════════════════════

_PROXY_RETRY_DELAY = 2.0  # プロキシエラー時のリトライ待機秒
_MEDIA_APPEND_CHUNK_SIZE = 4 * 1024 * 1024
_MEDIA_STATUS_MAX_POLLS = 8
_MEDIA_UPLOAD_ATTEMPTS = 3
_MEDIA_UPLOAD_TIMEOUT = 75.0
_UPLOAD_PROXY_HTTP_STATUSES = {502, 503, 504}
_RETRYABLE_TRANSPORT_MARKERS = (
    "curl: (28)",
    "curl: (35)",
    "curl: (56)",
    "connection timed out",
    "connection closed abruptly",
    "connect tunnel failed",
    "proxy",
)


def _is_retryable_transport_error(exc: Exception) -> bool:
    if isinstance(exc, ProxyError):
        return True
    msg = str(exc).lower()
    return any(marker in msg for marker in _RETRYABLE_TRANSPORT_MARKERS)


def _check_resp_error(resp: dict | None, **extra) -> dict | None:
    """resp が None またはプロキシエラーなら失敗 dict を返す。正常なら None。"""
    if resp is None:
        return {"success": False, "message": "API応答なし", **extra}
    if resp.get("proxy_error"):
        return {
            "success": False,
            "message": "プロキシ接続エラー（リトライ後も失敗）",
            "proxy_error": resp.get("proxy_error") or "",
            **extra,
        }
    return None


async def _inject_real_tid(
    xclient: "XClient", url: str, headers: dict, method: str
) -> dict:
    """headers に本物の x-client-transaction-id を注入して返す。

    初期化していなければ ensure_transaction_ready() を呼ぶ (本来は最初の API
    呼び出しで一度だけ発火)。初期化失敗時は fake TID が入った状態のまま返る。

    元の headers は変更せず、新しい dict を返す (呼び出し元の共有を回避)。
    """
    try:
        await xclient.ensure_transaction_ready()
    except Exception as e:
        logger.debug("ensure_transaction_ready failed (non-fatal): %s", e)
    try:
        path = urlparse(url).path
        tid = xclient.generate_transaction_id(method=method, path=path)
        if tid:
            headers = {**headers, "x-client-transaction-id": tid}
    except Exception as e:
        logger.debug("generate_transaction_id failed (non-fatal): %s", e)
    return headers


async def _api_get(xclient: "XClient", url: str, headers: dict) -> dict | None:
    """GET リクエスト (ProxyError は 1 回リトライ)"""
    headers = await _inject_real_tid(xclient, url, headers, "GET")
    for attempt in range(2):
        try:
            resp = await xclient.client.get(url, headers=headers)
            try:
                data = resp.json()
            except Exception:
                logger.warning("API GET non-JSON response (%d): %s", resp.status_code, resp.text[:200])
                return {"status": resp.status_code, "data": {}}
            return {"status": resp.status_code, "data": data}
        except ProxyError as e:
            logger.warning("API GET proxy error (attempt %d/2): %s", attempt + 1, e)
            if attempt == 0:
                await asyncio.sleep(_PROXY_RETRY_DELAY)
                continue
            return {"status": -1, "data": {}, "proxy_error": str(e)}
        except Exception as e:
            logger.warning("API GET error: %s: %s", type(e).__name__, e)
            return None


async def _api_post(xclient: "XClient", url: str, headers: dict, body: dict) -> dict | None:
    """POST リクエスト (ProxyError は 1 回リトライ)"""
    headers = await _inject_real_tid(xclient, url, headers, "POST")
    for attempt in range(2):
        try:
            resp = await xclient.client.post(url, headers=headers, json=body)
            try:
                data = resp.json()
            except Exception:
                logger.warning("API POST non-JSON response (%d): %s", resp.status_code, resp.text[:200])
                return {"status": resp.status_code, "data": {}}
            return {"status": resp.status_code, "data": data}
        except ProxyError as e:
            logger.warning("API POST proxy error (attempt %d/2): %s", attempt + 1, e)
            if attempt == 0:
                await asyncio.sleep(_PROXY_RETRY_DELAY)
                continue
            return {"status": -1, "data": {}, "proxy_error": str(e)}
        except Exception as e:
            logger.warning("API POST error: %s: %s", type(e).__name__, e)
            return None


async def _api_post_form(xclient: "XClient", url: str, headers: dict, data: dict) -> dict | None:
    """POST リクエスト form-urlencoded (ProxyError は 1 回リトライ)"""
    headers = await _inject_real_tid(xclient, url, headers, "POST")
    form_headers = dict(headers)
    if str(form_headers.get("content-type") or "").lower().startswith("application/json"):
        form_headers["content-type"] = "application/x-www-form-urlencoded"
    form_headers.setdefault("content-type", "application/x-www-form-urlencoded")
    for attempt in range(2):
        try:
            resp = await xclient.client.post(
                url,
                headers=form_headers,
                data=data,
            )
            try:
                rdata = resp.json()
            except Exception:
                logger.warning("API POST form non-JSON (%d): %s", resp.status_code, resp.text[:200])
                return {"status": resp.status_code, "data": {}}
            return {"status": resp.status_code, "data": rdata}
        except ProxyError as e:
            logger.warning("API POST form proxy error (attempt %d/2): %s", attempt + 1, e)
            if attempt == 0:
                await asyncio.sleep(_PROXY_RETRY_DELAY)
                continue
            return {"status": -1, "data": {}, "proxy_error": str(e)}
        except Exception as e:
            logger.warning("API POST form error: %s: %s", type(e).__name__, e)
            return None


# ══════════════════════════════════════════════════
#  公開 API: ツイート投稿
# ══════════════════════════════════════════════════

async def api_post_tweet(
    xclient: "XClient",
    text: str,
    media_ids: list[str] | None = None,
    *,
    _session_retry: bool = False,
) -> dict:
    """GraphQL CreateTweet でツイートを投稿"""
    try:
        # バックオフ中のアカウントはスキップ
        if is_account_backed_off(xclient.account_id):
            return {"success": False, "message": "アカウントがクールダウン中です (226/344エラーによるバックオフ)"}

        # 日次/時間制限チェック
        if not account_limiter.can_act(xclient.account_id, "tweet"):
            return {"success": False, "message": "アカウントの日次ツイート制限に達しています"}

        try:
            from app.automation.session_capture import refresh_before_post_if_needed

            pre_capture = await refresh_before_post_if_needed(xclient)
            if pre_capture.get("attempted"):
                logger.info(
                    "Pre CreateTweet session capture for @%s: %s",
                    xclient.account_id,
                    pre_capture,
                )
        except Exception as e:
            logger.debug(
                "pre CreateTweet session capture skipped for @%s: %s",
                xclient.account_id,
                e,
            )

        await _ensure_op_ids(xclient)

        # ウォームアップ: タイムライン閲覧等で閲覧痕跡を残す
        await warmup_session(xclient)

        # /compose/post ページへの HTML ナビゲーションを再現
        # 本物の Chrome は「ツイートする」ボタンで /compose/post に遷移してから
        # CreateTweet を POST する。referer だけ偽装するのではなく実際に GET する。
        if _should_visit_compose(xclient.account_id):
            try:
                from app.core.fingerprint import get_page_client_hints, get_accept_language
                compose_page_headers = {
                    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
                    "accept-language": get_accept_language(xclient.account_id),
                    "sec-fetch-dest": "document",
                    "sec-fetch-mode": "navigate",
                    "sec-fetch-site": "same-origin",
                    "sec-fetch-user": "?1",
                    "upgrade-insecure-requests": "1",
                    "referer": "https://x.com/home",
                }
                compose_page_headers.update(get_page_client_hints(xclient.account_id))
                await xclient.client.get("https://x.com/compose/post", headers=compose_page_headers)
                xclient.refresh_ct0()
                await asyncio.sleep(random.uniform(1.0, 3.0))
            except Exception as e:
                logger.debug("compose/post navigation error (non-fatal): %s", e)

        headers = _prepare_create_tweet_headers(xclient)
        op_id = _get_op_id("CreateTweet")

        media_entities = []
        if media_ids:
            media_entities = [{"media_id": mid, "tagged_users": []} for mid in media_ids]

        variables = {
            "tweet_text": text,
            "media": {
                "media_entities": media_entities,
                "possibly_sensitive": False,
            },
            "semantic_annotation_ids": [],
            "semantic_annotation_options": {
                "source": "Profile",
            },
            "disallowed_reply_options": None,
        }

        body = {
            "variables": variables,
            "features": _CREATE_TWEET_FEATURES,
            "queryId": op_id,
        }

        url = f"{GRAPHQL_BASE}/{op_id}/CreateTweet"
        await pre_action_delay()

        resp = await _api_post(xclient, url, headers, body)
        # POST後にct0が更新されることがある
        xclient.refresh_ct0()
        err = _check_resp_error(resp)
        if err:
            return err

        status = resp.get("status", 0)
        data = resp.get("data", {})
        logger.info("CreateTweet response (%d): %s", status, str(data)[:500])

        if status == 200:
            errors = data.get("errors", [])
            if errors:
                err_code = errors[0].get("code", 0)
                err_msg = errors[0].get("message", str(errors[0]))
                if err_code == 353 and not _session_retry:
                    try:
                        from app.automation.session_capture import refresh_after_write_error

                        capture_result = await refresh_after_write_error(
                            xclient,
                            error_code=err_code,
                            message=err_msg,
                        )
                        if capture_result.get("success"):
                            retry_result = await api_post_tweet(
                                xclient,
                                text,
                                media_ids,
                                _session_retry=True,
                            )
                            retry_result["session_capture"] = capture_result
                            retry_result["session_retry_after_error"] = 353
                            return retry_result
                    except Exception as e:
                        logger.warning(
                            "Session capture retry failed for @%s after 353: %s",
                            xclient.account_id,
                            e,
                        )
                # バックオフ設定 (ここでは暫定値、本格的な隔離は farming_scheduler で処理)
                if err_code == 226:
                    _set_backoff(xclient.account_id, 8.0, "error 226 bot detection")
                elif err_code == 344:
                    _set_backoff(
                        xclient.account_id,
                        _DAILY_LIMIT_BACKOFF_HOURS,
                        "error 344 write throttle",
                    )
                elif err_code == 326:
                    _set_backoff(xclient.account_id, 48.0, "error 326 account locked")
                    logger.warning(
                        "Account @%s is LOCKED by X — manual unlock required "
                        "(usually phone verification)", xclient.account_id
                    )
                elif err_code == 64:
                    _set_backoff(xclient.account_id, 168.0, "error 64 account suspended")
                    logger.warning("Account @%s is SUSPENDED by X", xclient.account_id)
                elif err_code == 37:
                    # "Missing TwitterUserNotSuspended" = 実質凍結
                    _set_backoff(xclient.account_id, 168.0, "error 37 (Missing TwitterUserNotSuspended)")
                    logger.warning(
                        "Account @%s is SUSPENDED by X (code 37 Missing TwitterUserNotSuspended)",
                        xclient.account_id,
                    )
                elif err_code in (32, 88, 89, 215):
                    _set_backoff(xclient.account_id, 12.0, f"error {err_code} auth issue")
                return {
                    "success": False,
                    "error_code": err_code,
                    "message": f"ツイート失敗: {err_msg}",
                }

            tweet_result = (
                data.get("data", {})
                .get("create_tweet", {})
                .get("tweet_results", {})
                .get("result", {})
            )
            tweet_id = tweet_result.get("rest_id", "")

            if not tweet_id:
                logger.warning(
                    "CreateTweet 200 but no tweet_id for @%s. "
                    "tweet_results=%s  full_keys=%s",
                    xclient.account_id,
                    data.get("data", {}).get("create_tweet", {}).get("tweet_results"),
                    list(data.get("data", {}).keys()) if isinstance(data.get("data"), dict) else str(data)[:300],
                )
                return {
                    "success": False,
                    "empty_result": True,
                    "message": "ツイート失敗: tweet_idが返されませんでした (セッション劣化の可能性)",
                }

            logger.info("Tweet posted via API: %s (id=%s)", text[:50], tweet_id)
            account_limiter.record(xclient.account_id, "tweet")
            await post_action_delay()

            return {
                "success": True,
                "message": "ツイート投稿完了 (API)",
                "tweet_id": tweet_id,
            }

        errors = data.get("errors", [])
        err_msg = errors[0].get("message", str(data)) if errors else str(data)
        return {"success": False, "message": f"ツイート失敗 ({status}): {err_msg}"}

    except Exception as e:
        logger.debug("api_post_tweet error: %s", e)
        return {"success": False, "message": f"ツイート失敗: {str(e)}"}


async def _fetch_status_page_html(
    xclient: "XClient",
    screen_name: str,
    tweet_id: str,
) -> bool:
    """本物のブラウザが自分のツイートを確認する時の最初のステップを再現する。

    ユーザがコンポーズ直後に "投稿できたか" を目視で確認する流れは、
    TL から当該ツイートをクリック → `/{username}/status/{tweet_id}` に SPA 遷移、
    になる。SPA 遷移でも最初のページロードだけは HTML として取得されるので、
    本関数はその最初の HTML GET を再現する。

    これを通しておくと、続く GraphQL `TweetResultByRestId` 呼び出しの
    referer が自然な "status 画面からのリクエスト" になる。

    戻り値: HTML 取得に成功したかどうか (失敗しても verify は続行)
    """
    try:
        from app.core.fingerprint import get_page_client_hints, get_accept_language
        page_headers = {
            "accept": (
                "text/html,application/xhtml+xml,application/xml;q=0.9,"
                "image/avif,image/webp,image/apng,*/*;q=0.8,"
                "application/signed-exchange;v=b3;q=0.7"
            ),
            "accept-language": get_accept_language(xclient.account_id),
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "same-origin",
            "sec-fetch-user": "?1",
            "upgrade-insecure-requests": "1",
            "referer": f"https://x.com/{screen_name}",
        }
        page_headers.update(get_page_client_hints(xclient.account_id))
        url = f"https://x.com/{screen_name}/status/{tweet_id}"
        resp = await xclient.client.get(url, headers=page_headers)
        xclient.refresh_ct0()
        return resp.status_code == 200
    except Exception as e:
        logger.debug("_fetch_status_page_html error for %s/%s: %s",
                     screen_name, tweet_id, e)
        return False


async def api_verify_tweet_exists(
    xclient: "XClient",
    tweet_id: str,
    *,
    screen_name: Optional[str] = None,
    simulate_page_nav: bool = True,
) -> dict:
    """GraphQL TweetResultByRestId で tweet_id が実在するかを確認する。

    投稿直後に X 側でサイレントドロップされていないかを検知するために使う。
    X は "success を装って drop" することがあり、その場合 CreateTweet は
    tweet_id を返すが、その直後に TweetResultByRestId で引くと
    `{"data":{"tweetResult":{}}}` (空オブジェクト) が返ってくる。

    本物の Web アプリに寄せるため、verify 直前に status URL への HTML
    ナビゲーションを挟み、続く GraphQL の referer をその status URL にする。

    引数:
        screen_name: ユーザ名 (None の場合は xclient.account_id を使う)
        simulate_page_nav: True の場合、GraphQL 呼出前に status ページへ
            HTML ナビゲーションを行って実ユーザの遷移パターンを再現する。
            連続 retry で 2 回目の呼出では False に設定して過剰アクセスを避ける。

    戻り値:
        {
            "exists": bool,              # True=実在確認, False=存在せず (silent drop)
            "typename": str | None,      # "Tweet" / "TweetUnavailable" / "TweetTombstone" / None
            "http_status": int,          # HTTP ステータス (debug 用)
            "error": str | None,         # エラーがあれば
        }
    """
    try:
        await _ensure_op_ids(xclient)

        # screen_name を解決 — account_id はこのリポジトリでは X の username と同一
        sn = (screen_name or xclient.account_id or "").lstrip("@")
        status_url = (
            f"https://x.com/{sn}/status/{tweet_id}" if sn else "https://x.com/home"
        )

        # 本物のブラウザ遷移を模倣: status URL を HTML ナビゲーションで取得 → JS 初期化待ち
        if simulate_page_nav and sn:
            await _fetch_status_page_html(xclient, sn, tweet_id)
            # 本物の Chrome は hydration + fetch 準備に 0.8-1.8s かかる
            await asyncio.sleep(random.uniform(0.8, 1.8))

        # GraphQL 呼出の referer は実際に画面を開いた URL に揃える
        headers = _get_auth_headers(xclient, referer=status_url, method="GET")
        # GET リクエストなので content-type を除去
        headers.pop("content-type", None)

        op_id = _get_op_id("TweetResultByRestId")
        variables = {
            "tweetId": str(tweet_id),
            "withCommunity": False,
            "includePromotedContent": False,
            "withVoice": False,
        }
        features = dict(_COMMON_FEATURES)
        features.update({
            "creator_subscriptions_tweet_preview_api_enabled": True,
            "tweet_awards_web_tipping_enabled": False,
            "responsive_web_twitter_article_tweet_consumption_enabled": True,
            "responsive_web_enhance_cards_enabled": False,
            "rweb_video_timestamps_enabled": True,
            "standardized_nudges_misinfo": True,
            "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled": True,
            "longform_notetweets_inline_media_enabled": True,
        })
        url = (
            f"{GRAPHQL_BASE}/{op_id}/TweetResultByRestId"
            f"?variables={quote(json.dumps(variables))}"
            f"&features={quote(json.dumps(features))}"
        )
        # _api_get ではなく直接 client.get を使うので、ここでも real TID を注入
        headers = await _inject_real_tid(xclient, url, headers, "GET")
        resp = await xclient.client.get(url, headers=headers)
        xclient.refresh_ct0()
        status = resp.status_code
        if status != 200:
            return {
                "exists": False,
                "typename": None,
                "http_status": status,
                "error": f"HTTP {status}",
            }
        try:
            data = resp.json()
        except Exception:
            return {
                "exists": False,
                "typename": None,
                "http_status": status,
                "error": "JSON parse failed",
            }

        # レスポンスが errors を含むケース (存在しない ID など)
        if data.get("errors"):
            return {
                "exists": False,
                "typename": None,
                "http_status": status,
                "error": str(data["errors"][:1])[:200],
            }

        tweet_result = data.get("data", {}).get("tweetResult", {})
        # サイレントドロップの典型パターン: {"data":{"tweetResult":{}}}
        if not tweet_result or not tweet_result.get("result"):
            return {
                "exists": False,
                "typename": None,
                "http_status": status,
                "error": None,
            }
        result = tweet_result["result"]
        typename = result.get("__typename", "")
        # Tweet 以外 (TweetUnavailable, TweetTombstone 等) は実在しない扱い
        if typename != "Tweet":
            return {
                "exists": False,
                "typename": typename,
                "http_status": status,
                "error": None,
            }
        return {
            "exists": True,
            "typename": typename,
            "http_status": status,
            "error": None,
        }
    except Exception as e:
        logger.debug("api_verify_tweet_exists error for %s: %s", tweet_id, e)
        return {
            "exists": False,
            "typename": None,
            "http_status": 0,
            "error": str(e),
        }


# ══════════════════════════════════════════════════
#  公開 API: メディアアップロード
# ══════════════════════════════════════════════════

def _resolve_media_path(file_path: str) -> Path:
    raw = Path(file_path)
    if raw.is_absolute():
        return raw
    return (BASE_DIR / raw).resolve()


def _media_type_and_category(path: Path) -> tuple[str, str]:
    suffix = path.suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg", "tweet_image"
    if suffix == ".png":
        return "image/png", "tweet_image"
    if suffix == ".gif":
        return "image/gif", "tweet_gif"
    if suffix == ".webp":
        return "image/webp", "tweet_image"
    raise ValueError(f"未対応の画像形式です: {path.name}")


def _build_upload_headers(headers: dict) -> dict:
    keys = (
        "authorization",
        "x-csrf-token",
        "x-twitter-auth-type",
        "x-twitter-active-user",
        "x-twitter-client-language",
        "x-client-uuid",
    )
    upload_headers = {k: headers[k] for k in keys if headers.get(k)}
    upload_headers.update({
        "origin": "https://x.com",
        "referer": "https://x.com/compose/post",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
    })
    return upload_headers


def _build_upload_cookie_header(xclient: "XClient") -> str:
    """upload.twitter.com 向けに最低限必要な認証 Cookie を明示送信する。

    .x.com の Cookie は upload.twitter.com へ自動送信されないため、
    auth_token / ct0 はヘッダで明示する。
    """
    parts = []
    if xclient.auth_token:
        parts.append(f"auth_token={xclient.auth_token}")
    if xclient.ct0:
        parts.append(f"ct0={xclient.ct0}")
    return "; ".join(parts)


async def _upload_api_request(
    xclient: "XClient",
    url: str,
    headers: dict,
    *,
    params: dict | None = None,
    multipart=None,
    timeout: float | None = None,
):
    for attempt in range(_MEDIA_UPLOAD_ATTEMPTS):
        try:
            resp = await xclient.client.post(
                url,
                headers=headers,
                params=params,
                multipart=multipart,
                timeout=timeout or _MEDIA_UPLOAD_TIMEOUT,
            )
            xclient.refresh_ct0()
            return resp
        except Exception as e:
            retryable = _is_retryable_transport_error(e)
            logger.warning(
                "Upload transport error (attempt %d/%d, retryable=%s): %s",
                attempt + 1,
                _MEDIA_UPLOAD_ATTEMPTS,
                retryable,
                e,
            )
            if retryable and attempt < _MEDIA_UPLOAD_ATTEMPTS - 1:
                delay = _PROXY_RETRY_DELAY * (attempt + 1) + random.uniform(0.5, 2.0)
                await asyncio.sleep(delay)
                continue
            raise


def _resp_json_or_text(resp) -> tuple[dict, str]:
    try:
        data = resp.json()
    except Exception:
        return {}, (resp.text or "")[:300]
    return data, json.dumps(data, ensure_ascii=False)[:300]


def _media_upload_failure(message: str, *, proxy_error: str | None = None) -> dict:
    failure = {"success": False, "message": message}
    if proxy_error:
        failure["proxy_error"] = proxy_error
        failure["proxy_error_stage"] = "media_upload"
    return failure


def _media_upload_http_failure(stage: str, resp, detail: str | None = None) -> dict:
    resp_text = detail
    if resp_text is None:
        _, resp_text = _resp_json_or_text(resp)
    message = f"メディア{stage}失敗: {resp.status_code} {resp_text}".strip()
    proxy_error = message if resp.status_code in _UPLOAD_PROXY_HTTP_STATUSES else None
    return _media_upload_failure(message, proxy_error=proxy_error)


async def _wait_media_processing(
    xclient: "XClient",
    upload_headers: dict,
    media_id: str,
    processing_info: dict | None,
) -> dict:
    info = processing_info or {}
    for _ in range(_MEDIA_STATUS_MAX_POLLS):
        state = info.get("state")
        if not state or state == "succeeded":
            return {"success": True}
        if state == "failed":
            err = info.get("error") or {}
            return {
                "success": False,
                "message": f"メディア処理失敗: {err.get('message') or info}",
            }

        await asyncio.sleep(max(1, int(info.get("check_after_secs", 1))))
        resp = await _upload_api_request(
            xclient,
            "https://upload.twitter.com/i/media/upload.json",
            upload_headers,
            params={"command": "STATUS", "media_id": media_id},
        )
        if resp.status_code != 200:
            return _media_upload_http_failure("STATUS", resp)

        data, text = _resp_json_or_text(resp)
        logger.info("Media STATUS media_id=%s: %s", media_id, text)
        info = data.get("processing_info") or {}

    return {"success": False, "message": "メディア処理待機がタイムアウトしました"}


async def api_upload_media(xclient: "XClient", file_path: str) -> dict:
    """upload.twitter.com chunked upload でメディアをアップロード"""
    try:
        headers = _get_auth_headers(xclient)
        abs_path = _resolve_media_path(file_path)

        if not abs_path.exists():
            return {"success": False, "message": f"ファイルが見つかりません: {abs_path}"}

        raw = abs_path.read_bytes()
        total_bytes = len(raw)
        content_type, media_category = _media_type_and_category(abs_path)

        # upload.twitter.com は x.com とは別オリジン → same-site
        upload_headers = _build_upload_headers(headers)
        cookie_header = _build_upload_cookie_header(xclient)
        if cookie_header:
            upload_headers["cookie"] = cookie_header

        # Step 1: INIT
        init_resp = await _upload_api_request(
            xclient,
            "https://upload.twitter.com/i/media/upload.json",
            upload_headers,
            params={
                "command": "INIT",
                "total_bytes": str(total_bytes),
                "media_type": content_type,
                "media_category": media_category,
            },
        )
        if init_resp.status_code not in (200, 201, 202):
            return _media_upload_http_failure("INIT", init_resp)

        media_id = str(init_resp.json().get("media_id_string", ""))
        if not media_id:
            return {"success": False, "message": "media_id が返されませんでした"}

        # Step 2: APPEND (multipart form-data) — 安定化のため固定サイズで分割送信
        from curl_cffi import CurlMime
        total_segments = max(1, math.ceil(total_bytes / _MEDIA_APPEND_CHUNK_SIZE))
        for segment_index in range(total_segments):
            start = segment_index * _MEDIA_APPEND_CHUNK_SIZE
            chunk = raw[start:start + _MEDIA_APPEND_CHUNK_SIZE]
            mp = CurlMime()
            mp.addpart(name="command", data=b"APPEND")
            mp.addpart(name="media_id", data=media_id.encode())
            mp.addpart(name="segment_index", data=str(segment_index).encode())
            mp.addpart(
                name="media",
                content_type=content_type,
                filename=abs_path.name,
                data=chunk,
            )
            try:
                append_resp = await _upload_api_request(
                    xclient,
                    "https://upload.twitter.com/i/media/upload.json",
                    upload_headers,
                    multipart=mp,
                )
            finally:
                mp.close()
            if append_resp.status_code not in (200, 201, 202, 204):
                _, resp_text = _resp_json_or_text(append_resp)
                return _media_upload_http_failure(
                    f"APPEND(seg={segment_index})",
                    append_resp,
                    detail=resp_text,
                )

        # Step 3: FINALIZE
        finalize_resp = await _upload_api_request(
            xclient,
            "https://upload.twitter.com/i/media/upload.json",
            upload_headers,
            params={
                "command": "FINALIZE",
                "media_id": media_id,
            },
        )
        if finalize_resp.status_code not in (200, 201, 202):
            return _media_upload_http_failure("FINALIZE", finalize_resp)

        finalize_data, finalize_text = _resp_json_or_text(finalize_resp)
        logger.info("Media FINALIZE media_id=%s: %s", media_id, finalize_text)
        wait_result = await _wait_media_processing(
            xclient,
            upload_headers,
            media_id,
            finalize_data.get("processing_info"),
        )
        if not wait_result.get("success"):
            return wait_result

        logger.info("Media uploaded via API: media_id=%s (%d bytes)", media_id, total_bytes)
        return {"success": True, "media_id": media_id}

    except Exception as e:
        logger.debug("api_upload_media error: %s", e)
        proxy_error = str(e) if _is_retryable_transport_error(e) else None
        return _media_upload_failure(
            f"メディアアップロード失敗: {str(e)}",
            proxy_error=proxy_error,
        )


# ══════════════════════════════════════════════════
#  公開 API: いいね / いいね解除
# ══════════════════════════════════════════════════

def _extract_tweet_id(tweet_url: str) -> str:
    m = re.search(r"/status/(\d+)", tweet_url)
    return m.group(1) if m else tweet_url


async def api_like_tweet(xclient: "XClient", tweet_url: str) -> dict:
    """GraphQL FavoriteTweet でいいね"""
    try:
        if not account_limiter.can_act(xclient.account_id, "like"):
            return {"success": False, "message": "アカウントの日次いいね制限に達しています", "url": tweet_url}
        await _ensure_op_ids(xclient)
        headers = _get_auth_headers(xclient, referer="https://x.com/home")
        op_id = _get_op_id("FavoriteTweet")
        tweet_id = _extract_tweet_id(tweet_url)

        body = {"variables": {"tweet_id": tweet_id}, "queryId": op_id}
        url = f"{GRAPHQL_BASE}/{op_id}/FavoriteTweet"
        await pre_action_delay()

        resp = await _api_post(xclient, url, headers, body)
        err = _check_resp_error(resp, url=tweet_url)
        if err:
            return err

        status = resp.get("status", 0)
        data = resp.get("data", {})

        if status == 200:
            fav = data.get("data", {}).get("favorite_tweet", "")
            if fav == "Done" or data.get("data", {}).get("favorite_tweet") is not None:
                logger.info("Liked via API: %s", tweet_url)
                account_limiter.record(xclient.account_id, "like")
                await post_action_delay()
                return {"success": True, "message": "いいね完了 (API)", "url": tweet_url}

        errors = data.get("errors", [])
        if errors and any("already" in (e.get("message", "")).lower() for e in errors):
            return {"success": True, "message": "既にいいね済み", "url": tweet_url}

        err_msg = errors[0].get("message", str(data)) if errors else str(data)
        return {"success": False, "message": f"いいね失敗 ({status}): {err_msg}", "url": tweet_url}

    except Exception as e:
        logger.debug("api_like_tweet error: %s", e)
        return {"success": False, "message": f"いいね失敗: {str(e)}", "url": tweet_url}


async def api_unlike_tweet(xclient: "XClient", tweet_url: str) -> dict:
    """GraphQL UnfavoriteTweet でいいね解除"""
    try:
        await _ensure_op_ids(xclient)
        headers = _get_auth_headers(xclient, referer="https://x.com/home")
        op_id = _get_op_id("UnfavoriteTweet")
        tweet_id = _extract_tweet_id(tweet_url)

        body = {"variables": {"tweet_id": tweet_id}, "queryId": op_id}
        url = f"{GRAPHQL_BASE}/{op_id}/UnfavoriteTweet"
        await pre_action_delay()

        resp = await _api_post(xclient, url, headers, body)
        err = _check_resp_error(resp, url=tweet_url)
        if err:
            return err

        if resp.get("status") == 200:
            logger.info("Unliked via API: %s", tweet_url)
            await post_action_delay()
            return {"success": True, "message": "いいね解除完了 (API)", "url": tweet_url}

        data = resp.get("data", {})
        errors = data.get("errors", [])
        err_msg = errors[0].get("message", str(data)) if errors else str(data)
        return {"success": False, "message": f"いいね解除失敗: {err_msg}", "url": tweet_url}

    except Exception as e:
        logger.error("api_unlike_tweet error: %s", e)
        return {"success": False, "message": f"いいね解除失敗: {str(e)}", "url": tweet_url}


# ══════════════════════════════════════════════════
#  公開 API: ブックマーク / ブックマーク解除
# ══════════════════════════════════════════════════

async def api_bookmark_tweet(xclient: "XClient", tweet_url: str) -> dict:
    """GraphQL CreateBookmark でブックマーク"""
    try:
        if not account_limiter.can_act(xclient.account_id, "bookmark"):
            return {"success": False, "message": "アカウントの日次ブックマーク制限に達しています", "url": tweet_url}
        await _ensure_op_ids(xclient)
        headers = _get_auth_headers(xclient, referer="https://x.com/home")
        op_id = _get_op_id("CreateBookmark")
        if not op_id:
            return {"success": False, "message": "ブックマークAPIのoperation IDを取得できませんでした", "url": tweet_url}
        tweet_id = _extract_tweet_id(tweet_url)

        body = {"variables": {"tweet_id": tweet_id}, "queryId": op_id}
        url = f"{GRAPHQL_BASE}/{op_id}/CreateBookmark"
        await pre_action_delay()

        resp = await _api_post(xclient, url, headers, body)
        err = _check_resp_error(resp, url=tweet_url)
        if err:
            return err

        status = resp.get("status", 0)
        data = resp.get("data", {})
        if status == 200:
            logger.info("Bookmarked via API: %s", tweet_url)
            account_limiter.record(xclient.account_id, "bookmark")
            await post_action_delay()
            return {"success": True, "message": "ブックマーク完了 (API)", "url": tweet_url}

        errors = data.get("errors", [])
        if errors and any("already" in (e.get("message", "")).lower() for e in errors):
            return {"success": True, "message": "既にブックマーク済み", "url": tweet_url}
        err_msg = errors[0].get("message", str(data)) if errors else str(data)
        return {"success": False, "message": f"ブックマーク失敗 ({status}): {err_msg}", "url": tweet_url}
    except Exception as e:
        logger.debug("api_bookmark_tweet error: %s", e)
        return {"success": False, "message": f"ブックマーク失敗: {str(e)}", "url": tweet_url}


async def api_unbookmark_tweet(xclient: "XClient", tweet_url: str) -> dict:
    """GraphQL DeleteBookmark でブックマーク解除"""
    try:
        await _ensure_op_ids(xclient)
        headers = _get_auth_headers(xclient, referer="https://x.com/home")
        op_id = _get_op_id("DeleteBookmark")
        if not op_id:
            return {"success": False, "message": "ブックマーク解除APIのoperation IDを取得できませんでした", "url": tweet_url}
        tweet_id = _extract_tweet_id(tweet_url)

        body = {"variables": {"tweet_id": tweet_id}, "queryId": op_id}
        url = f"{GRAPHQL_BASE}/{op_id}/DeleteBookmark"
        await pre_action_delay()

        resp = await _api_post(xclient, url, headers, body)
        err = _check_resp_error(resp, url=tweet_url)
        if err:
            return err

        if resp.get("status") == 200:
            logger.info("Unbookmarked via API: %s", tweet_url)
            await post_action_delay()
            return {"success": True, "message": "ブックマーク解除完了 (API)", "url": tweet_url}

        data = resp.get("data", {})
        errors = data.get("errors", [])
        err_msg = errors[0].get("message", str(data)) if errors else str(data)
        return {"success": False, "message": f"ブックマーク解除失敗: {err_msg}", "url": tweet_url}
    except Exception as e:
        logger.error("api_unbookmark_tweet error: %s", e)
        return {"success": False, "message": f"ブックマーク解除失敗: {str(e)}", "url": tweet_url}


# ══════════════════════════════════════════════════
#  公開 API: リツイート / リツイート解除
# ══════════════════════════════════════════════════

async def api_retweet(xclient: "XClient", tweet_url: str) -> dict:
    """GraphQL CreateRetweet"""
    try:
        if not account_limiter.can_act(xclient.account_id, "retweet"):
            return {"success": False, "message": "アカウントの日次リツイート制限に達しています", "url": tweet_url}
        await _ensure_op_ids(xclient)
        headers = _get_auth_headers(xclient, referer="https://x.com/home")
        op_id = _get_op_id("CreateRetweet")
        tweet_id = _extract_tweet_id(tweet_url)

        body = {"variables": {"tweet_id": tweet_id, "dark_request": False}, "queryId": op_id}
        url = f"{GRAPHQL_BASE}/{op_id}/CreateRetweet"
        await pre_action_delay()

        resp = await _api_post(xclient, url, headers, body)
        err = _check_resp_error(resp, url=tweet_url)
        if err:
            return err

        status = resp.get("status", 0)
        data = resp.get("data", {})

        if status == 200:
            logger.info("Retweeted via API: %s", tweet_url)
            account_limiter.record(xclient.account_id, "retweet")
            await post_action_delay()
            return {"success": True, "message": "リツイート完了 (API)", "url": tweet_url}

        errors = data.get("errors", [])
        if errors and any("already" in (e.get("message", "")).lower() for e in errors):
            return {"success": True, "message": "既にリツイート済み", "url": tweet_url}

        err_msg = errors[0].get("message", str(data)) if errors else str(data)
        return {"success": False, "message": f"リツイート失敗 ({status}): {err_msg}", "url": tweet_url}

    except Exception as e:
        logger.debug("api_retweet error: %s", e)
        return {"success": False, "message": f"リツイート失敗: {str(e)}", "url": tweet_url}


async def api_unretweet(xclient: "XClient", tweet_url: str) -> dict:
    """GraphQL DeleteRetweet"""
    try:
        await _ensure_op_ids(xclient)
        headers = _get_auth_headers(xclient)
        op_id = _get_op_id("DeleteRetweet")
        tweet_id = _extract_tweet_id(tweet_url)

        body = {"variables": {"source_tweet_id": tweet_id, "dark_request": False}, "queryId": op_id}
        url = f"{GRAPHQL_BASE}/{op_id}/DeleteRetweet"
        await pre_action_delay()

        resp = await _api_post(xclient, url, headers, body)
        err = _check_resp_error(resp, url=tweet_url)
        if err:
            return err

        if resp.get("status") == 200:
            logger.info("Unretweeted via API: %s", tweet_url)
            await post_action_delay()
            return {"success": True, "message": "リツイート解除完了 (API)", "url": tweet_url}

        data = resp.get("data", {})
        errors = data.get("errors", [])
        err_msg = errors[0].get("message", str(data)) if errors else str(data)
        return {"success": False, "message": f"リツイート解除失敗: {err_msg}", "url": tweet_url}

    except Exception as e:
        logger.error("api_unretweet error: %s", e)
        return {"success": False, "message": f"リツイート解除失敗: {str(e)}", "url": tweet_url}


# ══════════════════════════════════════════════════
#  公開 API: フォロー / アンフォロー
# ══════════════════════════════════════════════════

class _ResolveError(Exception):
    """user_id 解決失敗 (タイムアウト等、ユーザー不在と区別するため)"""


async def _resolve_user_id(xclient: "XClient", headers: dict, screen_name: str) -> str | None:
    """screen_name から数値 user_id を取得。
    通信エラー時は _ResolveError を送出（ユーザー不在との区別用）。
    """
    # GETリクエスト用にcontent-typeを除去
    headers = {k: v for k, v in headers.items() if k != "content-type"}
    variables = {
        "screen_name": screen_name.lstrip("@"),
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
    ubs_op_id = _get_op_id("UserByScreenName")
    url = (
        f"{GRAPHQL_BASE}/{ubs_op_id}/UserByScreenName"
        f"?variables={quote(json.dumps(variables))}"
        f"&features={quote(json.dumps(features))}"
    )
    resp = await _api_get(xclient, url, headers)
    if resp is None:
        raise _ResolveError("API通信失敗 (タイムアウト等)")
    if resp.get("status") != 200:
        raise _ResolveError(f"API応答エラー (HTTP {resp.get('status')})")
    data = resp.get("data", {})
    return data.get("data", {}).get("user", {}).get("result", {}).get("rest_id")


async def api_follow_user(xclient: "XClient", target_username: str) -> dict:
    """REST API friendships/create でフォロー"""
    try:
        target = target_username.lstrip("@").strip()
        if is_account_backed_off(xclient.account_id):
            return {
                "success": False,
                "message": "アカウントがクールダウン中です (226/344エラーによるバックオフ)",
                "target": target,
            }
        if not account_limiter.can_act(xclient.account_id, "follow"):
            return {"success": False, "message": "アカウントの日次フォロー制限に達しています", "target": target}
        headers = _get_auth_headers(xclient, referer=f"https://x.com/{target}")

        user_id = await _resolve_user_id(xclient, headers, target)
        if not user_id:
            return {"success": False, "message": f"ユーザー @{target} が見つかりません", "target": target}

        await pre_action_delay()

        result = await _api_post_form(
            xclient,
            f"{REST_BASE}/friendships/create.json",
            headers,
            {"include_profile_interstitial_type": "1", "skip_status": "true", "user_id": user_id},
        )

        err = _check_resp_error(result, target=target)
        if err:
            return err

        if result.get("status") == 200:
            logger.info("Followed via API: @%s (id=%s)", target, user_id)
            account_limiter.record(xclient.account_id, "follow")
            await post_action_delay()
            return {"success": True, "message": "フォロー完了 (API)", "target": target}

        data = result.get("data", {})
        errors = data.get("errors", [])
        first_error = errors[0] if errors else {}
        err_msg = first_error.get("message", str(data)) if first_error else str(data)
        err_code = first_error.get("code") or first_error.get("extensions", {}).get("code") or 0
        try:
            err_code = int(err_code)
        except (TypeError, ValueError):
            err_code = 0
        if err_code == 226:
            _set_backoff(xclient.account_id, 8.0, "error 226 bot detection")
        elif err_code == 344:
            _set_backoff(
                xclient.account_id,
                _DAILY_LIMIT_BACKOFF_HOURS,
                "error 344 write throttle",
            )
        elif err_code == 326:
            _set_backoff(xclient.account_id, 48.0, "error 326 account locked")
        elif err_code in (37, 64):
            _set_backoff(xclient.account_id, 168.0, f"error {err_code} account suspended")
        elif err_code in (32, 88, 89, 215):
            _set_backoff(xclient.account_id, 12.0, f"error {err_code} auth issue")
        return {
            "success": False,
            "error_code": err_code,
            "message": f"フォロー失敗 ({result.get('status')}): {err_msg}",
            "target": target,
        }

    except Exception as e:
        logger.debug("api_follow_user error: %s", e)
        return {"success": False, "message": f"フォロー失敗: {str(e)}", "target": target_username}


async def api_unfollow_user(xclient: "XClient", target_username: str) -> dict:
    """REST API friendships/destroy でアンフォロー"""
    try:
        target = target_username.lstrip("@").strip()
        headers = _get_auth_headers(xclient, referer=f"https://x.com/{target}")

        user_id = await _resolve_user_id(xclient, headers, target)
        if not user_id:
            return {"success": False, "message": f"ユーザー @{target} が見つかりません", "target": target}

        await pre_action_delay()

        result = await _api_post_form(
            xclient,
            f"{REST_BASE}/friendships/destroy.json",
            headers,
            {"include_profile_interstitial_type": "1", "skip_status": "true", "user_id": user_id},
        )

        err = _check_resp_error(result, target=target)
        if err:
            return err

        if result.get("status") == 200:
            logger.info("Unfollowed via API: @%s", target)
            await post_action_delay()
            return {"success": True, "message": "アンフォロー完了 (API)", "target": target}

        data = result.get("data", {})
        errors = data.get("errors", [])
        err_msg = errors[0].get("message", str(data)) if errors else str(data)
        return {"success": False, "message": f"アンフォロー失敗 ({result.get('status')}): {err_msg}", "target": target}

    except Exception as e:
        logger.error("api_unfollow_user error: %s", e)
        return {"success": False, "message": f"アンフォロー失敗: {str(e)}", "target": target_username}


# ══════════════════════════════════════════════════
#  公開 API: プロフィール更新
# ══════════════════════════════════════════════════

async def _visit_profile_settings_page(xclient: "XClient") -> None:
    """Open the same profile settings surface the browser uses before saving.

    X often refreshes ct0 and client-side state while rendering settings/profile.
    Visiting it before REST save brings profile edits closer to a real browser
    flow and reduces stale-session/profile-save mismatches.
    """
    if not _should_visit_profile_settings(xclient.account_id):
        return
    try:
        from app.core.fingerprint import get_page_client_hints, get_accept_language

        headers = {
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
            "accept-language": get_accept_language(xclient.account_id),
            "referer": "https://x.com/",
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "same-origin",
            "sec-fetch-user": "?1",
            "upgrade-insecure-requests": "1",
        }
        headers.update(get_page_client_hints(xclient.account_id))
        await xclient.client.get("https://x.com/settings/profile", headers=headers)
        xclient.refresh_ct0()
        await asyncio.sleep(random.uniform(0.8, 2.2))
    except Exception as e:
        logger.debug("settings/profile navigation error (non-fatal): %s", e)


def _prepare_profile_update_headers(xclient: "XClient", endpoint: str) -> dict:
    """Headers based on a successful Chrome Network capture for profile saves."""
    headers = _get_auth_headers(xclient, referer="https://x.com/", method="POST")
    headers["content-type"] = "application/x-www-form-urlencoded"
    headers["priority"] = "u=1, i"
    headers["origin"] = "https://x.com"
    headers["referer"] = "https://x.com/"
    headers["x-twitter-active-user"] = "yes"
    headers["x-twitter-auth-type"] = "OAuth2Session"
    headers["x-twitter-client-language"] = "ja"

    host = urlparse(endpoint).netloc.lower()
    if host == "api.x.com":
        headers["sec-fetch-site"] = "same-site"
        cookie_header = _build_full_cookie_header(xclient)
        if cookie_header:
            headers["cookie"] = cookie_header
    elif host == "api.twitter.com":
        headers["sec-fetch-site"] = "same-site"
        headers["cookie"] = _build_upload_cookie_header(xclient)
        headers["origin"] = "https://twitter.com"
        headers["referer"] = "https://twitter.com/"
    else:
        headers["sec-fetch-site"] = "same-origin"
        cookie_header = _build_full_cookie_header(xclient)
        if cookie_header:
            headers["cookie"] = cookie_header
    return headers

async def api_update_profile(
    xclient: "XClient",
    username: str,
    display_name: Optional[str] = None,
    bio: Optional[str] = None,
    *,
    _profile_retry: bool = False,
) -> dict:
    """プロフィール更新 — 複数エンドポイントを試行"""
    try:
        params: dict[str, str] = {}
        params["displayNameMaxLength"] = "50"
        if display_name is not None:
            params["name"] = display_name
        if bio is not None:
            params["description"] = bio

        if display_name is None and bio is None:
            return {"success": False, "message": "更新項目がありません"}

        await _visit_profile_settings_page(xclient)
        await pre_action_delay()
        last_failure = {
            "success": False,
            "message": "プロフィール更新失敗: X APIが応答しませんでした",
            "retryable": True,
        }
        endpoints = [
            "https://api.x.com/1.1/account/update_profile.json",
            "https://x.com/i/api/1.1/account/update_profile.json",
            "https://api.twitter.com/1.1/account/update_profile.json",
        ]
        for endpoint in endpoints:
            try:
                endpoint_headers = _prepare_profile_update_headers(xclient, endpoint)
                result = await _api_post_form(xclient, endpoint, endpoint_headers, params)
                status = int((result or {}).get("status") or 0)
                response_data = (result or {}).get("data") or {}
                errors = response_data.get("errors") if isinstance(response_data, dict) else None
                first_error = errors[0] if isinstance(errors, list) and errors else {}
                error_code = int(first_error.get("code") or 0)
                error_message = str(first_error.get("message") or "")

                if status == 200 and not errors:
                    updated = []
                    if display_name is not None:
                        updated.append("name")
                    if bio is not None:
                        updated.append("bio")
                    logger.info("Profile updated via REST for @%s: %s", username, updated)
                    await post_action_delay()
                    return {
                        "success": True,
                        "message": f"プロフィール更新完了 (API): {', '.join(updated)}",
                        "updated_fields": updated,
                        "http_status": status,
                    }

                terminal_messages = {
                    64: "Xアカウントが凍結されているためプロフィールを更新できません",
                    326: "Xアカウントがロックされているためプロフィールを更新できません",
                    32: "X認証セッションが無効です",
                    89: "X認証トークンが無効です",
                }
                # status=0 means the request ended before an HTTP response was
                # available. Treat it as transient just like proxy status -1.
                retryable = status in {-1, 0, 408, 425, 429, 500, 502, 503, 504} or error_code in {353, 344}
                message = terminal_messages.get(error_code) or error_message or f"X API HTTP {status}"
                last_failure = {
                    "success": False,
                    "message": message,
                    "http_status": status,
                    "error_code": error_code,
                    "retryable": retryable,
                    "blocked": error_code in terminal_messages,
                }
                logger.info(
                    "Profile REST rejected for @%s via %s: status=%s code=%s message=%s",
                    username,
                    endpoint.split("/")[2],
                    status,
                    error_code,
                    message,
                )
                if error_code in terminal_messages and not (error_code == 32 and not _profile_retry):
                    return last_failure
            except Exception as e:
                logger.debug("REST %s error: %s", endpoint, e)

        if (
            not _profile_retry
            and int(last_failure.get("error_code") or 0) in {32, 34, 353}
        ):
            try:
                from app.automation.session_capture import capture_and_apply

                capture_result = await capture_and_apply(
                    xclient,
                    reason=f"profile_update_error_{last_failure.get('error_code')}",
                    force=False,
                    last_error_message=str(last_failure.get("message") or ""),
                )
                if capture_result.get("success"):
                    retry_result = await api_update_profile(
                        xclient,
                        username,
                        display_name=display_name,
                        bio=bio,
                        _profile_retry=True,
                    )
                    retry_result["session_capture"] = capture_result
                    retry_result["profile_retry_after_capture"] = int(last_failure.get("error_code") or 0)
                    return retry_result
                last_failure["session_capture"] = capture_result
            except Exception as e:
                logger.warning(
                    "Profile session capture retry failed for @%s after %s: %s",
                    username,
                    last_failure.get("error_code"),
                    e,
                )

        if last_failure.get("error_code") == 34:
            last_failure.update({
                "message": "プロフィール更新が一時的に拒否されました (code 34)。時間をおいて再試行できます",
                "retryable": True,
                "blocked": False,
            })
        return last_failure

    except Exception as e:
        logger.error("api_update_profile error: %s", e)
        return {"success": False, "message": f"プロフィール更新失敗: {str(e)}"}


async def api_update_profile_image(xclient: "XClient", username: str, image_path: str) -> dict:
    """REST API account/update_profile_image.json でアイコンを変更"""
    try:
        headers = _get_auth_headers(xclient)
        abs_path = str(Path(image_path).resolve())

        if not Path(abs_path).exists():
            return {"success": False, "message": f"ファイルが見つかりません: {abs_path}"}

        raw = Path(abs_path).read_bytes()
        b64 = base64.b64encode(raw).decode()

        result = await _api_post_form(
            xclient,
            f"{REST_BASE}/account/update_profile_image.json",
            headers,
            {"image": b64, "skip_status": "true"},
        )

        err = _check_resp_error(result)
        if err:
            return err

        if result.get("status") == 200:
            avatar_url = result.get("data", {}).get("profile_image_url_https", "")
            logger.info("Profile image updated via API for @%s: %s", username, avatar_url)
            return {"success": True, "message": "アイコン変更完了 (API)", "avatar_url": avatar_url}

        data = result.get("data", {})
        errors = data.get("errors", [])
        err_msg = errors[0].get("message", str(data)) if errors else str(data)
        return {"success": False, "message": f"アイコン変更失敗 ({result.get('status')}): {err_msg}"}

    except Exception as e:
        logger.error("api_update_profile_image error: %s", e)
        return {"success": False, "message": f"アイコン変更失敗: {str(e)}"}


async def api_update_profile_banner(xclient: "XClient", username: str, image_path: str) -> dict:
    """REST API account/update_profile_banner.json でヘッダーを変更"""
    try:
        headers = _get_auth_headers(xclient)
        abs_path = str(Path(image_path).resolve())

        if not Path(abs_path).exists():
            return {"success": False, "message": f"ファイルが見つかりません: {abs_path}"}

        raw = Path(abs_path).read_bytes()
        b64 = base64.b64encode(raw).decode()

        resp = await xclient.client.post(
            f"{REST_BASE}/account/update_profile_banner.json",
            headers={
                "authorization": headers["authorization"],
                "x-csrf-token": headers["x-csrf-token"],
            },
            data={"banner": b64},
        )

        if resp.status_code in (200, 201):
            logger.info("Profile banner updated via API for @%s", username)
            return {"success": True, "message": "ヘッダー変更完了 (API)"}

        try:
            data = resp.json()
        except Exception:
            data = {}
        errors = data.get("errors", [])
        err_msg = errors[0].get("message", str(data)) if errors else str(resp.status_code)
        return {"success": False, "message": f"ヘッダー変更失敗 ({resp.status_code}): {err_msg}"}

    except Exception as e:
        logger.error("api_update_profile_banner error: %s", e)
        return {"success": False, "message": f"ヘッダー変更失敗: {str(e)}"}
