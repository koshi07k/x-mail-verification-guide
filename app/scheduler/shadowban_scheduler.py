"""シャドウバンチェックの日次スケジューラ"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from zoneinfo import ZoneInfo

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from app.automation.shadowban import (
    build_runtime_options as browser_build_runtime_options,
    check_accounts as browser_check_accounts,
    is_authoritative_result,
)
from app.core.account_eligibility import shadowban_check_eligibility, shadowban_check_policy_label
from app.storage.account_metadata import update_bulk
from app.storage.account_metadata import get_all_metadata
from app.storage.excel import load_accounts
from app.storage.shadowban_history import append_shadowban_run, ensure_baseline_snapshot
from app.storage.shadowban_search_accounts import get_enabled_accounts

logger = logging.getLogger(__name__)

SHADOWBAN_DAILY_HOUR = 3
SHADOWBAN_DAILY_MINUTE = 30
SHADOWBAN_TIMEZONE = ZoneInfo("Asia/Tokyo")


def _metadata_update_from_result(result: dict) -> dict:
    checked_at = result.get("checked_at") or datetime.now().isoformat()
    return {
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


class ShadowbanDailyScheduler:
    def __init__(self) -> None:
        self._scheduler = AsyncIOScheduler(timezone=SHADOWBAN_TIMEZONE)
        self._started = False
        self._run_lock = asyncio.Lock()
        self._running_since = ""
        self._last_result: dict = {}
        self._current_run: dict = {}

    def start(self) -> None:
        if self._started:
            return
        try:
            ensure_baseline_snapshot()
        except Exception as e:
            logger.warning("Shadowban baseline snapshot failed: %s", e)
        self._scheduler.start()
        self._scheduler.add_job(
            self.run_scheduled,
            trigger=CronTrigger(
                hour=SHADOWBAN_DAILY_HOUR,
                minute=SHADOWBAN_DAILY_MINUTE,
                timezone=SHADOWBAN_TIMEZONE,
            ),
            id="shadowban_daily_check",
            replace_existing=True,
            max_instances=1,
            coalesce=True,
        )
        self._started = True
        logger.info(
            "ShadowbanDailyScheduler started (%02d:%02d %s)",
            SHADOWBAN_DAILY_HOUR,
            SHADOWBAN_DAILY_MINUTE,
            SHADOWBAN_TIMEZONE.key,
        )

    def shutdown(self) -> None:
        if not self._started:
            return
        self._scheduler.shutdown(wait=False)
        self._started = False

    def status(self) -> dict:
        job = self._scheduler.get_job("shadowban_daily_check") if self._started else None
        next_run_at = ""
        if job and job.next_run_time:
            next_run_at = job.next_run_time.isoformat()
        return {
            "enabled": self._started,
            "running": bool(self._run_lock.locked()),
            "running_since": self._running_since,
            "current_run": dict(self._current_run),
            "last_result": self._last_result,
            "timezone": SHADOWBAN_TIMEZONE.key,
            "hour": SHADOWBAN_DAILY_HOUR,
            "minute": SHADOWBAN_DAILY_MINUTE,
            "schedule_label": f"毎日 {SHADOWBAN_DAILY_HOUR:02d}:{SHADOWBAN_DAILY_MINUTE:02d}",
            "next_run_at": next_run_at,
        }

    async def run_scheduled(self) -> dict:
        return await self.run_once(source="scheduled")

    async def run_once(self, *, source: str = "manual") -> dict:
        if self._run_lock.locked():
            return {"status": "skipped", "reason": "already_running"}

        async with self._run_lock:
            self._running_since = datetime.now(SHADOWBAN_TIMEZONE).isoformat()
            started_at = self._running_since
            self._current_run = {
                "status": "running",
                "source": source,
                "started_at": started_at,
                "accounts_total": 0,
                "checker_count": 0,
                "progress": 0,
                "last_username": "",
                "last_status": "",
            }
            try:
                accounts = [account for account in load_accounts() if account.get("username")]
                metadata = get_all_metadata()
                eligible_accounts: list[dict] = []
                skipped_by_policy: list[dict] = []
                for account in accounts:
                    username = account["username"]
                    eligibility = shadowban_check_eligibility(
                        account,
                        metadata.get(username, {}),
                    )
                    if eligibility["eligible"]:
                        eligible_accounts.append(account)
                    else:
                        skipped_by_policy.append(eligibility)

                usernames = [account["username"] for account in eligible_accounts]
                self._current_run.update({
                    "accounts_total": len(usernames),
                    "accounts_scanned_total": len(accounts),
                    "eligible_total": len(usernames),
                    "policy_skipped_count": len(skipped_by_policy),
                    "policy": shadowban_check_policy_label(),
                })
                if not usernames:
                    result = {
                        "status": "skipped",
                        "reason": "no_eligible_accounts",
                        "run_at": started_at,
                        "accounts_total": len(accounts),
                        "eligible_total": 0,
                        "policy_skipped_count": len(skipped_by_policy),
                    }
                    self._last_result = result
                    return result

                checkers = get_enabled_accounts()
                self._current_run["checker_count"] = len(checkers)
                if not checkers:
                    result = {"status": "skipped", "reason": "no_enabled_checker", "run_at": started_at}
                    self._last_result = result
                    logger.warning("Daily shadowban check skipped: no enabled checker accounts")
                    return result

                method = settings.shadowban_method.lower()
                if method == "graphql":
                    from app.automation.shadowban_graphql import (
                        build_runtime_options as graphql_build_runtime_options,
                        check_accounts as graphql_check_accounts,
                    )
                    runtime = graphql_build_runtime_options(
                        concurrency=max(1, len(checkers)),
                    )
                    check_accounts = graphql_check_accounts
                else:
                    runtime = browser_build_runtime_options(
                        humanize=True,
                        concurrency=max(1, len(checkers)),
                    )
                    check_accounts = browser_check_accounts

                logger.info(
                    "Daily shadowban check started (%s): %d eligible / %d total targets, %d checkers",
                    method,
                    len(usernames),
                    len(accounts),
                    len(checkers),
                )

                def _progress(done: int, result: dict) -> None:
                    self._current_run.update({
                        "progress": done,
                        "last_username": result.get("username", ""),
                        "last_status": result.get("search_status", ""),
                        "last_checked_at": result.get("checked_at", ""),
                    })

                results = await asyncio.to_thread(check_accounts, usernames, _progress, runtime)
                authoritative_results = [
                    result for result in results if is_authoritative_result(result)
                ]

                metadata_updates = {
                    result["username"]: _metadata_update_from_result(result)
                    for result in authoritative_results
                    if result.get("username")
                }
                if metadata_updates:
                    update_bulk(metadata_updates)

                run_id = f"{source}-{datetime.now(SHADOWBAN_TIMEZONE).strftime('%Y%m%d%H%M%S')}"
                append_shadowban_run(
                    run_id=run_id,
                    source=source,
                    run_at=started_at,
                    results=authoritative_results,
                )
                result = {
                    "status": "completed",
                    "run_id": run_id,
                    "run_at": started_at,
                    "accounts_total": len(results),
                    "accounts_scanned_total": len(accounts),
                    "policy_skipped_count": len(skipped_by_policy),
                    "saved_count": len(authoritative_results),
                    "skipped_count": len(results) - len(authoritative_results),
                }
                self._last_result = result
                logger.info(
                    "Daily shadowban check completed: %d results (saved=%d skipped=%d)",
                    len(results),
                    len(authoritative_results),
                    len(results) - len(authoritative_results),
                )
                return result
            except Exception as e:
                logger.exception("Daily shadowban check failed")
                result = {"status": "failed", "run_at": started_at, "error": str(e)}
                self._last_result = result
                return result
            finally:
                self._running_since = ""
                self._current_run = {}


shadowban_daily_scheduler = ShadowbanDailyScheduler()
