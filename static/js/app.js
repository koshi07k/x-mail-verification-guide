/* X-Pilot - フロントエンド JavaScript */

// file:// で直接開いた場合はlocalhostのサーバーに接続
const API = (location.protocol === 'file:') ? 'http://localhost:8000' : '';

// ============================================
// ナビゲーション
// ============================================
// ============================================
// ハンバーガーメニュー (モバイル)
// ============================================
const hamburgerBtn = document.getElementById('hamburger-btn');
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');

function toggleSidebar(open) {
    const show = typeof open === 'boolean' ? open : !sidebar.classList.contains('open');
    sidebar.classList.toggle('open', show);
    hamburgerBtn.classList.toggle('open', show);
    sidebarOverlay.classList.toggle('visible', show);
}
hamburgerBtn.addEventListener('click', () => toggleSidebar());
sidebarOverlay.addEventListener('click', () => toggleSidebar(false));

const ACTIVE_PAGE_STORAGE_KEY = 'xpilot.activePage';

function getActivePageFromDom() {
    const activeNav = document.querySelector('.nav-item.active');
    if (activeNav?.dataset?.page) return activeNav.dataset.page;
    const activePage = document.querySelector('.page.active');
    return activePage?.id?.startsWith('page-') ? activePage.id.replace(/^page-/, '') : '';
}

function getStoredActivePage() {
    try {
        return sessionStorage.getItem(ACTIVE_PAGE_STORAGE_KEY) || '';
    } catch (e) {
        return '';
    }
}

function setStoredActivePage(pageName) {
    try {
        sessionStorage.setItem(ACTIVE_PAGE_STORAGE_KEY, pageName);
    } catch (e) {
        // sessionStorageが使えない環境では画面内の切替だけ行う
    }
}

function shouldDeferDashboardToOpsPatch() {
    const dashboardPage = document.getElementById('page-dashboard');
    return dashboardPage?.dataset?.opsDashboardShell === 'true' && window.__xpilotOpsPatchInstalled !== true;
}

function shouldDeferImportToOpsPatch() {
    if (location.protocol === 'file:') return false;
    const importPage = document.getElementById('page-accounts');
    return importPage?.dataset?.opsImportShell === 'true' && window.__xpilotOpsPatchInstalled !== true;
}

function loadPageData(pageName) {
    const loaders = {
        dashboard: () => {
            if (shouldDeferDashboardToOpsPatch()) return;
            loadDashboard();
        },
        accounts: () => {
            if (shouldDeferImportToOpsPatch()) return;
            refreshAccounts();
            loadShadowbanProxyOptions();
            loadShadowbanCheckerAccounts();
        },
        'public-check': () => {
            loadLatestPublicAccountCheck();
            loadPublicCheckProxyOptions();
        },
        competitors: () => refreshCompetitorPage(),
        tasks: () => refreshTasks(),
        tweet: () => {
            refreshAccountCheckboxes('tweet-account-list');
            loadScheduledTweets();
        },
        profile: () => refreshAccountCheckboxes('profile-account-list'),
        actions: () => refreshActionPage(),
        proxy: () => loadProxyDashboard(),
        farming: () => {
            loadFarmingConfigs();
            updateFarmModeForm();
            loadQuarantineBadge();
        },
        'logic-comparison': () => loadLogicComparison(),
        export: () => initExportPage(),
        deleted: () => loadDeletedAccounts(),
        warmup: () => loadWarmupDashboard(),
    };
    const loader = loaders[pageName];
    if (!loader) return;
    try {
        const result = loader();
        if (result && typeof result.catch === 'function') {
            result.catch(err => console.error(`Failed to load page: ${pageName}`, err));
        }
    } catch (err) {
        console.error(`Failed to load page: ${pageName}`, err);
    }
}

function activatePage(pageName, options = {}) {
    const nav = document.querySelector(`.nav-item[data-page="${pageName}"]`);
    const page = document.getElementById('page-' + pageName);
    if (!nav || !page) return false;

    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    nav.classList.add('active');
    page.classList.add('active');

    if (options.persist !== false) setStoredActivePage(pageName);
    if (options.closeSidebar !== false && window.innerWidth <= 1500) toggleSidebar(false);
    loadPageData(pageName);
    return true;
}

function initActivePageFromStorage() {
    const initialPage = getStoredActivePage() || getActivePageFromDom() || 'dashboard';
    if (!activatePage(initialPage, { persist: false, closeSidebar: false })) {
        activatePage('dashboard', { persist: false, closeSidebar: false });
    }
}

document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => activatePage(btn.dataset.page));
});


// ============================================
// トースト通知
// ============================================
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

// ============================================
// 処理中オーバーレイ
// ============================================
let _processingOverlay = null;
const _processingOverlays = new Map();

function _processingKey(key) {
    return String(key || 'default');
}

function _findProcessingOverlay(key = 'default') {
    const normalized = _processingKey(key);
    return _processingOverlays.get(normalized)
        || [...document.querySelectorAll('.processing-overlay')]
            .find(el => (el.dataset.processingKey || 'default') === normalized)
        || null;
}

function _reflowProcessingOverlays() {
    let top = 16;
    document.querySelectorAll('.processing-overlay').forEach(el => {
        el.style.top = `${top}px`;
        top += el.offsetHeight + 12;
    });
}

function _parseProcessingArgs(progress, key) {
    if (progress && typeof progress === 'object') {
        return { progress: progress.progress, key: progress.key || key };
    }
    return { progress, key };
}

function showProcessing(title, subtitle = '', progress, key) {
    const parsed = _parseProcessingArgs(progress, key);
    const normalized = _processingKey(parsed.key);
    const existing = _findProcessingOverlay(normalized);
    if (existing) {
        updateProcessing(title, subtitle, parsed.progress, normalized);
        return;
    }
    const div = document.createElement('div');
    div.className = 'processing-overlay';
    div.dataset.processingKey = normalized;
    div.innerHTML = `
        <div class="processing-card">
            <div class="processing-spinner" data-processing-spinner></div>
            <div class="processing-body">
                <div class="processing-text" data-processing-title></div>
                <div class="processing-sub" data-processing-sub></div>
                <div class="processing-progress">
                    <div class="processing-progress-bar" data-processing-bar></div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(div);
    _processingOverlays.set(normalized, div);
    if (normalized === 'default') _processingOverlay = div;
    updateProcessing(title, subtitle, parsed.progress, normalized);
    _reflowProcessingOverlays();
}

function updateProcessing(title, subtitle, progress, key) {
    const overlay = _findProcessingOverlay(key);
    if (!overlay) return;
    const titleEl = overlay.querySelector('[data-processing-title]');
    const subEl = overlay.querySelector('[data-processing-sub]');
    const barEl = overlay.querySelector('[data-processing-bar]');
    const spinnerEl = overlay.querySelector('[data-processing-spinner]');
    if (titleEl && title !== undefined) titleEl.textContent = title;
    if (subEl && subtitle !== undefined) subEl.textContent = subtitle;
    if (barEl && progress !== undefined) barEl.style.width = Math.min(100, progress) + '%';
    // 完了/失敗時にスピナーの見た目を切り替え
    if (spinnerEl && progress >= 100) {
        spinnerEl.classList.add('done');
    }
    _reflowProcessingOverlays();
}

function _markProcessingError(key) {
    const overlay = _findProcessingOverlay(key);
    const spinnerEl = overlay?.querySelector('[data-processing-spinner]');
    if (spinnerEl) {
        spinnerEl.classList.remove('done');
        spinnerEl.classList.add('error');
    }
}

function hideProcessing(key) {
    // キー指定時はその通知だけを閉じる。未指定の場合は従来互換の default 通知だけ閉じる。
    const normalized = _processingKey(key);
    const targets = [...document.querySelectorAll('.processing-overlay')]
        .filter(el => (el.dataset.processingKey || 'default') === normalized);
    targets.forEach(el => {
        el.style.opacity = '0';
        el.style.transition = 'opacity 0.4s ease';
        el.style.transform = 'translateX(60px)';
    });
    setTimeout(() => {
        targets.forEach(el => {
            el.remove();
            _processingOverlays.delete(el.dataset.processingKey || 'default');
        });
        _processingOverlay = _findProcessingOverlay('default');
        _reflowProcessingOverlays();
    }, 400);
}

window.addEventListener('resize', _reflowProcessingOverlays);

// ============================================
// モーダル
// ============================================
function showAddAccountModal() {
    document.getElementById('add-account-modal').classList.add('active');
}

function closeModal(id) {
    document.getElementById(id).classList.remove('active');
}

// ============================================
// API ヘルパー
// ============================================
async function apiGet(path) {
    const res = await fetch(API + path);
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || res.statusText);
    }
    return res.json();
}

async function apiPost(path, body = {}) {
    const res = await fetch(API + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || res.statusText);
    }
    return res.json();
}

async function apiPut(path, body = {}) {
    const res = await fetch(API + path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || res.statusText);
    }
    return res.json();
}

async function apiDelete(path) {
    const res = await fetch(API + path, { method: 'DELETE' });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || res.statusText);
    }
    return res.json();
}

// ============================================
// ダッシュボード
// ============================================

const ACTION_LABELS = {
    bulk_login: '一括ログイン',
    post_tweet: 'ツイート投稿',
    bulk_like: '一括いいね',
    bulk_bookmark: '一括ブックマーク',
    bulk_follow: '一括フォロー',
    bulk_retweet: '一括リツイート',
    bulk_url_engagement: 'ツイートID指定エンゲージ',
    like_timeline: 'TLいいね',
    profile_update: 'プロフィール更新',
    icon_bulk_update: 'アイコン一括変更',
    csv_profile_update: 'CSVプロフィール更新',
    profile_fetch: 'プロフ情報取得',
    username_change: '表示名一括変更',
    llm_profile_generate: 'LLMプロフィール生成',
    llm_profile_apply: 'LLMプロフィール適用',
    proxy_healthcheck: 'Proxyヘルスチェック',
    shadowban_check: 'シャドウバンチェック',
    shadowban_daily_check: '日次シャドウバンチェック',
    public_account_check: '公開状態チェック',
    engagement_execute_all: 'エンゲージ一気実行',
    llm_profile_bio_generate: 'LLMプロフィール生成',
    llm_profile_bio_apply: 'LLMプロフィール適用',
};

const STATUS_LABELS = {
    running: '実行中',
    completed: '完了',
    failed: '失敗',
    cancelled: 'キャンセル',
    scheduled: '予約済み',
    executed: '実行済み',
};

function actionLabel(key) { return ACTION_LABELS[key] || key; }
function statusLabel(key) { return STATUS_LABELS[key] || key; }

async function loadDashboard() {
    try {
        const accounts = await apiGet('/api/accounts');
        document.getElementById('stat-total').textContent = accounts.length;
        document.getElementById('stat-active').textContent =
            accounts.filter(a => a.status === 'active').length;
        try {
            const exportStats = await apiGet('/api/export/stats');
            const perfectEl = document.getElementById('stat-perfect');
            if (perfectEl) perfectEl.textContent = exportStats.perfect || 0;
        } catch (_) {
            const perfectEl = document.getElementById('stat-perfect');
            if (perfectEl) perfectEl.textContent = '-';
        }
        document.getElementById('stat-error').textContent =
            accounts.filter(a => a.status === 'error').length;
        document.getElementById('stat-no-profile').textContent =
            accounts.filter(a => !_hasAnyEdit(a)).length;

        const tasks = await apiGet('/api/tasks');
        let shadowbanScheduler = null;
        try {
            shadowbanScheduler = await apiGet('/api/ops/shadowban/scheduler-status');
        } catch (_) {}
        const dailyShadowbanRunning = !!(shadowbanScheduler?.running);
        document.getElementById('stat-tasks').textContent =
            tasks.filter(t => t.status === 'running').length + (dailyShadowbanRunning ? 1 : 0);

        // Proxy凍結アラート表示
        try {
            const alertData = await apiGet('/api/proxy/alerts');
            const dashAlerts = document.getElementById('dashboard-proxy-alerts');
            if (dashAlerts && alertData.alerts.length > 0) {
                dashAlerts.innerHTML = alertData.alerts.map(a =>
                    `<div style="padding:8px 12px;border-left:3px solid var(--danger);background:rgba(248,113,113,0.1);border-radius:4px;margin-bottom:6px;font-size:13px;">
                        ${a.severity === 'critical' ? '🚨' : '⚠️'} ${a.message}
                    </div>`
                ).join('');
                dashAlerts.style.display = '';
            } else if (dashAlerts) {
                dashAlerts.style.display = 'none';
            }
        } catch (_) {}

        const dashTasks = document.getElementById('dashboard-tasks');
        const dailyShadowbanRow = dailyShadowbanRunning ? `
            <div style="padding:8px 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;gap:10px;">
                <span>${actionLabel('shadowban_daily_check')} <span class="badge badge-pending">実行中</span></span>
                <span style="color:var(--text-muted);text-align:right;">${_formatShadowbanSchedulerTime(shadowbanScheduler.running_since) || '実行中'}</span>
            </div>
        ` : '';
        if (tasks.length === 0 && !dailyShadowbanRunning) {
            dashTasks.innerHTML = '<p style="color:var(--text-muted)">タスクはまだありません</p>';
        } else {
            dashTasks.innerHTML = dailyShadowbanRow + tasks.slice(-5).reverse().map(t =>
                `<div style="padding:8px 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;">
                    <span>${actionLabel(t.action)} <span class="badge badge-${t.status === 'running' ? 'pending' : t.status === 'completed' ? 'active' : 'error'}">${statusLabel(t.status)}</span></span>
                    <span style="color:var(--text-muted)">${t.progress}/${t.total}${t.result_count ? ` / 結果${t.result_count}` : ''}</span>
                </div>`
            ).join('');
        }
    } catch (e) {
        console.error('ダッシュボード読み込みエラー:', e);
    }
}

async function fetchAllProfiles() {
    await refreshAvatarCache();
    try {
        const accounts = await apiGet('/api/accounts');
        const activeAccounts = accounts.filter(a => a.status === 'active');
        if (activeAccounts.length === 0) {
            showToast('ログイン済みアカウントがありません', 'error');
            return;
        }
        const container = document.getElementById('dashboard-profiles');
        container.innerHTML = '<p style="color:var(--text-muted)">取得中... 0/' + activeAccounts.length + '</p>';

        const result = await apiPost('/api/profiles/fetch', {
            account_ids: activeAccounts.map(a => a.username),
        });
        showToast(`プロフ取得開始: ${activeAccounts.length}件`, 'info');
        // Poll the task
        _pollProfileFetch(result.task_id, activeAccounts);
    } catch (e) {
        showToast('プロフ取得失敗: ' + e.message, 'error');
    }
}

async function _pollProfileFetch(taskId, accounts) {
    const container = document.getElementById('dashboard-profiles');
    const poll = async () => {
        try {
            const task = await apiGet(`/api/tasks/${taskId}`);
            container.innerHTML = `<p style="color:var(--text-muted)">取得中... ${task.progress}/${task.total}</p>`;
            // Render what we have so far
            if (task.results && task.results.length > 0) {
                container.innerHTML = _renderDashboardProfiles(task.results, accounts);
            }
            if (task.status === 'running') {
                setTimeout(poll, 2000);
            } else {
                if (task.results && task.results.length > 0) {
                    container.innerHTML = _renderDashboardProfiles(task.results, accounts);
                }
                showToast('プロフ情報取得完了', 'success');
            }
        } catch (e) {
            container.innerHTML = '<p style="color:var(--danger)">取得エラー</p>';
        }
    };
    setTimeout(poll, 1500);
}

function _renderDashboardProfiles(results, accounts) {
    // Build a map of edit status from accounts
    const editMap = {};
    accounts.forEach(a => {
        editMap[a.username] = a;
    });
    return '<div style="display:grid;gap:8px;">' + results.map(r => {
        if (!r.success) {
            return `<div style="padding:10px;border:1px solid var(--border);border-radius:8px;display:flex;align-items:center;gap:10px;">
                <span style="font-weight:600;">@${r.username}</span>
                <span style="color:var(--danger);font-size:12px;">${r.message || '取得失敗'}</span>
            </div>`;
        }
        const acct = editMap[r.username] || {};
        const badges = _buildEditBadges(acct);
        return `<div style="padding:10px;border:1px solid var(--border);border-radius:8px;display:flex;align-items:flex-start;gap:12px;">
            <img src="${r.avatar_url || avatarUrl(r.username)}" alt=""
                 style="width:48px;height:48px;border-radius:50%;object-fit:cover;flex-shrink:0;background:var(--bg-dark);"
                 onerror="this.src='${avatarUrl(r.username)}'">
            <div style="flex:1;min-width:0;">
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                    <strong style="font-size:14px;">${_escHtml(r.display_name || '(名前なし)')}</strong>
                    <span style="color:var(--text-muted);font-size:12px;">@${r.username}</span>
                    ${badges}
                </div>
                <p style="margin:4px 0 0;font-size:13px;color:var(--text-secondary);white-space:pre-wrap;word-break:break-word;">${_escHtml(r.bio || '(自己紹介なし)')}</p>
            </div>
        </div>`;
    }).join('') + '</div>';
}

function _escHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

function copyToClipboard(text, btn) {
    // navigator.clipboard は HTTPS/localhost でのみ動作するためフォールバック付き
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(() => _copyOk(btn)).catch(() => _copyFallback(text, btn));
    } else {
        _copyFallback(text, btn);
    }
}
function _copyFallback(text, btn) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); _copyOk(btn); }
    catch(e) { if(btn) { btn.textContent='NG'; setTimeout(()=>btn.textContent='ID',800); } }
    document.body.removeChild(ta);
}
function _copyOk(btn) {
    if (!btn) return;
    btn.textContent = 'OK';
    btn.style.background = 'var(--accent)';
    btn.style.color = '#fff';
    setTimeout(() => { btn.textContent = 'ID'; btn.style.background = ''; btn.style.color = ''; }, 600);
}

// ============================================
// アカウント管理
// ============================================
let _allAccountsCache = [];
let _avatarCacheBuster = '';
let _avatarLazyObserver = null;
const ACCOUNT_LIST_AVATAR_KEY = 'xpilot.accountListAvatars';

function avatarUrl(username, options = {}) {
    const params = [];
    if (_avatarCacheBuster) params.push('_=' + encodeURIComponent(_avatarCacheBuster));
    if (options && options.refresh) params.push('refresh=1');
    const qs = params.length ? '?' + params.join('&') : '';
    return `${API}/api/accounts/${encodeURIComponent(username)}/avatar${qs}`;
}

function _avatarAttr(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function _avatarHue(username) {
    let h = 0;
    const s = String(username || '?');
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h) % 360;
}

function _avatarInitial(username) {
    return String(username || '?').trim().charAt(0).toUpperCase() || '?';
}

function avatarPlaceholderDataUri(username) {
    const initial = _escHtml(_avatarInitial(username));
    const hue = _avatarHue(username);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><rect width="80" height="80" rx="40" fill="hsl(${hue}, 34%, 22%)"/><text x="40" y="52" text-anchor="middle" font-size="34" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,sans-serif" fill="hsl(${hue}, 45%, 76%)">${initial}</text></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function accountListAvatarsEnabled() {
    try {
        return localStorage.getItem(ACCOUNT_LIST_AVATAR_KEY) === '1';
    } catch (e) {
        return false;
    }
}

function setAccountListAvatarsEnabled(enabled, rerender = true) {
    try {
        localStorage.setItem(ACCOUNT_LIST_AVATAR_KEY, enabled ? '1' : '0');
    } catch (e) { /* ignore */ }
    if (rerender) {
        const active = document.querySelector('.page.active');
        if (active?.id === 'page-dashboard' && typeof loadDashboard === 'function') {
            loadDashboard();
        } else if (active?.id === 'page-accounts' && typeof refreshAccounts === 'function') {
            refreshAccounts();
        }
    }
    return enabled;
}

function toggleAccountListAvatars(rerender = true) {
    return setAccountListAvatarsEnabled(!accountListAvatarsEnabled(), rerender);
}

function accountAvatarHtml(username, size = 28, options = {}) {
    const isList = options.list !== false;
    const force = options.force === true;
    const safeUser = _avatarAttr(username || '');
    const fallback = avatarPlaceholderDataUri(username);
    const commonStyle = `width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;background:var(--bg-dark);flex-shrink:0;`;
    if (isList && !force && !accountListAvatarsEnabled()) {
        return `<img src="${fallback}" alt="" width="${size}" height="${size}" decoding="async" style="${commonStyle}">`;
    }
    const src = _avatarAttr(avatarUrl(username, options));
    return `<img src="${fallback}" data-avatar-src="${src}" data-avatar-username="${safeUser}" data-avatar-fallback="${fallback}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async" fetchpriority="low" style="${commonStyle}" onerror="handleLazyAvatarError(this)">`;
}

function handleLazyAvatarError(img) {
    if (!img) return;
    img.onerror = null;
    if (img.dataset.avatarFallback) img.src = img.dataset.avatarFallback;
    img.removeAttribute('data-avatar-src');
}

function _loadLazyAvatar(img) {
    if (!img || !img.dataset.avatarSrc || img.dataset.avatarLoaded === '1') return;
    img.dataset.avatarLoaded = '1';
    img.src = img.dataset.avatarSrc;
}

function activateLazyAvatars(root = document) {
    const scope = root || document;
    const imgs = scope.querySelectorAll ? scope.querySelectorAll('img[data-avatar-src]') : [];
    if (!imgs.length) return;
    if (!('IntersectionObserver' in window)) {
        imgs.forEach(_loadLazyAvatar);
        return;
    }
    if (!_avatarLazyObserver) {
        _avatarLazyObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                _avatarLazyObserver.unobserve(entry.target);
                _loadLazyAvatar(entry.target);
            });
        }, { root: null, rootMargin: '180px 0px', threshold: 0.01 });
    }
    imgs.forEach(img => {
        if (img.dataset.avatarObserved === '1' || img.dataset.avatarLoaded === '1') return;
        img.dataset.avatarObserved = '1';
        _avatarLazyObserver.observe(img);
    });
}

function installAvatarMutationObserver() {
    if (!document.body || document.body._avatarMutationObserver) return;
    let debounceTimer = null;
    const observer = new MutationObserver((mutations) => {
        if (!accountListAvatarsEnabled()) return;

        let hasLazyAvatar = false;
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes || []) {
                if (node.nodeType !== 1) continue;
                if (
                    node.matches?.('img[data-avatar-src]') ||
                    node.querySelector?.('img[data-avatar-src]')
                ) {
                    hasLazyAvatar = true;
                    break;
                }
            }
            if (hasLazyAvatar) break;
        }
        if (!hasLazyAvatar) return;

        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            const activePage = document.querySelector('.page.active') || document.body;
            activateLazyAvatars(activePage);
        }, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.body._avatarMutationObserver = observer;
}

setTimeout(installAvatarMutationObserver, 0);

async function refreshAvatarCache() {
    _avatarCacheBuster = Date.now();
    // サーバー側キャッシュを削除
    try {
        await fetch(`${API}/api/accounts/avatar-cache/clear`, { method: 'POST' });
    } catch (e) { /* ignore */ }
}

/**
 * アバター一括再取得 — X.com GraphQL API 経由で全アカウントの最新アバターを取得
 */
async function batchRefreshAvatars() {
    try {
        // 1. サーバー側キャッシュクリア
        await refreshAvatarCache();

        // 2. バッチ再取得をバックグラウンドで開始
        const res = await apiPost('/api/accounts/avatar-cache/refresh-all', {});
        if (!res.task_id) {
            showToast('アバター再取得の開始に失敗しました', 'error');
            return;
        }

        showProcessing('アイコン再取得中 (X.com API)', '開始中...');
        _pollAvatarRefreshTask(res.task_id, res.total || 0);
    } catch (e) {
        showToast('アバター再取得失敗: ' + e.message, 'error');
    }
}

async function _pollAvatarRefreshTask(taskId, total) {
    const poll = async () => {
        try {
            // Cloudflare/browser cacheで古い進捗が固定されないよう毎回別URLにする。
            const t = await apiGet(`/api/tasks/${taskId}?_=${Date.now()}`);

            const progress = t.progress || 0;
            const pct = total > 0 ? Math.round(progress / total * 100) : 0;
            updateProcessing(undefined, `${progress} / ${total} アカウント`, pct);

            if (t.status === 'completed' || t.status === 'failed') {
                const result = (t.results && t.results.length > 0) ? t.results[t.results.length - 1] : {};
                const ok = result.success || 0;
                const ng = result.failed || 0;

                if (ng > 0) {
                    updateProcessing('アイコン更新完了 (一部失敗)', `成功: ${ok} / 失敗: ${ng}`, 100);
                    _markProcessingError();
                } else {
                    updateProcessing('アイコン更新完了', `${ok} アカウント`, 100);
                }
                setTimeout(async () => {
                    hideProcessing();
                    _avatarCacheBuster = Date.now();
                    try { await refreshAccountCheckboxes('profile-account-list'); } catch(e){}
                    refreshAccounts();
                    if (ng > 0) {
                        showToast(`アイコン更新完了 — 成功: ${ok}, 失敗: ${ng}`, 'warning');
                    } else {
                        showToast(`アイコン更新完了 (${ok}件)`, 'success');
                    }
                }, 1000);
                return;
            }

            setTimeout(poll, 1500);
        } catch (e) {
            setTimeout(poll, 2500);
        }
    };
    setTimeout(poll, 1000);
}

async function reloadProfileAvatars() {
    // reloadProfileAvatars は batchRefreshAvatars に統合
    await batchRefreshAvatars();
}

let _accountMetadata = {};  // { username: { profile: {...}, shadowban: {...}, checked_at: ... } }

async function refreshAccounts() {
    try {
        const [accounts, metadata] = await Promise.all([
            apiGet('/api/accounts'),
            apiGet('/api/accounts/metadata').catch(() => ({})),
        ]);
        _allAccountsCache = accounts;
        _accountMetadata = metadata || {};
        const tbody = document.getElementById('accounts-table');
        if (accounts.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--text-muted)">アカウントがありません。追加してください。</td></tr>';
            return;
        }
        _renderAccountTable(accounts);
    } catch (e) {
        showToast('アカウント読み込み失敗: ' + e.message, 'error');
    }
}

function _hasAnyEdit(a) {
    return !!(a.edited_icon || a.edited_name || a.edited_bio);
}

function _buildEditBadges(a) {
    const badges = [];
    if (a.edited_icon) badges.push('<span class="badge badge-active" style="font-size:9px;padding:1px 5px;">&#10003;アイコン</span>');
    if (a.edited_name) badges.push('<span class="badge badge-active" style="font-size:9px;padding:1px 5px;">&#10003;ネーム</span>');
    if (a.edited_bio)  badges.push('<span class="badge badge-active" style="font-size:9px;padding:1px 5px;">&#10003;プロフ</span>');
    if (badges.length === 0) badges.push('<span class="badge badge-warning" style="font-size:10px">未設定</span>');
    return badges.join(' ');
}

// インポートグループの色パレット(左ボーダー色)
const _GROUP_COLORS = [
    '#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6',
    '#ec4899','#06b6d4','#84cc16','#f97316','#6366f1',
];
let _groupColorMap = {};

function _getGroupColor(groupId) {
    if (!groupId) return 'transparent';
    if (!_groupColorMap[groupId]) {
        const idx = Object.keys(_groupColorMap).length % _GROUP_COLORS.length;
        _groupColorMap[groupId] = _GROUP_COLORS[idx];
    }
    return _groupColorMap[groupId];
}

function _formatNumber(n) {
    if (n == null) return '-';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
}

function _parseCreatedYear(createdAt) {
    // X API の created_at: "Mon Jan 01 00:00:00 +0000 2020"
    if (!createdAt) return null;
    const match = createdAt.match(/\d{4}$/);
    if (match) return match[0];
    // ISO 形式のフォールバック
    const d = new Date(createdAt);
    return isNaN(d.getTime()) ? null : String(d.getFullYear());
}

function _buildStatsCell(username) {
    const meta = _accountMetadata[username];
    if (!meta || !meta.profile) {
        return '<span style="font-size:11px;color:var(--text-muted);">-</span>';
    }
    const p = meta.profile;
    const year = _parseCreatedYear(p.created_at);
    const parts = [];
    if (year) parts.push(`<span title="作成年">${year}年</span>`);
    if (p.statuses_count != null) parts.push(`<span title="ポスト数">${_formatNumber(p.statuses_count)}投稿</span>`);
    if (p.followers_count != null) parts.push(`<span title="フォロワー">${_formatNumber(p.followers_count)}F</span>`);
    if (p.following_count != null) parts.push(`<span title="フォロー中">${_formatNumber(p.following_count)}フォロー</span>`);
    return `<div style="font-size:11px;line-height:1.5;color:var(--text-muted);white-space:nowrap;">${parts.join('<br>')}</div>`;
}

function _buildShadowbanCell(username) {
    const meta = _accountMetadata[username];
    if (!meta || !meta.shadowban) {
        return '<span style="font-size:11px;color:var(--text-muted);">未チェック</span>';
    }
    const sb = meta.shadowban;
    const badges = _shadowbanBadgeList(sb, true);
    return badges.length > 0
        ? `<div style="display:flex;flex-direction:column;gap:2px;">${badges.join('')}</div>`
        : '<span style="font-size:11px;color:var(--text-muted);">未チェック</span>';
}

function _isSearchShadowbanRecord(sb) {
    return !!sb && (
        Object.prototype.hasOwnProperty.call(sb, 'top_search_ok') ||
        Object.prototype.hasOwnProperty.call(sb, 'latest_search_ok') ||
        Object.prototype.hasOwnProperty.call(sb, 'search_status')
    );
}

function _shadowbanBadgeList(sb, compact = false) {
    if (!sb) return [];
    const size = compact ? 'font-size:9px;padding:1px 5px;' : 'font-size:10px;';
    if (_isSearchShadowbanRecord(sb)) {
        const topOk = !!sb.top_search_ok || !!sb.top_ok;
        const latestOk = !!sb.latest_search_ok || !!sb.latest_ok;
        if (sb.suspend) return [`<span class="badge badge-error" style="${size}">凍結</span>`];
        if (sb.not_found) return [`<span class="badge badge-error" style="${size}">アカウント不明</span>`];
        if (sb.protect) return [`<span class="badge badge-warning" style="${size}">鍵アカウント</span>`];
        if (sb.error) return [`<span class="badge badge-warning" style="${size}">エラー</span>`];
        if (sb.sensitive_limited || sb.search_status === 'センシ限定') {
            return [`<span class="badge badge-warning" style="${size}" title="センシティブ表示OKのアカウントからのみ検索表示">センシ限定</span>`];
        }
        const out = [];
        if (topOk && latestOk) {
            out.push(`<span class="badge badge-active" style="${size}">検索完全OK</span>`);
        } else {
            if (topOk) out.push(`<span class="badge badge-warning" style="${size}">話題のポストOK</span>`);
            if (latestOk) out.push(`<span class="badge badge-warning" style="${size}">最新OK</span>`);
            if (!topOk && !latestOk) out.push(`<span class="badge badge-error" style="${size}">検索表示なし</span>`);
        }
        if (sb.search_suggestion_ban) {
            out.push(`<span class="badge badge-warning" style="${size}">Suggestion Ban</span>`);
        }
        if (sb.no_tweet) {
            out.push(`<span class="badge badge-info" style="${size}">ツイートなし</span>`);
        }
        return out;
    }

    const checks = [
        { key: 'search_ban', label: 'Search Ban', color: 'badge-error' },
        { key: 'search_suggestion_ban', label: 'Suggestion Ban', color: 'badge-warning' },
        { key: 'media_ban', label: 'Media Ban', color: 'badge-warning' },
        { key: 'ghost_ban', label: 'Ghost Ban', color: 'badge-warning' },
        { key: 'reply_deboosting', label: 'Reply Deboosting', color: 'badge-warning' },
    ];
    if (sb.suspend) return [`<span class="badge badge-error" style="${size}">凍結</span>`];
    if (sb.not_found) return [`<span class="badge badge-error" style="${size}">不明</span>`];
    const flags = checks.filter(c => sb[c.key]).map(c =>
        `<span class="badge ${c.color}" style="${size}">${c.label}</span>`
    );
    if (flags.length === 0) {
        return [`<span class="badge badge-active" style="${size}">問題なし</span>`];
    }
    return flags;
}

function _renderAccountTable(accounts) {
    const tbody = document.getElementById('accounts-table');
    _groupColorMap = {};

    // グループごとのアカウント数を集計
    const groupCounts = {};
    accounts.forEach(a => {
        const g = a.import_group || '';
        if (g) groupCounts[g] = (groupCounts[g] || 0) + 1;
    });

    let prevGroup = null;
    tbody.innerHTML = accounts.map((a, idx) => {
        const badgeClass = a.status === 'active' ? 'badge-active' :
                           a.status === 'error' ? 'badge-error' :
                           a.status === 'unknown' ? 'badge-unknown' : 'badge-pending';
        const methodLabel = a.login_method === 'cookie' ? 'Cookie' : a.login_method === 'authtoken' ? 'AuthToken' : 'ID/PW';
        const grp = a.import_group || '';
        const grpColor = _getGroupColor(grp);
        const borderStyle = grp ? `border-left:3px solid ${grpColor};` : 'border-left:3px solid transparent;';

        // グループの先頭行にラベル表示
        let groupLabel = '';
        if (grp && grp !== prevGroup) {
            const cnt = groupCounts[grp] || 0;
            const ts = grp.replace('imp_','').replace(/_/g,' ');
            groupLabel = `<tr class="acct-group-header" style="background:${grpColor}15;">
                <td colspan="9" style="padding:4px 12px;font-size:11px;border-left:3px solid ${grpColor};">
                    <span style="color:${grpColor};font-weight:600;">${cnt}件</span>
                    <span style="color:var(--text-muted);margin-left:6px;">imported ${ts}</span>
                </td>
            </tr>`;
        }
        prevGroup = grp;

        return `${groupLabel}<tr class="acct-row" data-username="${a.username}" style="${borderStyle}">
            <td style="width:32px;"><input type="checkbox" class="account-checkbox" value="${a.username}"></td>
            <td>
                <div style="display:flex;align-items:center;gap:8px;">
                    ${accountAvatarHtml(a.username, 30)}
                    <div>
                        <div style="display:flex;align-items:center;gap:4px;">
                            <strong style="font-size:13px;">@${a.username}</strong>
                            <button class="copy-id-btn" onclick="event.stopPropagation();copyToClipboard('${a.username}',this)" title="IDをコピー">ID</button>
                        </div>
                        <div style="display:flex;gap:3px;margin-top:2px;">${_buildEditBadges(a)}</div>
                    </div>
                </div>
            </td>
            <td>${_buildStatsCell(a.username)}</td>
            <td>${_buildShadowbanCell(a.username)}</td>
            <td style="white-space:nowrap;font-size:12px;">${methodLabel}</td>
            <td style="font-size:11px;color:var(--text-muted);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${a.proxy || '-'}</td>
            <td><span class="badge ${badgeClass}">${a.status || '不明'}</span></td>
            <td style="font-size:12px;white-space:nowrap;">${a.last_login || '-'}</td>
            <td style="white-space:nowrap;">
                <div style="display:flex;gap:4px;align-items:center;">
                    <button class="btn btn-sm btn-outline" onclick="showAccountDetail('${a.username}')" style="padding:4px 6px;font-size:11px;" title="詳細情報">&#128269;</button>
                    <button class="btn btn-sm btn-primary" onclick="loginAccount('${a.username}')" style="padding:4px 8px;font-size:11px;">ログイン</button>
                    <button class="btn btn-sm btn-secondary" onclick="openInBrowser('${a.username}')" style="padding:4px 8px;font-size:11px;">ブラウザ</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteAccount('${a.username}')" style="padding:4px 6px;font-size:11px;">✕</button>
                </div>
            </td>
        </tr>`;
    }).join('');

    // ドラッグ選択の初期化
    activateLazyAvatars(tbody);
    _initAccountDragSelect();
}

// ========== アカウントテーブル ドラッグ選択 ==========
let _acctDragState = null;

function _initAccountDragSelect() {
    const wrapper = document.querySelector('#page-accounts .table-wrapper');
    if (!wrapper || wrapper._dragBound) return;
    wrapper._dragBound = true;
    wrapper.addEventListener('mousedown', _acctDragStart);
    document.addEventListener('mousemove', _acctDragMove);
    document.addEventListener('mouseup', _acctDragEnd);
    // スクロール中もドラッグ選択を追従させる (passiveでスクロール性能を維持)
    document.addEventListener('wheel', _acctDragWheel, { passive: true });
}

function _acctDragStart(e) {
    // ボタン・チェックボックス・リンク上ではドラッグしない
    if (e.button !== 0) return;
    if (e.target.closest('button, a, input')) return;

    let selBox = document.getElementById('acct-drag-select-box');
    if (!selBox) {
        selBox = document.createElement('div');
        selBox.id = 'acct-drag-select-box';
        document.body.appendChild(selBox);
    }
    _acctDragState = {
        startX: e.clientX, startY: e.clientY,
        curX: e.clientX, curY: e.clientY,
        scrollY: window.scrollY,
        moved: false,
    };
    selBox.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;width:0;height:0;
        border:2px solid var(--primary);background:rgba(59,130,246,0.12);
        pointer-events:none;z-index:9999;border-radius:3px;display:none;`;
    e.preventDefault();
}

function _acctDragUpdateBox() {
    if (!_acctDragState) return;
    const selBox = document.getElementById('acct-drag-select-box');
    if (!selBox) return;

    // スクロール差分を加味して開始位置を補正
    const scrollDelta = window.scrollY - _acctDragState.scrollY;
    const adjustedStartY = _acctDragState.startY - scrollDelta;

    const dx = _acctDragState.curX - _acctDragState.startX;
    const dy = _acctDragState.curY - adjustedStartY;

    if (!_acctDragState.moved && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) _acctDragState.moved = true;
    if (!_acctDragState.moved) return;

    const x = Math.min(_acctDragState.curX, _acctDragState.startX);
    const y = Math.min(_acctDragState.curY, adjustedStartY);
    const w = Math.abs(dx);
    const h = Math.abs(dy);

    selBox.style.left = x + 'px';
    selBox.style.top = y + 'px';
    selBox.style.width = w + 'px';
    selBox.style.height = h + 'px';
    selBox.style.display = 'block';

    const selRect = { left: x, top: y, right: x + w, bottom: y + h };
    document.querySelectorAll('#accounts-table .acct-row').forEach(row => {
        const rr = row.getBoundingClientRect();
        const overlaps = !(rr.right < selRect.left || rr.left > selRect.right || rr.bottom < selRect.top || rr.top > selRect.bottom);
        row.style.background = overlaps ? 'rgba(59,130,246,0.1)' : '';
    });
}

function _acctDragMove(e) {
    if (!_acctDragState) return;
    _acctDragState.curX = e.clientX;
    _acctDragState.curY = e.clientY;
    _acctDragUpdateBox();
}

function _acctDragWheel(e) {
    if (!_acctDragState || !_acctDragState.moved) return;
    // スクロール後に選択ボックスを再描画
    requestAnimationFrame(() => _acctDragUpdateBox());
}

function _acctDragEnd(e) {
    if (!_acctDragState) return;
    const selBox = document.getElementById('acct-drag-select-box');
    if (selBox) selBox.style.display = 'none';

    if (_acctDragState.moved) {
        const scrollDelta = window.scrollY - _acctDragState.scrollY;
        const adjustedStartY = _acctDragState.startY - scrollDelta;

        const x = Math.min(e.clientX, _acctDragState.startX);
        const y = Math.min(e.clientY, adjustedStartY);
        const w = Math.abs(e.clientX - _acctDragState.startX);
        const h = Math.abs(e.clientY - adjustedStartY);
        const selRect = { left: x, top: y, right: x + w, bottom: y + h };

        document.querySelectorAll('#accounts-table .acct-row').forEach(row => {
            row.style.background = '';
            const rr = row.getBoundingClientRect();
            const overlaps = !(rr.right < selRect.left || rr.left > selRect.right || rr.bottom < selRect.top || rr.top > selRect.bottom);
            if (overlaps) {
                const cb = row.querySelector('.account-checkbox');
                if (cb) cb.checked = true;
            }
        });
    }
    _acctDragState = null;
}

function filterAccountTable(filter) {
    document.querySelectorAll('.filter-btn').forEach(b => {
        b.classList.toggle('btn-primary', b.dataset.filter === filter);
        b.classList.toggle('btn-outline', b.dataset.filter !== filter);
    });
    const accts = _allAccountsCache || [];
    const filters = {
        'all':        () => accts,
        'no-icon':    () => accts.filter(a => !a.edited_icon),
        'no-name':    () => accts.filter(a => !a.edited_name),
        'no-bio':     () => accts.filter(a => !a.edited_bio),
        'no-profile': () => accts.filter(a => !_hasAnyEdit(a)),
        'edited':     () => accts.filter(a => _hasAnyEdit(a)),
    };
    _renderAccountTable((filters[filter] || filters['all'])());
}

async function addAccount() {
    const data = {
        username: document.getElementById('new-username').value.trim(),
        password: document.getElementById('new-password').value,
        email: document.getElementById('new-email').value.trim(),
        auth_token: document.getElementById('new-authtoken').value.trim(),
        proxy: document.getElementById('new-proxy').value.trim(),
        login_method: document.getElementById('new-login-method').value,
        notes: document.getElementById('new-notes').value.trim(),
    };
    if (!data.username) {
        showToast('ユーザー名を入力してください', 'error');
        return;
    }
    try {
        await apiPost('/api/accounts', data);
        showToast(`@${data.username} を追加しました`, 'success');
        closeModal('add-account-modal');
        ['new-username','new-password','new-email','new-authtoken','new-proxy','new-notes']
            .forEach(id => document.getElementById(id).value = '');
        refreshAccounts();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// ============================================
// アカウント一括インポート
// ============================================
function toggleBulkImport() {
    const area = document.getElementById('bulk-import-area');
    area.style.display = area.style.display === 'none' ? 'block' : 'none';
}

async function bulkImportAccounts() {
    const text = document.getElementById('bulk-import-text').value.trim();
    if (!text) {
        showToast('アカウント情報を入力してください', 'error');
        return;
    }
    const resultEl = document.getElementById('bulk-import-result');
    const lineCount = text.split('\n').filter(l => l.trim()).length;
    showProcessing('アカウントインポート中...', `${lineCount}行を処理しています`);

    try {
        const res = await apiPost('/api/accounts/bulk-import', { text });
        hideProcessing();
        showToast(res.message, 'success');
        resultEl.style.color = 'var(--success)';
        let msg = `✅ ${res.imported}件インポート`;
        if (res.skipped > 0) msg += ` / ${res.skipped}件スキップ`;
        if (res.errors.length > 0) msg += `\n⚠ ${res.errors.join(', ')}`;
        resultEl.textContent = msg;
        if (res.imported > 0) {
            document.getElementById('bulk-import-text').value = '';
            refreshAccounts();
        }
    } catch (e) {
        updateProcessing('インポート失敗', e.message, 100);
        _markProcessingError();
        setTimeout(() => hideProcessing(), 2000);
        showToast('インポート失敗: ' + e.message, 'error');
        resultEl.textContent = '❌ ' + e.message;
        resultEl.style.color = 'var(--danger)';
    }
}

let _publicCheckMode = 'simple';
let _publicCheckDelimiter = '|';
let _publicCheckSpaceSeparator = false;
let _publicCheckProxyCache = [];
let _shadowbanProxyCache = [];
const _PUBLIC_CHECK_FIELDS = [
    { value: '', label: '-- スキップ --' },
    { value: 'username', label: 'username *' },
];

function switchPublicCheckTab(mode) {
    _publicCheckMode = mode;
    const simpleTab = document.getElementById('public-check-tab-simple');
    const mappedTab = document.getElementById('public-check-tab-mapped');
    const simpleArea = document.getElementById('public-check-mode-simple');
    const mappedArea = document.getElementById('public-check-mode-mapped');

    if (mode === 'simple') {
        simpleTab.className = 'btn btn-sm btn-primary';
        mappedTab.className = 'btn btn-sm btn-outline';
        simpleArea.style.display = '';
        mappedArea.style.display = 'none';
    } else {
        simpleTab.className = 'btn btn-sm btn-outline';
        mappedTab.className = 'btn btn-sm btn-primary';
        simpleArea.style.display = 'none';
        mappedArea.style.display = '';
        updatePublicCheckPreview();
    }
}

function selectPublicCheckDelimiter(btn) {
    btn.parentElement.querySelectorAll('[data-public-delim]').forEach(b => {
        b.className = 'btn btn-sm btn-outline';
    });
    btn.className = 'btn btn-sm btn-primary';
    _publicCheckDelimiter = btn.dataset.publicDelim;
    document.getElementById('public-check-custom-delim-input').value = '';
    _syncPublicCheckSpaceSeparatorState();
    updatePublicCheckPreview();
}

function onPublicCheckDelimiterInput() {
    const val = document.getElementById('public-check-custom-delim-input').value;
    if (!val) return;
    _publicCheckDelimiter = val;
    document.querySelectorAll('#public-check-mode-mapped [data-public-delim]').forEach(b => {
        b.className = 'btn btn-sm btn-outline';
    });
    _syncPublicCheckSpaceSeparatorState();
    updatePublicCheckPreview();
}

function onPublicCheckSpaceSeparatorChange() {
    const cb = document.getElementById('public-check-space-separator');
    _publicCheckSpaceSeparator = cb.checked;
    document.getElementById('public-check-space-sep-example').style.display = cb.checked ? '' : 'none';
    _syncPublicCheckSpaceSeparatorState();
    updatePublicCheckPreview();
}

function _syncPublicCheckSpaceSeparatorState() {
    const spaceBtn = document.getElementById('public-delim-btn-space');
    const spaceCb = document.getElementById('public-check-space-separator');
    if (!spaceBtn || !spaceCb) return;
    if (_publicCheckDelimiter === ' ') {
        spaceCb.checked = false;
        spaceCb.disabled = true;
        _publicCheckSpaceSeparator = false;
        document.getElementById('public-check-space-sep-example').style.display = 'none';
    } else {
        spaceCb.disabled = false;
    }
    if (_publicCheckSpaceSeparator) {
        spaceBtn.style.opacity = '0.4';
        spaceBtn.style.pointerEvents = 'none';
    } else {
        spaceBtn.style.opacity = '';
        spaceBtn.style.pointerEvents = '';
    }
}

function updatePublicCheckPreview() {
    const text = document.getElementById('public-check-mapped-text')?.value.trim();
    const previewArea = document.getElementById('public-check-preview');
    const tableArea = document.getElementById('public-check-preview-table');
    if (!previewArea || !tableArea) return;

    if (!text || !_publicCheckDelimiter) {
        previewArea.style.display = 'none';
        return;
    }

    const lines = _expandCustomLines(text, _publicCheckDelimiter, _publicCheckSpaceSeparator);
    if (lines.length === 0) {
        previewArea.style.display = 'none';
        return;
    }

    const previewLines = lines.slice(0, 5);
    const rows = previewLines.map(l => l.split(_publicCheckDelimiter));
    const maxCols = Math.max(...rows.map(r => r.length));
    const prevMapping = _getCurrentPublicCheckFieldMapping();

    let html = '<table style="width:100%;border-collapse:collapse;font-size:12px;">';
    html += '<tr>';
    for (let c = 0; c < maxCols; c++) {
        const prevVal = prevMapping[c] || '';
        html += `<th style="padding:4px;border:1px solid var(--border);background:var(--bg-dark);min-width:110px;">
            <select class="public-check-field-select" data-col="${c}"
                    onchange="onPublicCheckFieldMappingChange()" style="width:100%;font-size:11px;padding:2px 4px;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:4px;">`;
        _PUBLIC_CHECK_FIELDS.forEach(f => {
            const selected = prevVal === f.value ? ' selected' : '';
            html += `<option value="${f.value}"${selected}>${f.label}</option>`;
        });
        html += `</select>
            <div style="text-align:center;color:var(--text-muted);font-size:10px;margin-top:2px;">列${c + 1}</div>
        </th>`;
    }
    html += '</tr>';

    rows.forEach((cols, rIdx) => {
        html += '<tr>';
        for (let c = 0; c < maxCols; c++) {
            const val = cols[c] !== undefined ? _escHtml(cols[c].trim()) : '';
            const bg = rIdx % 2 === 0 ? '' : 'background:rgba(255,255,255,0.03);';
            html += `<td style="padding:4px 6px;border:1px solid var(--border);${bg}font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px;" title="${val}">${val || '<span style="color:var(--text-muted);">-</span>'}</td>`;
        }
        html += '</tr>';
    });
    if (lines.length > 5) {
        html += `<tr><td colspan="${maxCols}" style="padding:6px;text-align:center;color:var(--text-muted);border:1px solid var(--border);font-size:11px;">... 他 ${lines.length - 5} 行</td></tr>`;
    }
    html += '</table>';

    const delimLabel = _publicCheckDelimiter === '\t' ? 'TAB' : _publicCheckDelimiter === ' ' ? 'スペース' : _publicCheckDelimiter;
    html += `<div style="margin-top:6px;font-size:11px;color:var(--text-muted);">
        合計 ${lines.length} 行 / ${maxCols} 列検出（区切り: <code>${_escHtml(delimLabel)}</code>${_publicCheckSpaceSeparator ? '、スペースでアカウント区切り' : ''}）
    </div>`;

    tableArea.innerHTML = html;
    previewArea.style.display = '';
    if (!Object.values(prevMapping).includes('username') && maxCols > 0) {
        const first = document.querySelector('.public-check-field-select');
        if (first) {
            first.value = 'username';
            onPublicCheckFieldMappingChange();
        }
    }
}

function _getCurrentPublicCheckFieldMapping() {
    const mapping = {};
    document.querySelectorAll('.public-check-field-select').forEach(sel => {
        mapping[parseInt(sel.dataset.col)] = sel.value;
    });
    return mapping;
}

function onPublicCheckFieldMappingChange() {
    const selects = document.querySelectorAll('.public-check-field-select');
    let usernameCount = 0;
    selects.forEach(sel => {
        if (sel.value === 'username') usernameCount += 1;
    });
    selects.forEach(sel => {
        if (sel.value === 'username' && usernameCount > 1) {
            sel.style.borderColor = 'var(--danger)';
        } else {
            sel.style.borderColor = 'var(--border)';
        }
    });
}

function autoDetectPublicCheckFieldMapping() {
    if (_publicCheckMode !== 'mapped') return;
    const text = document.getElementById('public-check-mapped-text').value.trim();
    if (!text || !_publicCheckDelimiter) {
        showToast('先にデータと区切り文字を設定してください', 'error');
        return;
    }
    const selects = document.querySelectorAll('.public-check-field-select');
    if (selects.length === 0) {
        updatePublicCheckPreview();
        setTimeout(() => autoDetectPublicCheckFieldMapping(), 100);
        return;
    }

    const firstLine = _expandCustomLines(text, _publicCheckDelimiter, _publicCheckSpaceSeparator)[0] || '';
    const parts = firstLine.split(_publicCheckDelimiter).map(p => p.trim());
    let targetIndex = 0;
    for (let i = 0; i < parts.length; i++) {
        const val = parts[i];
        if (/^@?[A-Za-z0-9_]{1,15}$/.test(val) || /https?:\/\/(x|twitter)\.com\//i.test(val)) {
            targetIndex = i;
            break;
        }
    }

    selects.forEach((sel, idx) => {
        sel.value = idx === targetIndex ? 'username' : '';
    });
    onPublicCheckFieldMappingChange();
    showToast('username 列を自動推測しました。確認してください。', 'info');
}

function _buildPublicCheckTextForRequest() {
    if (_publicCheckMode === 'simple') {
        return document.getElementById('public-check-text').value.trim();
    }

    const raw = document.getElementById('public-check-mapped-text').value.trim();
    if (!raw) return '';

    const mapping = _getCurrentPublicCheckFieldMapping();
    const usernameCols = Object.keys(mapping).filter(col => mapping[col] === 'username');
    if (usernameCols.length !== 1) {
        throw new Error('username 列を1つだけ指定してください');
    }

    const usernameCol = Number(usernameCols[0]);
    const lines = _expandCustomLines(raw, _publicCheckDelimiter, _publicCheckSpaceSeparator);
    const extracted = lines
        .map(line => {
            const cols = line.split(_publicCheckDelimiter);
            return (cols[usernameCol] || '').trim();
        })
        .filter(Boolean);

    return extracted.join('\n');
}

async function loadPublicCheckFile() {
    const input = document.getElementById('public-check-file');
    const file = input.files && input.files[0];
    if (!file) {
        showToast('txtファイルを選択してください', 'error');
        return;
    }
    try {
        const text = await file.text();
        document.getElementById('public-check-text').value = text;
        document.getElementById('public-check-mapped-text').value = text;
        if (_publicCheckMode === 'mapped') updatePublicCheckPreview();
        showToast(`${file.name} を読み込みました`, 'success');
    } catch (e) {
        showToast('ファイル読み込み失敗: ' + e.message, 'error');
    }
}

async function loadImportedAccountsIntoPublicCheck() {
    try {
        const accounts = _allAccountsCache && _allAccountsCache.length
            ? _allAccountsCache
            : await apiGet('/api/accounts');
        const usernames = accounts
            .map(a => (a.username || '').trim())
            .filter(Boolean);

        if (usernames.length === 0) {
            showToast('登録済みアカウントがありません', 'info');
            return;
        }

        const text = usernames.join('\n');
        const simple = document.getElementById('public-check-text');
        const mapped = document.getElementById('public-check-mapped-text');
        if (simple) simple.value = text;
        if (mapped) mapped.value = text;
        switchPublicCheckTab('simple');
        showToast(`${usernames.length}件の登録済みアカウントを読み込みました`, 'success');
    } catch (e) {
        showToast('登録済みアカウントの読み込み失敗: ' + e.message, 'error');
    }
}

function clearPublicCheckFile() {
    const input = document.getElementById('public-check-file');
    if (input) input.value = '';
    const textSimple = document.getElementById('public-check-text');
    const textMapped = document.getElementById('public-check-mapped-text');
    if (textSimple) textSimple.value = '';
    if (textMapped) textMapped.value = '';
    const resultEl = document.getElementById('public-check-result');
    if (resultEl) resultEl.textContent = '';
    const preview = document.getElementById('public-check-preview');
    if (preview) preview.style.display = 'none';
    showToast('アップロード内容をクリアしました', 'info');
}

async function loadPublicCheckProxyOptions() {
    const container = document.getElementById('public-check-proxy-list');
    if (!container) return;
    container.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">Proxyを読み込み中...</div>';

    try {
        const data = await apiGet('/api/proxy/list');
        const proxies = (data.proxies || []).map(p => ({
            url: p.proxy,
            label: p.display_name ? `${p.display_name} (${p.proxy})` : p.proxy,
            accountCount: p.account_count || 0,
        }));
        _publicCheckProxyCache = proxies;

        if (proxies.length === 0) {
            container.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">登録済みProxyはありません</div>';
            return;
        }

        container.innerHTML = proxies.map((proxy, idx) => `
            <label style="display:flex;align-items:flex-start;gap:8px;padding:8px 4px;border-bottom:1px solid rgba(255,255,255,0.05);cursor:pointer;">
                <input type="checkbox" class="public-check-proxy-cb" value="${_escHtml(proxy.url)}" ${idx < 3 ? 'checked' : ''}>
                <span style="font-size:12px;line-height:1.5;">
                    <span style="display:block;color:var(--text);">${_escHtml(proxy.label)}</span>
                    <span style="color:var(--text-muted);">${proxy.accountCount} アカウントで使用中</span>
                </span>
            </label>
        `).join('');
    } catch (e) {
        container.innerHTML = `<div style="color:var(--danger);font-size:12px;">Proxy読込失敗: ${_escHtml(e.message)}</div>`;
    }
}

function selectAllPublicCheckProxies(checked) {
    document.querySelectorAll('.public-check-proxy-cb').forEach(cb => {
        cb.checked = checked;
    });
}

function _getSelectedPublicCheckProxies() {
    const selected = [];
    document.querySelectorAll('.public-check-proxy-cb:checked').forEach(cb => {
        selected.push(cb.value.trim());
    });
    const manual = document.getElementById('public-check-proxy').value
        .split('\n')
        .map(v => v.trim())
        .filter(Boolean);

    return [...new Set([...selected, ...manual])];
}

function _renderPublicCheckScreenshotCell(row) {
    if (!row || !row.screenshot_url) {
        const err = row && row.screenshot_error
            ? `<div style="color:var(--danger);font-size:11px;margin-top:4px;">${_escHtml(row.screenshot_error)}</div>`
            : '';
        return `<span style="color:var(--text-muted);font-size:12px;">-</span>${err}`;
    }
    const filename = row.screenshot_file || `${row.username || 'public-check'}.png`;
    return `
        <div class="public-check-shot">
            <a href="${_escHtml(row.screenshot_url)}" target="_blank" rel="noopener noreferrer">
                <img class="public-check-shot-thumb" src="${_escHtml(row.screenshot_url)}" alt="@${_escHtml(row.username || '')} screenshot">
            </a>
            <div class="public-check-shot-actions">
                <a href="${_escHtml(row.screenshot_url)}" target="_blank" rel="noopener noreferrer">開く</a>
                <a href="${_escHtml(row.screenshot_url)}" download="${_escHtml(filename)}">保存</a>
            </div>
        </div>
    `;
}

async function runPublicAccountCheck() {
    const runBtn = document.getElementById('public-check-run-btn');
    let text = '';
    try {
        text = _buildPublicCheckTextForRequest();
    } catch (e) {
        showToast(e.message, 'error');
        return;
    }
    const proxies = _getSelectedPublicCheckProxies();
    const concurrency = parseInt(document.getElementById('public-check-concurrency').value, 10) || 1;
    const humanize = document.getElementById('public-check-humanize').checked;
    const saveScreenshots = document.getElementById('public-check-save-screenshots').checked;
    const resultEl = document.getElementById('public-check-result');
    if (!text) {
        showToast('チェック対象を入力してください', 'error');
        return;
    }

    if (runBtn) {
        runBtn.classList.add('is-loading');
        runBtn.textContent = 'チェック中...';
    }
    resultEl.textContent = '';
    resultEl.style.color = 'var(--text-muted)';
    resultEl.textContent = 'チェックを開始しています...';
    setPublicCheckLoadingState(true, '開始しています...', 3);
    showProcessing('公開状態をチェック中...', 'Xプロフィールを順番に確認しています');

    try {
        const res = await apiPost('/api/accounts/public-check', {
            text,
            proxies,
            humanize,
            concurrency,
            save_screenshots: saveScreenshots,
        });
        _pollPublicAccountCheckTask(res.task_id, res.total || 0, {
            proxy_enabled: proxies.length > 0,
            proxy_count: proxies.length,
            humanize,
            concurrency,
            save_screenshots: saveScreenshots,
        });
    } catch (e) {
        updateProcessing('チェック開始失敗', e.message, 100);
        _markProcessingError();
        setTimeout(() => hideProcessing(), 2000);
        showToast('公開状態チェック失敗: ' + e.message, 'error');
        resultEl.textContent = '❌ ' + e.message;
        resultEl.style.color = 'var(--danger)';
        setPublicCheckLoadingState(false);
        if (runBtn) {
            runBtn.classList.remove('is-loading');
            runBtn.textContent = 'チェック実行';
        }
    }
}

async function _pollPublicAccountCheckTask(taskId, total, options = {}) {
    const poll = async () => {
        try {
            const task = await apiGet(`/api/tasks/${taskId}`);
            const progress = task.progress || 0;
            const pct = total > 0 ? Math.round(progress / total * 100) : 0;
            updateProcessing('公開状態をチェック中...', `${progress} / ${total} アカウント`, pct);
            setPublicCheckLoadingState(true, `${progress} / ${total} アカウントを確認中`, pct);

            if (task.results && task.results.length > 0) {
                renderPublicAccountCheckResults({
                    created_at: new Date().toISOString(),
                    total,
                    results: task.results,
                    proxy_enabled: options.proxy_enabled,
                    proxy_count: options.proxy_count,
                    humanize: options.humanize,
                    concurrency: options.concurrency,
                    save_screenshots: options.save_screenshots,
                });
            }

            if (task.status === 'running') {
                setTimeout(poll, 1500);
                return;
            }

            if (task.status === 'completed') {
                updateProcessing('公開状態チェック完了', `${progress} / ${total} アカウント`, 100);
                const resultEl = document.getElementById('public-check-result');
                resultEl.textContent = `✅ ${progress}件をチェックしました`;
                resultEl.style.color = 'var(--success)';
                setPublicCheckLoadingState(false);
                const runBtn = document.getElementById('public-check-run-btn');
                if (runBtn) {
                    runBtn.classList.remove('is-loading');
                    runBtn.textContent = 'チェック実行';
                }
                setTimeout(() => hideProcessing(), 800);
                showToast('公開状態チェック完了', 'success');
                return;
            }

            updateProcessing('公開状態チェック失敗', (task.errors || []).join(', ') || 'エラー', 100);
            _markProcessingError();
            const resultEl = document.getElementById('public-check-result');
            resultEl.textContent = '❌ ' + ((task.errors || []).join(', ') || 'エラー');
            resultEl.style.color = 'var(--danger)';
            setPublicCheckLoadingState(false);
            const runBtn = document.getElementById('public-check-run-btn');
            if (runBtn) {
                runBtn.classList.remove('is-loading');
                runBtn.textContent = 'チェック実行';
            }
            setTimeout(() => hideProcessing(), 2000);
        } catch (e) {
            const resultEl = document.getElementById('public-check-result');
            resultEl.textContent = '❌ タスク監視エラー';
            resultEl.style.color = 'var(--danger)';
            setPublicCheckLoadingState(false);
            const runBtn = document.getElementById('public-check-run-btn');
            if (runBtn) {
                runBtn.classList.remove('is-loading');
                runBtn.textContent = 'チェック実行';
            }
            hideProcessing();
            showToast('タスク監視エラー: ' + e.message, 'error');
        }
    };
    setTimeout(poll, 1000);
}

function setPublicCheckLoadingState(visible, text = '', percent = 0) {
    const card = document.getElementById('public-check-loading');
    const textEl = document.getElementById('public-check-loading-text');
    const bar = document.getElementById('public-check-loading-bar-fill');
    if (!card || !textEl || !bar) return;
    card.style.display = visible ? '' : 'none';
    if (text) textEl.textContent = text;
    bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

async function loadLatestPublicAccountCheck() {
    try {
        const data = await apiGet('/api/accounts/public-check/latest');
        if (!data.results || data.results.length === 0) {
            showToast('前回結果はまだありません', 'info');
            return;
        }
        renderPublicAccountCheckResults(data);
        showToast('前回結果を表示しました', 'success');
    } catch (e) {
        showToast('前回結果の読み込み失敗: ' + e.message, 'error');
    }
}

async function copyRestrictedPublicCheckList() {
    const textarea = document.getElementById('public-check-restricted-copy');
    if (!textarea || !textarea.value.trim()) {
        showToast('コピー対象がありません', 'info');
        return;
    }
    try {
        await navigator.clipboard.writeText(textarea.value.trim());
        showToast('制限系アカウント一覧をコピーしました', 'success');
    } catch (e) {
        textarea.focus();
        textarea.select();
        document.execCommand('copy');
        showToast('制限系アカウント一覧をコピーしました', 'success');
    }
}

let _lastPublicCheckResults = [];

async function deleteRestrictedPublicCheckAccounts() {
    const targets = (_lastPublicCheckResults || [])
        .filter(r => ['注意', '凍結', '表示制限'].includes(r.status))
        .map(r => (r.username || '').trim())
        .filter(Boolean);

    if (targets.length === 0) {
        showToast('削除対象の制限系アカウントがありません', 'info');
        return;
    }

    if (!confirm(`制限ありと判定された ${targets.length} アカウントを削除しますか？\n\n${targets.map(u => '@' + u).join('\n')}\n\n履歴は削除済みアーカイブへ保存されます。`)) {
        return;
    }

    showProcessing('制限系アカウント削除中...', `0 / ${targets.length}`);
    let deleted = 0;
    const errors = [];

    for (let i = 0; i < targets.length; i++) {
        const username = targets[i];
        try {
            const resp = await fetch(`${API}/api/accounts/${encodeURIComponent(username)}?reason=public_check_restricted`, { method: 'DELETE' });
            if (!resp.ok) throw new Error((await resp.json()).detail || resp.statusText);
            deleted += 1;
        } catch (e) {
            errors.push(`@${username}: ${e.message}`);
        }
        updateProcessing(undefined, `${i + 1} / ${targets.length}`, ((i + 1) / targets.length) * 100);
    }

    hideProcessing();

    const deletedSet = new Set(targets.filter(u => !errors.some(err => err.startsWith('@' + u))));
    _lastPublicCheckResults = (_lastPublicCheckResults || []).filter(r => !deletedSet.has((r.username || '').trim()));
    renderPublicAccountCheckResults({ results: _lastPublicCheckResults });

    try {
        if (typeof refreshAccounts === 'function') await refreshAccounts();
    } catch (_) {}

    if (errors.length > 0) {
        showToast(`${deleted}件削除、${errors.length}件失敗`, 'warning');
    } else {
        showToast(`制限系アカウント ${deleted} 件を削除しました`, 'success');
    }
}

function renderPublicAccountCheckResults(data) {
    const resultsCard = document.getElementById('public-check-results');
    const body = document.getElementById('public-check-results-body');
    const summary = document.getElementById('public-check-summary');
    const downloadBtn = document.getElementById('public-check-download-restricted-btn');
    const copyBtn = document.getElementById('public-check-copy-restricted-btn');
    const deleteBtn = document.getElementById('public-check-delete-restricted-btn');
    const copyWrap = document.getElementById('public-check-restricted-copy-wrap');
    const copyText = document.getElementById('public-check-restricted-copy');
    const results = (data && data.results) ? data.results : [];
    _lastPublicCheckResults = results.slice();
    if (results.length === 0) {
        resultsCard.style.display = 'none';
        return;
    }

    const counts = {};
    results.forEach(r => {
        counts[r.status] = (counts[r.status] || 0) + 1;
    });
    const restrictedCount = results.filter(r =>
        ['注意', '凍結', '表示制限'].includes(r.status) && !!r.screenshot_url
    ).length;
    const restrictedUsernames = results
        .filter(r => ['注意', '凍結', '表示制限'].includes(r.status))
        .map(r => (r.username || '').trim())
        .filter(Boolean);

    const createdAt = data.created_at ? new Date(data.created_at) : null;
    const createdLabel = createdAt && !Number.isNaN(createdAt.getTime())
        ? createdAt.toLocaleString('ja-JP')
        : '';
    const modeLabel = [
        data.proxy_enabled ? 'Proxy ON' : 'Proxy OFF',
        `${data.proxy_count || 0} Proxy`,
        `${data.concurrency || 1} 並列`,
        data.humanize === false ? 'Humanize OFF' : 'Humanize ON',
        data.save_screenshots === false ? 'スクショOFF' : 'スクショON',
    ].join(' / ');
    summary.textContent = `${results.length}件 / ${modeLabel}` + (createdLabel ? ` / ${createdLabel}` : '');
    if (downloadBtn) {
        if (restrictedCount > 0) {
            downloadBtn.style.display = '';
            downloadBtn.textContent = `制限系スクショ一括DL (${restrictedCount})`;
        } else {
            downloadBtn.style.display = 'none';
        }
    }
    if (copyBtn && copyWrap && copyText) {
        if (restrictedUsernames.length > 0) {
            copyText.value = restrictedUsernames.join(',');
            copyWrap.style.display = '';
            copyBtn.style.display = '';
            copyBtn.textContent = `制限系をコピー (${restrictedUsernames.length})`;
            if (deleteBtn) {
                deleteBtn.style.display = '';
                deleteBtn.textContent = `制限系を一括削除 (${restrictedUsernames.length})`;
            }
        } else {
            copyText.value = '';
            copyWrap.style.display = 'none';
            copyBtn.style.display = 'none';
            if (deleteBtn) deleteBtn.style.display = 'none';
        }
    }

    const badgeClass = (status) => {
        if (status === '凍結' || status === '存在しない' || status === 'エラー') return 'badge-error';
        if (status === '注意' || status === '表示制限') return 'badge-warning';
        if (status === '表示なし') return 'badge-active';
        return 'badge-unknown';
    };

    const countsHtml = Object.keys(counts).map(status =>
        `<span class="badge ${badgeClass(status)}" style="margin-right:4px;">${status}: ${counts[status]}</span>`
    ).join('');

    body.innerHTML = `
        <div style="margin-bottom:10px;">${countsHtml}</div>
        <div class="table-wrapper">
            <table>
                <thead>
                    <tr>
                        <th>アカウント</th>
                        <th>判定</th>
                        <th>Proxy</th>
                        <th>スクショ</th>
                        <th>検出文言</th>
                        <th>詳細</th>
                    </tr>
                </thead>
                <tbody>
                    ${results.map(r => `
                        <tr>
                            <td style="white-space:nowrap;">
                                <div><strong>@${_escHtml(r.username || '')}</strong></div>
                                <div style="font-size:11px;color:var(--text-muted);">
                                    <a href="${_escHtml(r.url || '#')}" target="_blank" rel="noopener noreferrer">${_escHtml(r.url || '')}</a>
                                </div>
                            </td>
                            <td><span class="badge ${badgeClass(r.status)}">${_escHtml(r.status || '-')}</span></td>
                            <td style="font-size:11px;max-width:260px;word-break:break-word;color:var(--text-muted);">${_escHtml(r.proxy || '-')}</td>
                            <td>${_renderPublicCheckScreenshotCell(r)}</td>
                            <td style="font-size:12px;max-width:360px;word-break:break-word;">${_escHtml(r.matched_text || '-')}</td>
                            <td style="font-size:12px;max-width:360px;word-break:break-word;">
                                <div>${_escHtml(r.reason || '-')}</div>
                                <div style="color:var(--text-muted);margin-top:4px;">${_escHtml(r.title || '')}</div>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
    resultsCard.style.display = '';
}

// ============================================
// カスタムインポート
// ============================================
let _customDelimiter = '|';
let _customSpaceSeparator = false;
const _CUSTOM_IMPORT_FIELDS = [
    { value: '',              label: '-- スキップ --' },
    { value: 'username',      label: 'username *' },
    { value: 'password',      label: 'password' },
    { value: 'email',         label: 'email' },
    { value: 'auth_token',    label: 'auth_token' },
    { value: 'cookies',       label: 'cookies' },
    { value: 'proxy',         label: 'proxy' },
    { value: 'notes',         label: 'notes' },
    { value: '2fa',           label: '2FA Key' },
    { value: 'mail_password', label: 'メールPW' },
    { value: 'sms',           label: 'SMS番号' },
    { value: 'backup_code',   label: 'バックアップコード' },
    { value: 'login_method',  label: 'login_method' },
];

function switchImportTab(mode) {
    const autoTab = document.getElementById('import-tab-auto');
    const customTab = document.getElementById('import-tab-custom');
    const autoArea = document.getElementById('import-mode-auto');
    const customArea = document.getElementById('import-mode-custom');
    if (mode === 'auto') {
        _syncBulkImportTexts('custom');
        autoTab.className = 'btn btn-sm btn-primary';
        customTab.className = 'btn btn-sm btn-outline';
        autoArea.style.display = '';
        customArea.style.display = 'none';
    } else {
        _syncBulkImportTexts('auto');
        autoTab.className = 'btn btn-sm btn-outline';
        customTab.className = 'btn btn-sm btn-primary';
        autoArea.style.display = 'none';
        customArea.style.display = '';
        updateCustomImportPreview();
    }
}

function _syncBulkImportTexts(sourceMode) {
    const auto = document.getElementById('bulk-import-text');
    const custom = document.getElementById('custom-import-text');
    if (!auto || !custom) return;
    if (sourceMode === 'custom') {
        auto.value = custom.value;
        return;
    }
    custom.value = auto.value;
}

function syncBulkImportTextFromAuto() {
    _syncBulkImportTexts('auto');
}

function onCustomImportTextInput() {
    _syncBulkImportTexts('custom');
    updateCustomImportPreview();
}

function selectCustomDelimiter(btn) {
    // ボタンのスタイルを切替
    btn.parentElement.querySelectorAll('[data-delim]').forEach(b => {
        b.className = 'btn btn-sm btn-outline';
    });
    btn.className = 'btn btn-sm btn-primary';
    _customDelimiter = btn.dataset.delim;
    document.getElementById('custom-delim-input').value = '';
    // スペースを列区切りに選んだ場合、アカウント区切りのスペースは無効化
    _syncSpaceSeparatorState();
    updateCustomImportPreview();
}

function onCustomDelimiterInput() {
    const val = document.getElementById('custom-delim-input').value;
    if (val) {
        _customDelimiter = val;
        // プリセットボタンのハイライト解除
        document.querySelectorAll('#import-mode-custom [data-delim]').forEach(b => {
            b.className = 'btn btn-sm btn-outline';
        });
        _syncSpaceSeparatorState();
        updateCustomImportPreview();
    }
}

function onSpaceSeparatorChange() {
    const cb = document.getElementById('custom-space-separator');
    _customSpaceSeparator = cb.checked;
    document.getElementById('space-sep-example').style.display = cb.checked ? '' : 'none';
    // スペース区切りONなら列区切りの「スペース」ボタンは排他的に無効化
    _syncSpaceSeparatorState();
    updateCustomImportPreview();
}

function _syncSpaceSeparatorState() {
    const spaceBtn = document.getElementById('delim-btn-space');
    const spaceCb = document.getElementById('custom-space-separator');
    if (!spaceBtn || !spaceCb) return;
    if (_customDelimiter === ' ') {
        // 列区切りがスペースならアカウント区切りスペースは使えない
        spaceCb.checked = false;
        spaceCb.disabled = true;
        _customSpaceSeparator = false;
        document.getElementById('space-sep-example').style.display = 'none';
    } else {
        spaceCb.disabled = false;
    }
    // アカウント区切りがスペースなら列区切り「スペース」ボタンは無効風に
    if (_customSpaceSeparator) {
        spaceBtn.style.opacity = '0.4';
        spaceBtn.style.pointerEvents = 'none';
    } else {
        spaceBtn.style.opacity = '';
        spaceBtn.style.pointerEvents = '';
    }
}

function _expandCustomLines(text, delimiter, spaceSep) {
    // スペースで次のアカウントに移行する展開処理（JS側プレビュー用）
    const rawLines = text.split('\n').filter(l => l.trim());
    if (!spaceSep || delimiter === ' ') return rawLines;
    const out = [];
    for (const rawLine of rawLines) {
        if (rawLine.includes(' ')) {
            const chunks = rawLine.split(' ');
            let buf = '';
            for (const chunk of chunks) {
                if (!chunk) continue;
                if (chunk.includes(delimiter)) {
                    if (buf) out.push(buf);
                    buf = chunk;
                } else {
                    if (buf) { buf += ' ' + chunk; }
                    else { out.push(chunk); }
                }
            }
            if (buf) out.push(buf);
        } else {
            out.push(rawLine);
        }
    }
    return out;
}

function updateCustomImportPreview() {
    const text = document.getElementById('custom-import-text').value.trim();
    const previewArea = document.getElementById('custom-import-preview');
    const tableArea = document.getElementById('custom-import-preview-table');

    if (!text || !_customDelimiter) {
        previewArea.style.display = 'none';
        return;
    }

    const lines = _expandCustomLines(text, _customDelimiter, _customSpaceSeparator);
    if (lines.length === 0) {
        previewArea.style.display = 'none';
        return;
    }

    // 最大5行をプレビュー
    const previewLines = lines.slice(0, 5);
    const rows = previewLines.map(l => l.split(_customDelimiter));
    const maxCols = Math.max(...rows.map(r => r.length));

    // 既存のマッピング状態を保持
    const prevMapping = _getCurrentFieldMapping();

    let html = '<table style="width:100%;border-collapse:collapse;font-size:12px;">';

    // ヘッダ行: フィールド選択ドロップダウン
    html += '<tr>';
    for (let c = 0; c < maxCols; c++) {
        const prevVal = prevMapping[c] || '';
        html += `<th style="padding:4px;border:1px solid var(--border);background:var(--bg-dark);min-width:110px;">
            <select class="custom-import-field-select" data-col="${c}"
                    onchange="onFieldMappingChange()" style="width:100%;font-size:11px;padding:2px 4px;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:4px;">`;
        _CUSTOM_IMPORT_FIELDS.forEach(f => {
            const selected = prevVal === f.value ? ' selected' : '';
            html += `<option value="${f.value}"${selected}>${f.label}</option>`;
        });
        html += `</select>
            <div style="text-align:center;color:var(--text-muted);font-size:10px;margin-top:2px;">列${c + 1}</div>
        </th>`;
    }
    html += '</tr>';

    // データ行
    rows.forEach((cols, rIdx) => {
        html += '<tr>';
        for (let c = 0; c < maxCols; c++) {
            const val = cols[c] !== undefined ? _escHtml(cols[c].trim()) : '';
            const bg = rIdx % 2 === 0 ? '' : 'background:rgba(255,255,255,0.03);';
            html += `<td style="padding:4px 6px;border:1px solid var(--border);${bg}font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px;" title="${val}">${val || '<span style="color:var(--text-muted);">-</span>'}</td>`;
        }
        html += '</tr>';
    });

    // フッタ: 残り行数
    if (lines.length > 5) {
        html += `<tr><td colspan="${maxCols}" style="padding:6px;text-align:center;color:var(--text-muted);border:1px solid var(--border);font-size:11px;">
            ... 他 ${lines.length - 5} 行
        </td></tr>`;
    }

    html += '</table>';
    const delimLabel = _customDelimiter === '\t' ? 'TAB' : _customDelimiter === ' ' ? 'スペース' : _customDelimiter;
    const sepNote = _customSpaceSeparator ? '、スペースでアカウント区切り' : '';
    html += `<div style="margin-top:6px;font-size:11px;color:var(--text-muted);">
        合計 ${lines.length} アカウント / ${maxCols} 列検出（区切り: <code>${_escHtml(delimLabel)}</code>${sepNote}）
    </div>`;

    tableArea.innerHTML = html;
    previewArea.style.display = '';
    if (!Object.values(prevMapping).some(Boolean) && maxCols > 0) {
        _applySuggestedCustomFieldMapping(lines[0] || '', maxCols);
    }
}

function _getCurrentFieldMapping() {
    const mapping = {};
    document.querySelectorAll('.custom-import-field-select').forEach(sel => {
        mapping[parseInt(sel.dataset.col)] = sel.value;
    });
    return mapping;
}

function onFieldMappingChange() {
    // username 重複チェック — 視覚フィードバック
    const selects = document.querySelectorAll('.custom-import-field-select');
    const fieldCounts = {};
    selects.forEach(sel => {
        if (sel.value) {
            fieldCounts[sel.value] = (fieldCounts[sel.value] || 0) + 1;
        }
    });
    selects.forEach(sel => {
        if (sel.value && fieldCounts[sel.value] > 1) {
            sel.style.borderColor = 'var(--danger)';
        } else {
            sel.style.borderColor = 'var(--border)';
        }
    });
}

function autoDetectFieldMapping() {
    const text = document.getElementById('custom-import-text').value.trim();
    if (!text || !_customDelimiter) {
        showToast('先にデータと区切り文字を設定してください', 'error');
        return;
    }

    const firstLine = _expandCustomLines(text, _customDelimiter, _customSpaceSeparator)[0];
    if (!firstLine) return;

    const selects = document.querySelectorAll('.custom-import-field-select');
    if (selects.length === 0) {
        updateCustomImportPreview();
        // Re-call after preview render
        setTimeout(() => autoDetectFieldMapping(), 100);
        return;
    }

    _applySuggestedCustomFieldMapping(firstLine, selects.length);
    showToast('フィールドを自動推測しました。確認してください。', 'info');
}

function _applySuggestedCustomFieldMapping(firstLine, maxCols) {
    const parts = firstLine.split(_customDelimiter).map(p => p.trim());
    const selects = document.querySelectorAll('.custom-import-field-select');
    if (selects.length === 0) return;

    const used = new Set();
    for (let idx = 0; idx < Math.min(selects.length, maxCols); idx++) {
        const guess = _guessField(parts[idx] || '', idx, parts.length, used);
        selects[idx].value = guess || '';
        if (guess) used.add(guess);
    }
    onFieldMappingChange();
}

function _guessField(val, colIdx, totalCols, usedFields) {
    const v = val.toLowerCase().trim();

    // auth_token= で始まる
    if (v.startsWith('auth_token=') && !usedFields.has('auth_token')) return 'auth_token';
    // Cookie的な文字列 (key=val; key=val)
    if (/\w+=\w+;\s*\w+=/.test(v) && !usedFields.has('cookies')) return 'cookies';
    // @username や X/Twitter URL
    if ((/^@[a-z0-9_]{1,15}$/i.test(v) || /^https?:\/\/(www\.)?(x|twitter)\.com\/[a-z0-9_]{1,15}(?:[/?#]|$)/i.test(v)) && !usedFields.has('username')) return 'username';
    // メールアドレス
    if (/@/.test(v) && /\.\w{2,}/.test(v) && !usedFields.has('email')) return 'email';
    // 電話番号風 (数字のみ、10-15桁)
    if (/^\+?\d{10,15}$/.test(v.replace(/[-\s]/g, '')) && !usedFields.has('sms')) return 'sms';
    // プロキシ風 (http:// or x.x.x.x:port)
    if ((/^(https?|socks[45]):\/\//.test(v) || /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+/.test(v)) && !usedFields.has('proxy')) return 'proxy';
    // 2FA風 (英数16-32文字のみ, 大文字多め)
    if (/^[A-Z2-7]{16,32}$/i.test(v) && !usedFields.has('2fa')) return '2fa';
    // バックアップコード風 (xxxx-xxxx-xxxx や 8桁英数×複数)
    if (/^[a-z0-9]{4,8}[- ][a-z0-9]{4,8}/i.test(v) && !usedFields.has('backup_code')) return 'backup_code';

    // 位置ベースの推測
    if (colIdx === 0 && !usedFields.has('username')) return 'username';
    if (colIdx === 1 && !usedFields.has('password')) return 'password';
    // 3列目以降: email, auth_token がまだ未割当なら
    if (colIdx === 2) {
        if (/@/.test(v) && !usedFields.has('email')) return 'email';
        if (!usedFields.has('email')) return 'email';
    }
    // 長い英数字列は auth_token の可能性
    if (v.length > 30 && /^[a-f0-9]+$/i.test(v) && !usedFields.has('auth_token')) return 'auth_token';

    return '';
}

async function executeCustomImport() {
    const text = document.getElementById('custom-import-text').value.trim();
    if (!text) {
        showToast('アカウントデータを入力してください', 'error');
        return;
    }
    if (!_customDelimiter) {
        showToast('区切り文字を選択してください', 'error');
        return;
    }

    // マッピング取得
    const mapping = _getCurrentFieldMapping();
    const fieldMapping = [];
    const maxCol = Math.max(...Object.keys(mapping).map(Number), -1);
    for (let i = 0; i <= maxCol; i++) {
        fieldMapping.push(mapping[i] || '');
    }

    if (!fieldMapping.includes('username')) {
        showToast('username 列を指定してください（必須）', 'error');
        return;
    }

    // 重複チェック
    const nonEmpty = fieldMapping.filter(f => f);
    const unique = new Set(nonEmpty);
    if (unique.size !== nonEmpty.length) {
        showToast('同じフィールドが複数列に指定されています', 'error');
        return;
    }

    const expandedLines = _expandCustomLines(text, _customDelimiter, _customSpaceSeparator);
    const lineCount = expandedLines.length;
    const resultEl = document.getElementById('custom-import-result');
    showProcessing('カスタムインポート中...', `${lineCount}アカウントを処理しています`);

    try {
        const res = await apiPost('/api/accounts/custom-import', {
            text,
            delimiter: _customDelimiter,
            field_mapping: fieldMapping,
            space_separator: _customSpaceSeparator,
        });
        hideProcessing();
        showToast(res.message, 'success');
        resultEl.style.color = 'var(--success)';
        let msg = `✅ ${res.imported}件インポート`;
        if (res.skipped > 0) msg += ` / ${res.skipped}件スキップ`;
        if (res.errors && res.errors.length > 0) {
            msg += ` / ⚠ ${res.errors.length}件エラー`;
        }
        resultEl.textContent = msg;
        if (res.imported > 0) {
            document.getElementById('custom-import-text').value = '';
            document.getElementById('custom-import-preview').style.display = 'none';
            refreshAccounts();
        }
    } catch (e) {
        updateProcessing('インポート失敗', e.message, 100);
        _markProcessingError();
        setTimeout(() => hideProcessing(), 2000);
        showToast('インポート失敗: ' + e.message, 'error');
        resultEl.textContent = '❌ ' + e.message;
        resultEl.style.color = 'var(--danger)';
    }
}

// ============================================
// 一括パスワード変更
// ============================================
function toggleBulkPassword() {
    const area = document.getElementById('bulk-password-area');
    area.style.display = area.style.display === 'none' ? 'block' : 'none';
}

async function executeBulkPassword() {
    const pw = document.getElementById('bulk-password-value').value;
    if (!pw) { showToast('パスワードを入力してください', 'error'); return; }

    const selected = getSelectedAccounts();
    const targetLabel = selected.length > 0 ? `選択した ${selected.length} アカウント` : '全アカウント';
    if (!confirm(`${targetLabel} のパスワードを変更しますか？\n\n※ ローカル保存(Excel)のみ変更されます。X側のパスワードは変わりません。`)) return;

    const resultEl = document.getElementById('bulk-password-result');
    try {
        const body = { password: pw };
        if (selected.length > 0) body.usernames = selected;
        const res = await apiPost('/api/accounts/bulk-password', body);
        showToast(res.message, 'success');
        resultEl.textContent = `✅ ${res.updated}件のパスワードを更新しました`;
        resultEl.style.color = 'var(--success)';
        document.getElementById('bulk-password-value').value = '';
    } catch (e) {
        showToast('パスワード変更失敗: ' + e.message, 'error');
        resultEl.textContent = '❌ ' + e.message;
        resultEl.style.color = 'var(--danger)';
    }
}

async function executeChangePasswordOnX() {
    const pw = document.getElementById('bulk-password-value').value;
    if (!pw) { showToast('パスワードを入力してください', 'error'); return; }
    if (pw.length < 8) { showToast('パスワードは8文字以上にしてください', 'error'); return; }

    const selected = getSelectedAccounts();
    const targetLabel = selected.length > 0 ? `選択した ${selected.length} アカウント` : '全ログイン済みアカウント';
    if (!confirm(`${targetLabel} のX側パスワードを変更しますか？\n\n実際にXの設定画面を操作してパスワードを変更します。\nログイン済みかつ現在のパスワードが保存されているアカウントのみ対象です。`)) return;

    const resultEl = document.getElementById('bulk-password-result');
    try {
        const body = { new_password: pw };
        if (selected.length > 0) body.usernames = selected;
        const res = await apiPost('/api/accounts/change-password', body);
        const total = res.total || 0;
        showProcessing('パスワード変更中...', `0 / ${total}`);
        _pollPasswordChangeTask(res.task_id, total);
    } catch (e) {
        showToast('パスワード変更開始失敗: ' + e.message, 'error');
        resultEl.textContent = '❌ ' + e.message;
        resultEl.style.color = 'var(--danger)';
    }
}

async function _pollPasswordChangeTask(taskId, total) {
    const poll = async () => {
        try {
            const task = await apiGet(`/api/tasks/${taskId}`);
            const pct = total > 0 ? (task.progress / total) * 100 : 0;
            const lastResult = task.results?.length > 0 ? task.results[task.results.length - 1] : null;
            const lastMsg = lastResult ? `@${lastResult.username}: ${lastResult.message || ''}` : '';

            updateProcessing(`パスワード変更中... (${task.progress} / ${total})`, lastMsg, pct);

            if (task.status === 'completed' || task.status === 'failed') {
                const results = task.results || [];
                const successCount = results.filter(r => r.success).length;
                const failCount = results.filter(r => !r.success).length;

                if (task.status === 'failed' || failCount > 0) {
                    updateProcessing('パスワード変更完了（一部失敗）', '', 100);
                    if (failCount > 0 && successCount === 0) _markProcessingError();
                } else {
                    updateProcessing('パスワード変更完了', '', 100);
                }

                const resultEl = document.getElementById('bulk-password-result');
                setTimeout(() => {
                    hideProcessing();
                    if (successCount > 0 && failCount === 0) {
                        showToast(`${successCount}アカウントのパスワードを変更しました`, 'success');
                        resultEl.textContent = `✅ ${successCount}件成功`;
                        resultEl.style.color = 'var(--success)';
                        document.getElementById('bulk-password-value').value = '';
                    } else if (successCount > 0) {
                        showToast(`${successCount}件成功 / ${failCount}件失敗`, 'warning');
                        resultEl.textContent = `⚠ ${successCount}件成功 / ${failCount}件失敗`;
                        resultEl.style.color = 'var(--warning)';
                    } else {
                        showToast(`全${failCount}件失敗`, 'error');
                        resultEl.textContent = `❌ 全${failCount}件失敗`;
                        resultEl.style.color = 'var(--danger)';
                    }
                    // 失敗詳細をログ
                    results.filter(r => !r.success).forEach(r => {
                        console.warn(`PW変更失敗 @${r.username}: ${r.message}`);
                    });
                }, 1000);
                return;
            }
            setTimeout(poll, 3000);
        } catch (e) {
            hideProcessing();
            showToast('タスク監視エラー: ' + e.message, 'error');
        }
    };
    setTimeout(poll, 3000);
}

// ============================================
// アカウント詳細モーダル
// ============================================
async function showAccountDetail(username) {
    const modal = document.getElementById('account-detail-modal');
    const titleEl = document.getElementById('detail-modal-title');
    const bodyEl = document.getElementById('detail-modal-body');
    titleEl.textContent = `@${username} の詳細`;
    bodyEl.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px;">読み込み中...</p>';
    modal.classList.add('active');

    try {
        const d = await apiGet(`/api/accounts/${encodeURIComponent(username)}/detail`);
        const meta = _accountMetadata[username] || {};
        const profile = meta.profile || {};
        const sb = meta.shadowban || {};

        const fields = [
            { label: 'ユーザー名',     value: d.username,      copy: true },
            { label: 'パスワード',     value: d.password,      copy: true, sensitive: true },
            { label: 'メールアドレス', value: d.email,         copy: true },
            { label: 'Auth Token',     value: d.auth_token,    copy: true, sensitive: true },
            { label: 'Cookie',         value: d.cookies,       copy: true, sensitive: true, long: true },
            { label: 'プロキシ',       value: d.proxy,         copy: true },
            { label: 'ログイン方式',   value: d.login_method },
            { label: 'ステータス',     value: d.status },
            { label: '最終ログイン',   value: d.last_login },
            { label: 'メモ',           value: d.notes },
            { label: 'インポートグループ', value: d.import_group },
        ];

        // プロフィール統計
        const year = _parseCreatedYear(profile.created_at);
        const statsItems = [];
        if (year) statsItems.push(`${year}年作成`);
        if (profile.statuses_count != null) statsItems.push(`${_formatNumber(profile.statuses_count)} 投稿`);
        if (profile.followers_count != null) statsItems.push(`${_formatNumber(profile.followers_count)} フォロワー`);
        if (profile.following_count != null) statsItems.push(`${_formatNumber(profile.following_count)} フォロー`);

        const sbFlags = _shadowbanBadgeList(sb, false);

        let html = '<div style="display:flex;flex-direction:column;gap:2px;">';

        // フィールド一覧
        fields.forEach(f => {
            if (!f.value && f.value !== 0) {
                html += `<div style="display:flex;align-items:flex-start;padding:6px 0;border-bottom:1px solid var(--border);">
                    <span style="min-width:130px;font-size:12px;color:var(--text-muted);flex-shrink:0;">${f.label}</span>
                    <span style="font-size:12px;color:var(--text-muted);">-</span>
                </div>`;
                return;
            }
            const displayVal = f.sensitive
                ? `<span class="detail-sensitive" data-value="${_esc(f.value)}" style="font-family:monospace;font-size:12px;cursor:pointer;color:var(--text-muted);" onclick="this.textContent = this.dataset.value; this.style.color='var(--text)'" title="クリックで表示">${'●'.repeat(Math.min(f.value.length, 16))}</span>`
                : `<span style="font-size:12px;word-break:break-all;${f.long ? 'max-height:60px;overflow:auto;display:block;' : ''}">${_esc(f.value)}</span>`;
            const copyBtn = f.copy && f.value
                ? `<button class="copy-id-btn" onclick="event.stopPropagation();copyToClipboard('${_esc(f.value).replace(/'/g, "\\'")}',this)" title="コピー" style="margin-left:auto;flex-shrink:0;">コピー</button>`
                : '';
            html += `<div style="display:flex;align-items:flex-start;padding:6px 0;border-bottom:1px solid var(--border);gap:8px;">
                <span style="min-width:130px;font-size:12px;color:var(--text-muted);flex-shrink:0;">${f.label}</span>
                <div style="flex:1;min-width:0;">${displayVal}</div>
                ${copyBtn}
            </div>`;
        });

        // 統計
        if (statsItems.length > 0) {
            html += `<div style="padding:8px 0;border-bottom:1px solid var(--border);">
                <span style="font-size:12px;color:var(--text-muted);">プロフィール統計: </span>
                <span style="font-size:12px;">${statsItems.join(' / ')}</span>
            </div>`;
        }

        // シャドウバン
        if (meta.checked_at) {
            const checkedAt = meta.checked_at.replace('T',' ').substring(0,16);
            html += `<div style="padding:8px 0;border-bottom:1px solid var(--border);">
                <span style="font-size:12px;color:var(--text-muted);">シャドウバン (${checkedAt}): </span>
                ${sbFlags.length === 0 ? '<span class="badge badge-active" style="font-size:10px;">未チェック</span>' : sbFlags.join(' ')}
            </div>`;
        }

        // 編集状況
        html += `<div style="padding:8px 0;">
            <span style="font-size:12px;color:var(--text-muted);">設定状況: </span>
            ${d.edited_icon ? '<span class="badge badge-active" style="font-size:9px;">アイコン</span> ' : ''}
            ${d.edited_name ? '<span class="badge badge-active" style="font-size:9px;">ネーム</span> ' : ''}
            ${d.edited_bio ? '<span class="badge badge-active" style="font-size:9px;">プロフ</span> ' : ''}
            ${!d.edited_icon && !d.edited_name && !d.edited_bio ? '<span class="badge badge-warning" style="font-size:10px;">未設定</span>' : ''}
        </div>`;

        html += '</div>';

        // 全コピーボタン — データを data 属性に退避
        const allText = fields.filter(f => f.value).map(f => `${f.label}: ${f.value}`).join('\n');
        html += `<div style="margin-top:12px;display:flex;gap:8px;">
            <button class="btn btn-sm btn-outline" id="detail-copy-all-btn">全情報をコピー</button>
            <button class="btn btn-sm btn-outline" onclick="closeModal('account-detail-modal')">閉じる</button>
        </div>`;

        bodyEl.innerHTML = html;
        // イベントをJSで付与（テンプレートリテラルのエスケープ問題回避）
        const copyAllBtn = document.getElementById('detail-copy-all-btn');
        if (copyAllBtn) {
            copyAllBtn._copyText = allText;
            copyAllBtn.onclick = function() { copyToClipboard(this._copyText, this); };
        }
        return; // bodyEl.innerHTML は上で設定済み
    } catch (e) {
        bodyEl.innerHTML = `<p style="color:var(--danger);text-align:center;padding:20px;">読み込み失敗: ${e.message}</p>`;
    }
}

async function deleteAccount(username) {
    if (!confirm(`@${username} を削除しますか？`)) return;
    try {
        await apiDelete(`/api/accounts/${username}`);
        showToast(`@${username} を削除しました`, 'success');
        refreshAccounts();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function loginAccount(username) {
    try {
        showToast(`@${username} にログイン中...`, 'info');
        const result = await apiPost(`/api/accounts/${username}/login`, {});
        if (result.success) {
            showToast(`@${username}: ${result.message}`, 'success');
        } else {
            showToast(`@${username}: ${result.message}`, 'error');
        }
        refreshAccounts();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function openInBrowser(username) {
    try {
        showToast(`@${username} をブラウザで開いています...`, 'info');
        const result = await apiPost(`/api/accounts/${username}/open`, {});
        showToast(result.message || `@${username} を開きました`, 'success');
    } catch (e) {
        showToast('ブラウザ起動失敗: ' + e.message, 'error');
    }
}

async function loginAll() {
    if (!confirm('全アカウントの一括ログインを開始しますか？')) return;
    try {
        const accounts = await apiGet('/api/accounts');
        const result = await apiPost('/api/accounts/login-all', {});
        showProcessing('一括ログイン中...', `0 / ${accounts.length} アカウント`);
        _pollLoginTask(result.task_id, accounts.length);
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function loginSelected() {
    const selected = getSelectedAccounts();
    if (selected.length === 0) {
        showToast('ログインするアカウントをチェックしてください', 'error');
        return;
    }
    if (!confirm(`選択した ${selected.length} アカウントの一括ログインを開始しますか？`)) return;
    try {
        const result = await apiPost('/api/accounts/login-all', { usernames: selected });
        showProcessing('選択アカウント ログイン中...', `0 / ${selected.length} アカウント`);
        _pollLoginTask(result.task_id, selected.length);
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function _pollLoginTask(taskId, total) {
    const poll = async () => {
        try {
            const task = await apiGet(`/api/tasks/${taskId}`);
            const pct = total > 0 ? (task.progress / total) * 100 : 0;
            const lastResult = task.results?.length > 0 ? task.results[task.results.length - 1] : null;
            const lastMsg = lastResult ? `@${lastResult.username}: ${lastResult.message || (lastResult.success ? '成功' : '失敗')}` : '';

            updateProcessing(
                `ログイン中... (${task.progress} / ${total})`,
                lastMsg,
                pct
            );

            if (task.status === 'completed' || task.status === 'failed') {
                const successCount = (task.results || []).filter(r => r.success).length;
                const failCount = (task.results || []).length - successCount;
                if (failCount > 0 || task.status === 'failed') {
                    updateProcessing(
                        'ログイン完了 (一部失敗)',
                        `成功: ${successCount}件 / 失敗: ${failCount}件`,
                        100
                    );
                    _markProcessingError();
                } else {
                    updateProcessing(
                        'ログイン完了',
                        `全${successCount}件 成功`,
                        100
                    );
                }
                setTimeout(() => {
                    hideProcessing();
                    refreshAccounts();
                    if (failCount > 0) {
                        showToast(`ログイン完了 — 成功: ${successCount}, 失敗: ${failCount}`, 'error');
                    } else {
                        showToast(`全${successCount}アカウントのログインに成功しました`, 'success');
                    }
                }, 1500);
                return;
            }
            setTimeout(poll, 2000);
        } catch (e) {
            hideProcessing();
            showToast('タスク監視エラー: ' + e.message, 'error');
        }
    };
    setTimeout(poll, 2000);
}

// ============================================
// シャドウバンチェック
// ============================================
async function loadShadowbanProxyOptions() {
    const select = document.getElementById('shadowban-checker-proxy-select');
    if (!select) return;
    try {
        const data = await apiGet('/api/proxy/list');
        const proxies = (data.proxies || []).map(p => ({
            url: p.proxy,
            label: p.display_name ? `${p.display_name} (${p.proxy})` : p.proxy,
            accountCount: p.account_count || 0,
        }));
        _shadowbanProxyCache = proxies;
        const current = select.value;
        select.innerHTML = `<option value="">Proxyなし</option>` + proxies.map(proxy =>
            `<option value="${_escHtml(proxy.url)}">${_escHtml(proxy.label)}</option>`
        ).join('');
        select.value = current || '';
    } catch (e) {
        showToast('Proxy読込失敗: ' + e.message, 'error');
    }
}

async function loadShadowbanCheckerAccounts() {
    const list = document.getElementById('shadowban-checker-list');
    const summary = document.getElementById('shadowban-checker-summary');
    if (!list || !summary) return;
    list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">検索用アカウントを読み込み中...</div>';
    try {
        const data = await apiGet('/api/accounts/shadowban-search-accounts');
        const rows = data.accounts || [];
        summary.textContent = `${data.enabled_count || 0} / ${data.total_count || 0} 有効`;
        if (rows.length === 0) {
            list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">まだ登録されていません</div>';
            return;
        }
        list.innerHTML = rows.map(row => {
            const accountId = row.id || '';
            const status = row.last_status || 'untested';
            const statusColor = (
                status === 'ready' ? 'var(--success)'
                    : status === 'banned' || status === 'invalid_auth' ? 'var(--danger)'
                    : status === 'restricted' ? 'var(--warning)'
                    : 'var(--text-muted)'
            );
            const checked = row.last_checked_at
                ? new Date(row.last_checked_at).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
                : '-';
            return `
                <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:10px 4px;border-bottom:1px solid rgba(255,255,255,0.05);">
                    <div style="min-width:0;flex:1;">
                        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                            <strong>${_escHtml(row.label || '検索用アカウント')}</strong>
                            <span class="badge ${row.enabled ? 'badge-active' : 'badge-unknown'}" style="font-size:10px;">${row.enabled ? '有効' : '無効'}</span>
                            <span style="font-size:11px;color:${statusColor};">状態: ${_escHtml(status)}</span>
                        </div>
                        <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">Token: ${_escHtml(row.auth_token_masked || '-')}</div>
                        <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">Proxy: ${_escHtml(row.proxy || 'なし')}</div>
                        <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">最終確認: ${_escHtml(checked)}</div>
                        ${row.last_error ? `<div style="font-size:11px;color:var(--danger);margin-top:2px;">${_escHtml(row.last_error)}</div>` : ''}
                        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:8px;">
                            <input
                                type="password"
                                id="shadowban-checker-token-${_escHtml(accountId)}"
                                placeholder="新しいAuthToken"
                                autocomplete="off"
                                style="max-width:220px;font-size:12px;padding:6px 8px;"
                            >
                            <button class="btn btn-sm btn-outline" onclick="updateShadowbanCheckerAuthToken('${_escHtml(accountId)}')">Token更新</button>
                        </div>
                    </div>
                    <div style="display:flex;gap:6px;flex-wrap:wrap;">
                        <button class="btn btn-sm btn-outline" onclick="toggleShadowbanCheckerAccount('${_escHtml(accountId)}', ${row.enabled ? 'false' : 'true'})">${row.enabled ? '無効化' : '有効化'}</button>
                        <button class="btn btn-sm btn-danger" onclick="deleteShadowbanCheckerAccount('${_escHtml(accountId)}')">削除</button>
                    </div>
                </div>
            `;
        }).join('');
    } catch (e) {
        list.innerHTML = `<div style="color:var(--danger);font-size:12px;">読込失敗: ${_escHtml(e.message)}</div>`;
    }
}

async function saveShadowbanCheckerAccount() {
    const authToken = (document.getElementById('shadowban-checker-auth-token')?.value || '').trim();
    if (!authToken) {
        showToast('Auth Token を入力してください', 'error');
        return;
    }
    try {
        await apiPost('/api/accounts/shadowban-search-accounts', {
            label: document.getElementById('shadowban-checker-label')?.value || '',
            auth_token: authToken,
            proxy: document.getElementById('shadowban-checker-proxy-select')?.value || '',
            enabled: !!document.getElementById('shadowban-checker-enabled')?.checked,
        });
        document.getElementById('shadowban-checker-label').value = '';
        document.getElementById('shadowban-checker-auth-token').value = '';
        document.getElementById('shadowban-checker-proxy-select').value = '';
        document.getElementById('shadowban-checker-enabled').checked = true;
        await loadShadowbanCheckerAccounts();
        showToast('検索用アカウントを保存しました', 'success');
    } catch (e) {
        showToast('検索用アカウント保存失敗: ' + e.message, 'error');
    }
}

async function updateShadowbanCheckerAuthToken(accountId) {
    const input = document.getElementById(`shadowban-checker-token-${accountId}`);
    const authToken = (input?.value || '').trim();
    if (!authToken) {
        showToast('新しいAuthTokenを入力してください', 'error');
        return;
    }
    if (!confirm('この検索用アカウントのAuthTokenを入れ替えますか？')) return;
    try {
        await apiPut(`/api/accounts/shadowban-search-accounts/${encodeURIComponent(accountId)}`, {
            auth_token: authToken,
        });
        if (input) input.value = '';
        await loadShadowbanCheckerAccounts();
        showToast('AuthTokenを入れ替えました。次回チェック時に再検証されます', 'success');
    } catch (e) {
        showToast('AuthToken更新失敗: ' + e.message, 'error');
    }
}

async function toggleShadowbanCheckerAccount(accountId, enabled) {
    try {
        await apiPut(`/api/accounts/shadowban-search-accounts/${encodeURIComponent(accountId)}`, {
            enabled,
        });
        await loadShadowbanCheckerAccounts();
        showToast(`検索用アカウントを${enabled ? '有効化' : '無効化'}しました`, 'success');
    } catch (e) {
        showToast('更新失敗: ' + e.message, 'error');
    }
}

async function deleteShadowbanCheckerAccount(accountId) {
    if (!confirm('この検索用アカウントを削除しますか？')) return;
    try {
        await apiDelete(`/api/accounts/shadowban-search-accounts/${encodeURIComponent(accountId)}`);
        await loadShadowbanCheckerAccounts();
        showToast('検索用アカウントを削除しました', 'success');
    } catch (e) {
        showToast('削除失敗: ' + e.message, 'error');
    }
}

async function shadowbanCheckSelected() {
    const processingKey = 'shadowban-check';
    let selected = getSelectedAccounts();
    if (selected.length === 0) {
        // 未選択なら全アカウント
        if (!confirm('チェックボックス未選択のため、全アカウントのシャドウバンチェックを実行します。よろしいですか？')) return;
        selected = [];
    } else {
        if (!confirm(`選択した ${selected.length} アカウントのシャドウバンチェックを開始しますか？`)) return;
    }

    const total = selected.length || (_allAccountsCache ? _allAccountsCache.length : 0);
    showProcessing('シャドウバンチェック中...', `0 / ${total} アカウント`, 0, processingKey);

    try {
        const checkerData = await apiGet('/api/accounts/shadowban-search-accounts');
        if (!checkerData.enabled_count) {
            hideProcessing(processingKey);
            showToast('先に有効なシャドウバン検索用アカウントを登録してください', 'error');
            return;
        }
        const body = { method: document.getElementById('shadowban-check-method')?.value || 'browser' };
        if (selected.length > 0) body.usernames = selected;
        const result = await apiPost('/api/accounts/shadowban-check', body);
        _pollShadowbanTask(result.task_id, total, { processingKey });
    } catch (e) {
        hideProcessing(processingKey);
        showToast('シャドウバンチェック開始失敗: ' + e.message, 'error');
    }
}

const _shadowbanTaskPolls = new Set();

async function _pollShadowbanTask(taskId, total, options = {}) {
    if (!taskId || _shadowbanTaskPolls.has(taskId)) return;
    _shadowbanTaskPolls.add(taskId);
    const processingKey = options.processingKey || 'shadowban-check';
    const allResults = [];
    const poll = async () => {
        try {
            const task = await apiGet(`/api/tasks/${taskId}`);
            const taskTotal = task.total || total || 0;
            const pct = taskTotal > 0 ? (task.progress / taskTotal) * 100 : 0;
            const lastResult = task.results?.length > 0 ? task.results[task.results.length - 1] : null;

            // 新しい結果を蓄積
            while (allResults.length < (task.results || []).length) {
                allResults.push(task.results[allResults.length]);
            }

            const lastMsg = lastResult ? `@${lastResult.username} ${lastResult.search_status || ''}` : '';
            const allTaskResults = task.results || [];
            const unavailableCount = allTaskResults.filter(r =>
                r?.checker_status === 'unavailable' ||
                r?.search_status === '未実行' ||
                String(r?.error || '').startsWith('取得未実行')
            ).length;
            const allUnavailable = taskTotal > 0 && unavailableCount >= taskTotal;
            updateProcessing(
                `シャドウバンチェック中... (${task.progress} / ${taskTotal})`,
                lastMsg,
                pct,
                processingKey
            );

            if (task.status === 'completed' || task.status === 'failed') {
                if (task.status === 'failed' || allUnavailable) {
                    const errorMsg = allUnavailable
                        ? '検索用アカウントが利用できず、全件未実行でした'
                        : ((task.errors || [])[0] || '');
                    updateProcessing('シャドウバンチェック失敗', errorMsg, 100, processingKey);
                    _markProcessingError(processingKey);
                } else {
                    updateProcessing('シャドウバンチェック完了', '', 100, processingKey);
                }
                const closeDelay = (task.status === 'failed' || allUnavailable) ? 5000 : 1200;
                setTimeout(async () => {
                    hideProcessing(processingKey);
                    _renderShadowbanResults(allResults);
                    if (task.status === 'failed' || allUnavailable) {
                        showToast('シャドウバンチェック未実行: 検索用アカウントを確認してください', 'error');
                    } else {
                        showToast(`${allResults.length}アカウントのシャドウバンチェック完了`, 'success');
                    }
                    // メタデータを再読み込みしてアカウントテーブルに反映
                    try {
                        _accountMetadata = await apiGet('/api/accounts/metadata');
                        _renderAccountTable(_allAccountsCache || []);
                    } catch (_) {}
                    try {
                        if (document.getElementById('page-dashboard')?.classList.contains('active') && typeof loadDashboard === 'function') {
                            await loadDashboard();
                        }
                    } catch (_) {}
                    await loadShadowbanCheckerAccounts();
                }, closeDelay);
                _shadowbanTaskPolls.delete(taskId);
                return;
            }
            setTimeout(poll, 2000);
        } catch (e) {
            _shadowbanTaskPolls.delete(taskId);
            hideProcessing(processingKey);
            showToast('タスク監視エラー: ' + e.message, 'error');
        }
    };
    setTimeout(poll, options.restored ? 250 : 2000);
}

let _restoreRunningShadowbanInFlight = false;
let _restoreRunningShadowbanSchedulerInFlight = false;
let _shadowbanSchedulerRunningSince = '';

function _formatShadowbanSchedulerTime(iso) {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleString('ja-JP', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch (_) {
        return iso;
    }
}

function _formatShadowbanSchedulerElapsed(iso) {
    if (!iso) return '';
    try {
        const diffMin = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
        if (diffMin < 60) return `${diffMin}分経過`;
        const hours = Math.floor(diffMin / 60);
        const mins = diffMin % 60;
        return `${hours}時間${mins}分経過`;
    } catch (_) {
        return '';
    }
}

function _shadowbanSchedulerSubtitle(scheduler) {
    const current = scheduler.current_run || {};
    const startedAt = current.started_at || scheduler.running_since || '';
    const progress = Number(current.progress || 0);
    const total = Number(current.accounts_total || scheduler.last_result?.accounts_total || 0);
    const scannedTotal = Number(current.accounts_scanned_total || scheduler.last_result?.accounts_scanned_total || 0);
    const policySkipped = Number(current.policy_skipped_count || scheduler.last_result?.policy_skipped_count || 0);
    const checkerCount = Number(current.checker_count || 0);
    const parts = [];

    if (startedAt) {
        const startedLabel = _formatShadowbanSchedulerTime(startedAt);
        const elapsed = _formatShadowbanSchedulerElapsed(startedAt);
        parts.push(elapsed ? `${startedLabel}開始 (${elapsed})` : `${startedLabel}開始`);
    }
    if (total > 0) {
        parts.push(progress > 0 ? `${progress} / ${total} 件` : `${total} 件対象`);
    }
    if (policySkipped > 0) {
        parts.push(scannedTotal > 0 ? `条件除外 ${policySkipped} / ${scannedTotal} 件` : `条件除外 ${policySkipped} 件`);
    }
    if (checkerCount > 0) parts.push(`検索用 ${checkerCount} 件`);
    if (current.last_username) {
        parts.push(`@${current.last_username} ${current.last_status || ''}`.trim());
    }
    return parts.join(' / ') || '日次チェックを実行中';
}

async function restoreRunningShadowbanSchedulerNotification() {
    if (_restoreRunningShadowbanSchedulerInFlight) return;
    _restoreRunningShadowbanSchedulerInFlight = true;
    const processingKey = 'shadowban-scheduled-check';
    try {
        const scheduler = await apiGet('/api/ops/shadowban/scheduler-status');
        if (!scheduler.running) {
            if (_shadowbanSchedulerRunningSince) {
                hideProcessing(processingKey);
                _shadowbanSchedulerRunningSince = '';
            }
            return;
        }

        const current = scheduler.current_run || {};
        const startedAt = current.started_at || scheduler.running_since || 'running';
        const total = Number(current.accounts_total || scheduler.last_result?.accounts_total || 0);
        const progress = Number(current.progress || 0);
        const pct = total > 0 && progress > 0 ? (progress / total) * 100 : 3;
        const subtitle = _shadowbanSchedulerSubtitle(scheduler);

        showProcessing('日次シャドウバンチェック中', subtitle, pct, processingKey);
        updateProcessing('日次シャドウバンチェック中', subtitle, pct, processingKey);
        if (_shadowbanSchedulerRunningSince !== startedAt) {
            showToast('日次シャドウバンチェック実行中を復元しました', 'info');
        }
        _shadowbanSchedulerRunningSince = startedAt;
    } catch (_) {
        // スケジューラ通知は補助表示なので、取得失敗時は通常操作を止めない
    } finally {
        _restoreRunningShadowbanSchedulerInFlight = false;
    }
}

async function restoreRunningShadowbanTaskNotification() {
    if (_restoreRunningShadowbanInFlight) return;
    _restoreRunningShadowbanInFlight = true;
    try {
        const tasks = await apiGet('/api/tasks');
        const running = (tasks || [])
            .filter(t => t.action === 'shadowban_check' && t.status === 'running')
            .reverse()
            .find(t => !_shadowbanTaskPolls.has(t.task_id));
        if (!running) return;

        const total = running.total || 0;
        const progress = running.progress || 0;
        const pct = total > 0 ? (progress / total) * 100 : 0;
        const lastResult = running.last_result || (running.results?.length ? running.results[running.results.length - 1] : null);
        const lastMsg = lastResult ? `@${lastResult.username} ${lastResult.search_status || ''}` : `${progress} / ${total} アカウント`;

        const processingKey = 'shadowban-check';
        showProcessing('シャドウバンチェック中...', lastMsg, pct, processingKey);
        updateProcessing(`シャドウバンチェック中... (${progress} / ${total})`, lastMsg, pct, processingKey);
        _pollShadowbanTask(running.task_id, total, { restored: true, processingKey });
        showToast('実行中のシャドウバンチェックを復元しました', 'info');
    } catch (_) {
        // 復元は補助動作なので、失敗しても通常画面操作は止めない
    } finally {
        _restoreRunningShadowbanInFlight = false;
    }
}

function _shadowbanLabel(key) {
    const map = {
        search_ban: '検索制限',
        top_search_ok: '話題のポストOK',
        latest_search_ok: '最新OK',
        search_status: '検索判定',
        search_suggestion_ban: 'Suggestion Ban',
        media_ban: 'Media Ban',
        ghost_ban: 'Ghost Ban',
        reply_deboosting: 'Reply Deboosting',
        suspend: '凍結',
        protect: '鍵アカウント',
        no_tweet: 'ツイートなし',
        not_found: 'アカウント不明',
    };
    return map[key] || key;
}

// ============================================
// プロフィール統計取得
// ============================================
async function _startAccountStatsFetch({ label = '統計取得', targetLabel = 'プロフィール統計' } = {}) {
    let selected = getSelectedAccounts();
    if (selected.length === 0) {
        if (!confirm(`チェックボックス未選択のため、全アカウントの${targetLabel}を取得します。よろしいですか？`)) return;
        selected = [];
    } else {
        if (!confirm(`選択した ${selected.length} アカウントの${targetLabel}を取得しますか？`)) return;
    }

    const total = selected.length || (_allAccountsCache ? _allAccountsCache.length : 0);
    showProcessing(`${label}中...`, `0 / ${total} アカウント`);

    try {
        const body = selected.length > 0 ? { usernames: selected } : {};
        const result = await apiPost('/api/accounts/fetch-stats', body);
        _pollFetchStatsTask(result.task_id, total, label);
    } catch (e) {
        hideProcessing();
        showToast(`${label}開始失敗: ` + e.message, 'error');
    }
}

async function fetchAccountCreatedYears() {
    return _startAccountStatsFetch({
        label: '作成年取得',
        targetLabel: '作成年',
    });
}

async function fetchAccountStats() {
    return _startAccountStatsFetch({
        label: '統計取得',
        targetLabel: 'プロフィール統計',
    });
}

async function _pollFetchStatsTask(taskId, total, label = '統計取得') {
    const poll = async () => {
        try {
            const task = await apiGet(`/api/tasks/${taskId}`);
            const pct = total > 0 ? (task.progress / total) * 100 : 0;
            const lastResult = task.results?.length > 0 ? task.results[task.results.length - 1] : null;
            const lastMsg = lastResult ? `@${lastResult.username}` : '';

            updateProcessing(
                `${label}中... (${task.progress} / ${total})`,
                lastMsg,
                pct
            );

            if (task.status === 'completed' || task.status === 'failed') {
                if (task.status === 'failed') {
                    updateProcessing(`${label}失敗`, '', 100);
                    _markProcessingError();
                } else {
                    updateProcessing(`${label}完了`, '', 100);
                }
                setTimeout(async () => {
                    hideProcessing();
                    showToast(`${label}完了`, task.status === 'failed' ? 'error' : 'success');
                    // メタデータ再読み込みでテーブルに反映
                    try {
                        _accountMetadata = await apiGet('/api/accounts/metadata');
                        _renderAccountTable(_allAccountsCache || []);
                    } catch (_) {}
                }, 1000);
                return;
            }
            setTimeout(poll, 2000);
        } catch (e) {
            hideProcessing();
            showToast('タスク監視エラー: ' + e.message, 'error');
        }
    };
    setTimeout(poll, 2000);
}

let _lastShadowbanResults = [];
let _sbSortKey = 'status';   // 'username' | 'status' | 'followers' | 'checked_at'
let _sbSortAsc = true;

// 前回のシャドウバンチェック結果をメタデータから復元
function loadLastShadowbanResults() {
    const results = [];
    for (const [username, meta] of Object.entries(_accountMetadata)) {
        if (!meta || !meta.shadowban) continue;
        const normalized = _normalizeShadowbanResult({
            username,
            checked_at: meta.checked_at || null,
            ...(meta.profile || {}),
            ...(meta.shadowban || {}),
        });
        results.push(normalized);
    }
    if (results.length === 0) {
        showToast('保存されたシャドウバンチェック結果がありません', 'info');
        return;
    }
    _renderShadowbanResults(results);
    showToast(`前回の結果 (${results.length}件) を表示しました`, 'success');
}

function _normalizeShadowbanResult(raw) {
    const result = { ...raw };
    if (_isSearchShadowbanRecord(result)) {
        result.top_ok = !!result.top_ok || !!result.top_search_ok;
        result.latest_ok = !!result.latest_ok || !!result.latest_search_ok;
        result.top_search_ok = result.top_ok;
        result.latest_search_ok = result.latest_ok;
        result.sensitive_limited = !!result.sensitive_limited || result.search_status === 'センシ限定';
        result.search_status = result.search_status || (
            result.suspend ? '凍結'
                : result.not_found ? 'アカウント不明'
                : result.protect ? '鍵アカウント'
                : result.sensitive_limited ? 'センシ限定'
                : result.top_ok && result.latest_ok ? '検索完全OK'
                : result.top_ok ? '話題のポストOK'
                : result.latest_ok ? '最新OK'
                : '検索表示なし'
        );
        result.search_ban = result.search_ban !== undefined ? !!result.search_ban : !(result.top_ok && result.latest_ok);
        result.proxy = result.proxy || '';
        result.top_attempts = result.top_attempts || 0;
        result.latest_attempts = result.latest_attempts || 0;
        return result;
    }
    return {
        ...result,
        top_ok: false,
        latest_ok: false,
        search_status: result.suspend ? '凍結' : result.not_found ? 'アカウント不明' : (result.search_ban ? '検索制限' : '問題なし'),
        proxy: result.proxy || '',
        top_attempts: result.top_attempts || 0,
        latest_attempts: result.latest_attempts || 0,
    };
}

function _shadowbanSeverityRank(r) {
    if (r.error) return 6;
    if (r.suspend) return 5;
    if (r.not_found) return 4;
    if (r.protect) return 3;
    if (r.sensitive_limited || r.search_status === 'センシ限定') return 1;
    if (r.top_ok && r.latest_ok) return 0;
    if (r.top_ok || r.latest_ok) return 1;
    return 2;
}

function _sbSortResults(results) {
    const sorted = [...results].sort((a, b) => {
        let cmp = 0;
        switch (_sbSortKey) {
            case 'username':
                cmp = (a.username || '').localeCompare(b.username || '');
                break;
            case 'status':
                cmp = _shadowbanSeverityRank(b) - _shadowbanSeverityRank(a);
                break;
            case 'followers':
                cmp = (b.followers_count || 0) - (a.followers_count || 0);
                break;
            case 'checked_at':
                cmp = (a.checked_at || '').localeCompare(b.checked_at || '');
                break;
        }
        return _sbSortAsc ? cmp : -cmp;
    });
    return sorted;
}

function _sbSetSort(key) {
    if (_sbSortKey === key) {
        _sbSortAsc = !_sbSortAsc;
    } else {
        _sbSortKey = key;
        _sbSortAsc = true;
    }
    _renderShadowbanResults(_lastShadowbanResults);
}

function _sbSortIndicator(key) {
    if (_sbSortKey !== key) return '';
    return _sbSortAsc ? ' ▲' : ' ▼';
}

function _renderShadowbanResults(results) {
    const normalized = (results || []).map(_normalizeShadowbanResult);
    _lastShadowbanResults = normalized;
    const container = document.getElementById('shadowban-results');
    const body = document.getElementById('shadowban-results-body');
    container.style.display = 'block';

    if (!normalized || normalized.length === 0) {
        body.innerHTML = '<p style="color:var(--text-muted)">結果がありません</p>';
        return;
    }

    // ソート適用
    const sorted = _sbSortResults(normalized);

    // チェック日時を取得(最新のもの)
    const checkedDates = normalized.map(r => r.checked_at).filter(Boolean);
    const latestCheck = checkedDates.length > 0
        ? checkedDates.sort().reverse()[0]
        : null;

    let fullOkCount = 0;
    let partialCount = 0;
    let hiddenCount = 0;
    let sensitiveCount = 0;
    let suspendedCount = 0;
    let notFoundCount = 0;
    let cleanCount = 0;
    let errorCount = 0;

    normalized.forEach(r => {
        if (r.error) { errorCount++; return; }
        if (r.suspend) { suspendedCount++; return; }
        if (r.not_found) { notFoundCount++; return; }
        if (r.sensitive_limited || r.search_status === 'センシ限定') { sensitiveCount++; return; }
        if (r.top_ok && r.latest_ok) { fullOkCount++; cleanCount++; return; }
        if (r.top_ok || r.latest_ok) { partialCount++; return; }
        hiddenCount++;
    });

    // 凍結アカウント一覧を収集
    const suspendedUsers = normalized.filter(r => r.suspend).map(r => r.username || r.screen_name);

    let html = '';

    // チェック方式を取得
    const methods = [...new Set(normalized.map(r => r.check_method).filter(Boolean))];
    const methodLabel = methods.length === 1
        ? (methods[0] === 'graphql' ? 'GraphQL/API' : 'Browser')
        : (methods.length > 1 ? methods.join(', ') : '');

    // チェック日時表示
    if (latestCheck) {
        const d = new Date(latestCheck);
        const dateStr = d.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        html += `<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">
            最終チェック: ${dateStr}${methodLabel ? ` <span class="badge badge-info" style="font-size:10px;">${methodLabel}</span>` : ''}
        </div>`;
    }

    html += `<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center;">
        <div title="検索完全OK" aria-label="検索完全OK ${cleanCount}" style="min-width:72px;text-align:center;padding:8px 14px;border-radius:8px;background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.3);">
            <span style="font-size:22px;font-weight:700;color:#34d399;">${cleanCount}</span>
        </div>
        <div title="部分OK" aria-label="部分OK ${partialCount}" style="min-width:72px;text-align:center;padding:8px 14px;border-radius:8px;background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.3);">
            <span style="font-size:22px;font-weight:700;color:#fbbf24;">${partialCount}</span>
        </div>
        <div title="検索表示なし" aria-label="検索表示なし ${hiddenCount}" style="min-width:72px;text-align:center;padding:8px 14px;border-radius:8px;background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);">
            <span style="font-size:22px;font-weight:700;color:#f87171;">${hiddenCount}</span>
        </div>
        ${sensitiveCount > 0 ? `<div title="センシ限定" aria-label="センシ限定 ${sensitiveCount}" style="min-width:72px;text-align:center;padding:8px 14px;border-radius:8px;background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.3);">
            <span style="font-size:22px;font-weight:700;color:#fbbf24;">${sensitiveCount}</span>
        </div>` : ''}
        ${suspendedCount > 0 ? `<div title="凍結" aria-label="凍結 ${suspendedCount}" style="min-width:72px;text-align:center;padding:8px 14px;border-radius:8px;background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);">
            <span style="font-size:22px;font-weight:700;color:#f87171;">${suspendedCount}</span>
        </div>` : ''}
        ${notFoundCount > 0 ? `<div title="アカウント不明" aria-label="アカウント不明 ${notFoundCount}" style="min-width:72px;text-align:center;padding:8px 14px;border-radius:8px;background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);">
            <span style="font-size:22px;font-weight:700;color:#f87171;">${notFoundCount}</span>
        </div>` : ''}
        ${errorCount > 0 ? `<div title="エラー" aria-label="エラー ${errorCount}" style="min-width:72px;text-align:center;padding:8px 14px;border-radius:8px;background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.3);">
            <span style="font-size:22px;font-weight:700;color:#fbbf24;">${errorCount}</span>
        </div>` : ''}
    </div>`;

    // 凍結アカウント検出時のバナー
    if (suspendedUsers.length > 0) {
        html += `<div style="padding:12px 16px;border-radius:8px;background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
            <div>
                <div style="font-weight:600;color:#f87171;font-size:14px;">凍結アカウントが ${suspendedUsers.length} 件検出されました</div>
                <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${suspendedUsers.map(u => '@' + u).join(', ')}</div>
                <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">削除しても行動履歴は「削除済み」タブに保存されます。</div>
            </div>
            <div style="display:flex;gap:8px;">
                <button class="btn btn-danger" onclick="deleteSuspendedAccounts()" style="font-size:13px;padding:8px 16px;white-space:nowrap;">凍結アカウントを一括削除</button>
                <button class="btn btn-outline" onclick="navigateToPage('deleted')" style="font-size:13px;padding:8px 16px;white-space:nowrap;">削除済みタブを見る</button>
            </div>
        </div>`;
    }

    // ソートヘッダー
    const hdrStyle = 'cursor:pointer;user-select:none;font-size:12px;font-weight:600;color:var(--text-muted);padding:6px 10px;border-radius:6px;transition:background .15s;';
    const hdrHover = 'onmouseover="this.style.background=\'rgba(255,255,255,0.05)\'" onmouseout="this.style.background=\'transparent\'"';
    html += `<div style="display:flex;gap:4px;margin-bottom:8px;border-bottom:1px solid var(--border);padding-bottom:8px;">
        <span style="${hdrStyle}min-width:170px;" onclick="_sbSetSort('username')" ${hdrHover}>ユーザー名${_sbSortIndicator('username')}</span>
        <span style="${hdrStyle}flex:1;" onclick="_sbSetSort('status')" ${hdrHover}>ステータス${_sbSortIndicator('status')}</span>
        <span style="${hdrStyle}" onclick="_sbSetSort('followers')" ${hdrHover}>フォロワー${_sbSortIndicator('followers')}</span>
        <span style="${hdrStyle}" onclick="_sbSetSort('checked_at')" ${hdrHover}>チェック日時${_sbSortIndicator('checked_at')}</span>
    </div>`;

    // 各アカウントの結果テーブル
    html += '<div style="display:grid;gap:8px;">';
    sorted.forEach(r => {
        const username = r.username || r.screen_name || '?';
        const flags = _shadowbanBadgeList(r, false);
        if (r.error) {
            flags.unshift(`<span class="badge badge-error" style="font-size:10px;">Error: ${_escHtml(String(r.error).substring(0, 40))}</span>`);
        }
        const isClean = !r.error && r.top_ok && r.latest_ok && !r.suspend && !r.not_found && !r.protect;
        const isSuspended = !!r.suspend;
        const borderColor = r.error ? 'var(--warning)' : isClean ? 'rgba(52,211,153,0.4)' : 'rgba(248,113,113,0.4)';
        const statusIcon = r.error ? '⚠️' : isClean ? '✅' : '🚫';

        // プロフィール統計
        const year = _parseCreatedYear(r.created_at);
        const statsHtml = (r.followers_count != null)
            ? `<div style="font-size:11px;color:var(--text-muted);display:flex;gap:8px;flex-wrap:wrap;">
                ${year ? `<span>${year}年</span>` : ''}
                <span>${_formatNumber(r.statuses_count)}投稿</span>
                <span>${_formatNumber(r.followers_count)}フォロワー</span>
                <span>${_formatNumber(r.following_count)}フォロー</span>
               </div>`
            : '';

        // チェック日時
        let checkedStr = '';
        if (r.checked_at) {
            const cd = new Date(r.checked_at);
            checkedStr = `<div style="font-size:10px;color:var(--text-muted);min-width:80px;text-align:right;">${cd.toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>`;
        }

        const searchLinks = `
            <div style="font-size:11px;color:var(--text-muted);display:flex;gap:8px;flex-wrap:wrap;margin-top:3px;">
                <a href="https://x.com/search?q=${encodeURIComponent(`from:${username}`)}&src=typed_query" target="_blank" rel="noopener noreferrer">話題</a>
                <a href="https://x.com/search?q=${encodeURIComponent(`from:${username}`)}&src=typed_query&f=live" target="_blank" rel="noopener noreferrer">最新</a>
                ${r.checker_label ? `<span>検索用: ${_escHtml(r.checker_label)}</span>` : ''}
                ${r.checker_status ? `<span>状態: ${_escHtml(r.checker_status)}</span>` : ''}
                ${r.proxy ? `<span>Proxy: ${_escHtml(r.proxy)}</span>` : ''}
                ${(r.top_attempts || r.latest_attempts) ? `<span>試行 ${r.top_attempts || 0}/${r.latest_attempts || 0}</span>` : ''}
            </div>
        `;

        const deleteBtn = isSuspended
            ? `<button class="btn btn-danger" onclick="deleteSingleSuspendedAccount('${username}')" style="margin-left:auto;font-size:11px;padding:4px 10px;white-space:nowrap;">🗑️ 削除</button>`
            : '';

        html += `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid ${borderColor};border-radius:8px;flex-wrap:wrap;">
            ${accountAvatarHtml(username, 28)}
            <div style="min-width:140px;">
                <span style="font-weight:600;">@${username}</span>
                ${statsHtml}
                ${searchLinks}
            </div>
            <span style="font-size:16px;">${statusIcon}</span>
            <div style="display:flex;flex-wrap:wrap;gap:4px;flex:1;">
                ${flags.join('')}
            </div>
            ${checkedStr}
            ${deleteBtn}
        </div>`;
    });
    html += '</div>';

    body.innerHTML = html;

    // 結果エリアまでスクロール
    container.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 凍結アカウントを1件削除
async function deleteSingleSuspendedAccount(username) {
    if (!confirm(`@${username} を削除しますか？\n行動履歴は「削除済み」タブに保存されます。`)) return;
    try {
        const resp = await fetch(`${API}/api/accounts/${encodeURIComponent(username)}?reason=suspended`, { method: 'DELETE' });
        if (!resp.ok) throw new Error((await resp.json()).detail || resp.statusText);
        showToast(`@${username} を削除しました（履歴は「削除済み」タブで確認できます）`, 'success');
        _lastShadowbanResults = _lastShadowbanResults.filter(r => (r.username || r.screen_name) !== username);
        _renderShadowbanResults(_lastShadowbanResults);
        refreshAccounts();
    } catch (e) {
        showToast(`削除失敗: ${e.message}`, 'error');
    }
}

// 凍結アカウントを一括削除
async function deleteSuspendedAccounts() {
    const suspended = _lastShadowbanResults.filter(r => r.suspend).map(r => r.username || r.screen_name);
    if (suspended.length === 0) { showToast('凍結アカウントがありません', 'info'); return; }
    if (!confirm(`凍結アカウント ${suspended.length} 件を削除しますか？\n\n${suspended.map(u => '@' + u).join('\n')}\n\n行動履歴は「削除済み」タブに保存されます。`)) return;

    showProcessing('凍結アカウント削除中', `0 / ${suspended.length}`);
    let deleted = 0;
    let errors = [];
    for (let i = 0; i < suspended.length; i++) {
        const username = suspended[i];
        try {
            const resp = await fetch(`${API}/api/accounts/${encodeURIComponent(username)}?reason=suspended`, { method: 'DELETE' });
            if (!resp.ok) throw new Error((await resp.json()).detail || resp.statusText);
            deleted++;
        } catch (e) {
            errors.push(`@${username}: ${e.message}`);
        }
        updateProcessing(undefined, `${i + 1} / ${suspended.length}`, (i + 1) / suspended.length * 100);
    }
    hideProcessing();

    const deletedSet = new Set(suspended.filter(u => !errors.some(e => e.startsWith('@' + u))));
    _lastShadowbanResults = _lastShadowbanResults.filter(r => !deletedSet.has(r.username || r.screen_name));
    _renderShadowbanResults(_lastShadowbanResults);
    refreshAccounts();

    if (errors.length > 0) {
        showToast(`${deleted}件削除、${errors.length}件失敗`, 'warning');
    } else {
        showToast(`凍結アカウント ${deleted} 件を削除しました`, 'success');
        // 削除済みタブへ遷移を促す
        _showGoToDeletedTab(deleted);
    }
}

function _showGoToDeletedTab(count) {
    const container = document.getElementById('shadowban-results-body');
    if (!container) return;
    const existing = container.querySelector('.go-to-deleted-banner');
    if (existing) existing.remove();
    const banner = document.createElement('div');
    banner.className = 'go-to-deleted-banner';
    banner.style.cssText = 'margin-top:12px;padding:12px 16px;border-radius:8px;background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.3);display:flex;align-items:center;justify-content:space-between;';
    banner.innerHTML = `
        <span style="font-size:13px;color:var(--text);">${count}件の凍結アカウントを削除しました。行動履歴は「削除済み」タブで確認できます。</span>
        <button class="btn btn-sm btn-primary" onclick="navigateToPage('deleted')" style="white-space:nowrap;">削除済みタブへ移動</button>
    `;
    container.prepend(banner);
}

function navigateToPage(pageName) {
    activatePage(pageName);
}

function toggleAllAccounts(checkbox) {
    document.querySelectorAll('.account-checkbox').forEach(cb => {
        cb.checked = checkbox.checked;
    });
}

function getSelectedAccounts() {
    return Array.from(document.querySelectorAll('.account-checkbox:checked'))
        .map(cb => cb.value);
}

// ============================================
// アカウント選択リスト
// ============================================
async function refreshAccountCheckboxes(containerId) {
    try {
        const accounts = await apiGet('/api/accounts');
        const visibleAccounts = _accountsForCheckboxList(containerId, accounts);
        _renderCheckboxList(containerId, visibleAccounts);
        // Store for filtering
        const container = document.getElementById(containerId);
        container._allAccounts = visibleAccounts;
    } catch (e) {
        console.error('アカウント読み込み失敗:', e);
    }
}

function _isProfileExcludedAccountStatus(status) {
    const s = String(status || '').trim().toLowerCase();
    return [
        'suspended',
        'account suspended',
        '凍結',
        'locked',
        'account locked',
        'temporarily locked',
        '一時ロック',
        'ロック',
    ].includes(s);
}

function _accountsForCheckboxList(containerId, accounts) {
    const list = Array.isArray(accounts) ? accounts : [];
    if (containerId === 'profile-account-list') {
        return list.filter(a => !_isProfileExcludedAccountStatus(a.status));
    }
    return list;
}

function _buildEditBadgesSmall(a) {
    const badges = [];
    if (a.edited_icon) badges.push('<span class="badge badge-active" style="font-size:9px;padding:1px 4px">&#10003;アイコン</span>');
    if (a.edited_name) badges.push('<span class="badge badge-active" style="font-size:9px;padding:1px 4px">&#10003;ネーム</span>');
    if (a.edited_bio)  badges.push('<span class="badge badge-active" style="font-size:9px;padding:1px 4px">&#10003;プロフ</span>');
    if (badges.length === 0) badges.push('<span class="badge badge-warning" style="font-size:9px;padding:1px 4px">未設定</span>');
    return badges.join(' ');
}

function _renderCheckboxList(containerId, accounts) {
    const container = document.getElementById(containerId);
    container.innerHTML = accounts.map(a => {
        return `<label class="checkbox-item" style="align-items:center" data-has-edit="${_hasAnyEdit(a) ? '1' : '0'}">
            <input type="checkbox" value="${a.username}" class="acct-cb-${containerId}">
            ${accountAvatarHtml(a.username, 28)}
            <span>@${a.username}</span>
            ${_buildEditBadgesSmall(a)}
            <span class="badge ${a.status === 'active' ? 'badge-active' : 'badge-pending'}" style="margin-left:auto;font-size:11px">${a.status}</span>
        </label>`;
    }).join('');
    activateLazyAvatars(container);
}

function filterCheckboxList(containerId, filter) {
    document.querySelectorAll(`.cb-filter-btn[data-target="${containerId}"]`).forEach(b => {
        b.classList.toggle('btn-primary', b.dataset.filter === filter);
        b.classList.toggle('btn-outline', b.dataset.filter !== filter);
    });
    const container = document.getElementById(containerId);
    const accts = container._allAccounts || [];
    const filters = {
        'all':        () => accts,
        'no-icon':    () => accts.filter(a => !a.edited_icon),
        'no-name':    () => accts.filter(a => !a.edited_name),
        'no-bio':     () => accts.filter(a => !a.edited_bio),
        'no-profile': () => accts.filter(a => !_hasAnyEdit(a)),
        'edited':     () => accts.filter(a => _hasAnyEdit(a)),
    };
    _renderCheckboxList(containerId, (filters[filter] || filters['all'])());
}

function getCheckedAccounts(containerId) {
    return Array.from(document.querySelectorAll(`.acct-cb-${containerId}:checked`))
        .map(cb => cb.value);
}

function selectAllCheckboxes(containerId) {
    const cbs = document.querySelectorAll(`.acct-cb-${containerId}`);
    const allChecked = Array.from(cbs).every(cb => cb.checked);
    cbs.forEach(cb => cb.checked = !allChecked);
}

function deselectAllCheckboxes(containerId) {
    document.querySelectorAll(`.acct-cb-${containerId}`).forEach(cb => cb.checked = false);
}

function selectFilteredCheckboxes(containerId) {
    const cbs = document.querySelectorAll(`.acct-cb-${containerId}`);
    const allChecked = Array.from(cbs).every(cb => cb.checked);
    cbs.forEach(cb => cb.checked = !allChecked);
}

// ============================================
// ツイート
// ============================================
let _tweetMediaFiles = [];

function handleTweetMediaSelection(event) {
    const selected = Array.from(event.target.files || []);
    if (selected.length > 4) {
        showToast('画像は最大4枚までです', 'error');
        event.target.value = '';
        _tweetMediaFiles = [];
        renderTweetMediaSelection();
        return;
    }
    _tweetMediaFiles = selected;
    renderTweetMediaSelection();
}

function renderTweetMediaSelection() {
    const el = document.getElementById('tweet-media-selection');
    if (!el) return;
    if (_tweetMediaFiles.length === 0) {
        el.textContent = '画像なし';
        return;
    }
    const totalMb = (_tweetMediaFiles.reduce((sum, f) => sum + (f.size || 0), 0) / 1024 / 1024).toFixed(2);
    el.textContent = `${_tweetMediaFiles.length}枚選択: ${_tweetMediaFiles.map(f => f.name).join(', ')} (${totalMb} MB)`;
}

function clearTweetMediaSelection() {
    _tweetMediaFiles = [];
    const input = document.getElementById('tweet-media-files');
    if (input) input.value = '';
    renderTweetMediaSelection();
}

async function uploadTweetMediaFiles() {
    if (_tweetMediaFiles.length === 0) return [];
    if (_tweetMediaFiles.length > 4) {
        throw new Error('画像は最大4枚までです');
    }

    const formData = new FormData();
    _tweetMediaFiles.forEach(file => formData.append('files', file));

    const res = await fetch(API + '/api/tweets/media/upload', {
        method: 'POST',
        body: formData,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || res.statusText);
    }
    const data = await res.json();
    return data.media_paths || [];
}

async function postTweet() {
    const text = document.getElementById('tweet-text').value.trim();
    const accountIds = getCheckedAccounts('tweet-account-list');
    if (!text) { showToast('ツイート内容を入力してください', 'error'); return; }
    if (accountIds.length === 0) { showToast('アカウントを選択してください', 'error'); return; }

    try {
        const mediaPaths = await uploadTweetMediaFiles();
        const result = await apiPost('/api/tweets/post', {
            account_ids: accountIds,
            text: text,
            media_paths: mediaPaths,
        });
        watchTask(result.task_id, 'ツイート投稿');
        document.getElementById('tweet-text').value = '';
        clearTweetMediaSelection();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function scheduleTweet() {
    const text = document.getElementById('tweet-text').value.trim();
    const scheduledAt = document.getElementById('tweet-schedule').value;
    const accountIds = getCheckedAccounts('tweet-account-list');
    if (!text) { showToast('ツイート内容を入力してください', 'error'); return; }
    if (!scheduledAt) { showToast('予約日時を指定してください', 'error'); return; }
    if (accountIds.length === 0) { showToast('アカウントを選択してください', 'error'); return; }

    try {
        const mediaPaths = await uploadTweetMediaFiles();
        const result = await apiPost('/api/tweets/schedule', {
            account_ids: accountIds,
            text: text,
            scheduled_at: scheduledAt,
            media_paths: mediaPaths,
        });
        showToast(`ツイートを予約しました (${result.job_id})`, 'success');
        document.getElementById('tweet-text').value = '';
        document.getElementById('tweet-schedule').value = '';
        clearTweetMediaSelection();
        loadScheduledTweets();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function loadScheduledTweets() {
    try {
        const jobs = await apiGet('/api/tweets/scheduled');
        const container = document.getElementById('scheduled-tweets-list');
        if (jobs.length === 0) {
            container.innerHTML = '<p style="color:var(--text-muted)">予約ツイートはありません</p>';
            return;
        }
        container.innerHTML = jobs.map(j =>
            `<div style="padding:10px 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
                <div>
                    <div style="font-size:14px">${j.text.substring(0, 60)}${j.text.length > 60 ? '...' : ''}</div>
                    <div style="font-size:12px;color:var(--text-muted)">${j.scheduled_at} | ${j.account_ids.length}件 | 画像${(j.media_paths || []).length}枚 | <span class="badge badge-${j.status === 'scheduled' ? 'pending' : j.status === 'executed' ? 'active' : 'error'}">${statusLabel(j.status)}</span></div>
                </div>
                ${j.status === 'scheduled' ? `<button class="btn btn-sm btn-danger" onclick="cancelScheduledTweet('${j.job_id}')">キャンセル</button>` : ''}
            </div>`
        ).join('');
    } catch (e) {
        console.error('予約ツイート読み込み失敗:', e);
    }
}

async function cancelScheduledTweet(jobId) {
    try {
        await apiDelete(`/api/tweets/scheduled/${jobId}`);
        showToast('予約をキャンセルしました', 'success');
        loadScheduledTweets();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// ============================================
// プロフィール
// ============================================
function switchProfileTab(name) {
    document.querySelectorAll('.prof-tab').forEach(el => el.style.display = 'none');
    document.querySelectorAll('[data-prof-tab]').forEach(b => {
        b.classList.toggle('btn-primary', b.dataset.profTab === name);
        b.classList.toggle('btn-outline', b.dataset.profTab !== name);
    });
    const tab = document.getElementById('prof-tab-' + name);
    if (tab) tab.style.display = '';
    if (name === 'llm') loadLlmProfiles({ silent: true });
}

// --- テキスト一括変更 ---
let _textBulkMappings = []; // [{account_id, display_name, bio}]

function _parseTextList(text, allowComma = true) {
    // カンマまたは改行で分割
    let items;
    if (allowComma && text.includes(',') && !text.includes('\n')) {
        // カンマ区切り（1行にカンマで並べた場合）
        items = text.split(',');
    } else if (allowComma && text.includes(',') && text.includes('\n')) {
        // 混在の場合は改行優先、各行のカンマも分割
        items = text.split('\n').flatMap(line => line.split(','));
    } else {
        // 改行区切り
        items = text.split('\n');
    }
    return items.map(s => s.trim()).filter(s => s.length > 0);
}

function previewTextBulkNames() {
    const accountIds = getCheckedAccounts('profile-account-list');
    if (accountIds.length === 0) { showToast('対象アカウントを選択してください', 'error'); return; }

    const namesText = document.getElementById('textbulk-names').value.trim();
    const biosText = document.getElementById('textbulk-bios').value.trim();

    if (!namesText && !biosText) {
        showToast('表示名または自己紹介を入力してください', 'error');
        return;
    }

    const names = namesText ? _parseTextList(namesText, true) : [];
    const bios = biosText ? _parseTextList(biosText, true) : [];

    if (names.length === 0 && bios.length === 0) {
        showToast('有効なデータがありません', 'error');
        return;
    }

    _buildTextBulkMappings(accountIds, names, bios);
    showToast(`${_textBulkMappings.length}件の割当を生成しました`, 'info');
}

function _buildTextBulkMappings(accountIds, names, bios) {
    _textBulkMappings = accountIds.map((acctId, i) => ({
        account_id: acctId,
        display_name: names.length > 0 ? names[i % names.length] : '',
        bio: bios.length > 0 ? bios[i % bios.length] : '',
    }));
    _renderTextBulkPreview();
}

function shuffleTextBulkNames() {
    const accountIds = getCheckedAccounts('profile-account-list');
    if (accountIds.length === 0) { showToast('対象アカウントを選択してください', 'error'); return; }

    const namesText = document.getElementById('textbulk-names').value.trim();
    const biosText = document.getElementById('textbulk-bios').value.trim();

    const names = namesText ? _parseTextList(namesText, true) : [];
    const bios = biosText ? _parseTextList(biosText, true) : [];

    // シャッフル
    const shuffled = arr => {
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    };

    _buildTextBulkMappings(accountIds, names.length > 0 ? shuffled(names) : [], bios.length > 0 ? shuffled(bios) : []);
    showToast('割り当てをシャッフルしました', 'info');
}

function _renderTextBulkPreview() {
    const card = document.getElementById('textbulk-preview-card');
    const tbody = document.getElementById('textbulk-preview-tbody');
    const countEl = document.getElementById('textbulk-preview-count');

    card.style.display = '';
    countEl.textContent = `(${_textBulkMappings.length}件)`;

    tbody.innerHTML = _textBulkMappings.map((m, i) => `<tr>
        <td>${i + 1}</td>
        <td><strong>@${m.account_id}</strong></td>
        <td style="text-align:center;font-size:16px;">→</td>
        <td>${m.display_name ? '<strong>' + _escHtml(m.display_name) + '</strong>' : '<span style="color:var(--text-muted)">(変更なし)</span>'}</td>
        <td style="font-size:13px;max-width:300px;white-space:normal;word-break:break-word;">${m.bio ? _escHtml(m.bio) : '<span style="color:var(--text-muted)">(変更なし)</span>'}</td>
    </tr>`).join('');

    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function applyTextBulkProfiles() {
    if (_textBulkMappings.length === 0) {
        showToast('プレビューを先に実行してください', 'error');
        return;
    }
    if (!confirm(`${_textBulkMappings.length}件のプロフィールを変更します。よろしいですか？`)) return;

    const rows = _textBulkMappings.map(m => ({
        display_name: m.display_name || '',
        bio: m.bio || '',
    }));
    const accountIds = _textBulkMappings.map(m => m.account_id);

    try {
        const res = await apiPost('/api/profiles/csv/apply', {
            rows: rows,
            account_ids: accountIds,
        });
        watchTask(res.task_id, 'テキスト一括プロフィール変更');
    } catch (e) {
        showToast('適用失敗: ' + e.message, 'error');
    }
}

// --- 手動 ---
async function updateProfiles() {
    const accountIds = getCheckedAccounts('profile-account-list');
    if (accountIds.length === 0) { showToast('アカウントを選択してください', 'error'); return; }

    const data = {
        account_ids: accountIds,
        display_name: document.getElementById('profile-name').value.trim() || null,
        bio: document.getElementById('profile-bio').value.trim() || null,
        icon_path: document.getElementById('profile-icon').value.trim() || null,
        header_path: document.getElementById('profile-header').value.trim() || null,
    };

    if (!data.display_name && !data.bio && !data.icon_path && !data.header_path) {
        showToast('変更する項目を1つ以上入力してください', 'error');
        return;
    }

    try {
        const result = await apiPost('/api/profiles/update', data);
        watchTask(result.task_id, 'プロフィール更新');
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// --- アイコン検索 ---
let _iconSearchResults = [];   // 検索結果
let _iconSelectedUrls = [];    // ユーザーが選択した画像(順序付き)
let _iconSearchPage = 0;       // 現在のページ(0始まり)
let _iconSearchKeyword = '';   // 最後に検索したキーワード
let _iconIsLoadingMore = false;

async function searchIcons(loadMore = false) {
    const keyword = document.getElementById('icon-search-keyword').value.trim();
    if (!keyword) { showToast('キーワードを入力してください', 'error'); return; }

    const btn = document.getElementById('icon-search-btn');
    const moreBtn = document.getElementById('icon-load-more-btn');

    if (loadMore) {
        if (moreBtn) { moreBtn.disabled = true; moreBtn.textContent = '読み込み中...'; }
        _iconIsLoadingMore = true;
    } else {
        btn.disabled = true; btn.textContent = '検索中...';
        _iconSearchResults = [];
        _iconSelectedUrls = [];
        _iconSearchPage = 0;
        _iconSearchKeyword = keyword;
    }

    // offset: ページ数 × 8スクロール分
    const offset = _iconSearchPage * 8;

    try {
        const res = await apiPost('/api/profiles/icons/search', {
            keyword,
            max_results: 30,
            offset,
        });
        const newImages = res.images || [];

        // 重複排除して追加
        const existingFulls = new Set(_iconSearchResults.map(img => img.full));
        const uniqueNew = newImages.filter(img => !existingFulls.has(img.full));
        _iconSearchResults = _iconSearchResults.concat(uniqueNew);
        _iconSearchPage++;

        renderIconGrid();
        document.getElementById('icon-results-card').style.display = '';
        document.getElementById('icon-result-count').textContent = `(${_iconSearchResults.length}件)`;

        if (newImages.length === 0 && loadMore) {
            showToast('これ以上の画像が見つかりませんでした', 'info');
        }
    } catch (e) {
        showToast('検索失敗: ' + e.message, 'error');
    } finally {
        btn.disabled = false; btn.textContent = '検索';
        _iconIsLoadingMore = false;
        if (moreBtn) { moreBtn.disabled = false; moreBtn.textContent = '次の30件を読み込む ▼'; }
    }
}

function renderIconGrid() {
    const grid = document.getElementById('icon-results-grid');
    grid.innerHTML = _iconSearchResults.map((img, i) => {
        const sel = _iconSelectedUrls.indexOf(img.full);
        const selectedClass = sel >= 0 ? 'selected' : '';
        const order = sel >= 0 ? sel + 1 : '';
        return `<div class="icon-grid-item ${selectedClass}" data-idx="${i}" data-order="${order}" title="${(img.alt || '').replace(/"/g, '&quot;')}">
            <img src="${img.thumb}" alt="" loading="lazy" draggable="false">
        </div>`;
    }).join('');
    updateIconSelectedCount();
    _initIconDragSelect();
}

function toggleIconSelect(idx) {
    const url = _iconSearchResults[idx].full;
    const pos = _iconSelectedUrls.indexOf(url);
    if (pos >= 0) {
        _iconSelectedUrls.splice(pos, 1);
    } else {
        _iconSelectedUrls.push(url);
    }
    renderIconGrid();
}

function updateIconSelectedCount() {
    const el = document.getElementById('icon-selected-count');
    const accountIds = getCheckedAccounts('profile-account-list');
    const need = accountIds.length;
    el.textContent = `${_iconSelectedUrls.length}枚選択中 / ${need}アカウント`;

    // 「画像をN個選択」ボタンの表示・更新
    const autoBtn = document.getElementById('icon-auto-select-btn');
    if (autoBtn && need > 0 && _iconSearchResults.length > 0) {
        autoBtn.style.display = '';
        autoBtn.textContent = `上から${need}個を自動選択`;
    } else if (autoBtn) {
        autoBtn.style.display = 'none';
    }
}

function autoSelectIcons() {
    const accountIds = getCheckedAccounts('profile-account-list');
    const need = accountIds.length;
    if (need === 0) { showToast('アカウントを選択してください', 'error'); return; }
    if (_iconSearchResults.length === 0) { showToast('先に画像を検索してください', 'error'); return; }

    _iconSelectedUrls = _iconSearchResults.slice(0, need).map(img => img.full);
    renderIconGrid();
    showToast(`${_iconSelectedUrls.length}枚を自動選択しました`, 'success');
}

// --- マウスドラッグ選択 ---
let _dragState = null;

function _initIconDragSelect() {
    const grid = document.getElementById('icon-results-grid');
    if (!grid) return;

    // 既存のリスナーを除去するため毎回再設定（renderIconGrid呼び出し時）
    grid.onmousedown = _dragStart;
    grid.oncontextmenu = e => { if (_dragState) e.preventDefault(); };

    // document レベルのリスナーは1回だけ設定
    if (!grid._dragEventsSet) {
        document.addEventListener('mousemove', _dragMove);
        document.addEventListener('mouseup', _dragEnd);
        grid._dragEventsSet = true;
    }
}

function _dragStart(e) {
    // 左クリックのみ
    if (e.button !== 0) return;
    const grid = document.getElementById('icon-results-grid');
    const rect = grid.getBoundingClientRect();

    // ドラッグ選択用の矩形要素を作成
    let selBox = document.getElementById('icon-drag-select-box');
    if (!selBox) {
        selBox = document.createElement('div');
        selBox.id = 'icon-drag-select-box';
        document.body.appendChild(selBox);
    }

    _dragState = {
        startX: e.clientX,
        startY: e.clientY,
        gridRect: rect,
        moved: false,
        initialSelected: [..._iconSelectedUrls],  // ドラッグ開始時の選択状態を保存
    };

    selBox.style.cssText = `
        position: fixed; left: ${e.clientX}px; top: ${e.clientY}px;
        width: 0; height: 0;
        border: 2px solid var(--primary);
        background: rgba(59, 130, 246, 0.15);
        pointer-events: none;
        z-index: 9999;
        border-radius: 3px;
        display: none;
    `;
}

function _dragMove(e) {
    if (!_dragState) return;

    const dx = e.clientX - _dragState.startX;
    const dy = e.clientY - _dragState.startY;

    // 5px以上動いたらドラッグとみなす
    if (!_dragState.moved && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
        _dragState.moved = true;
    }
    if (!_dragState.moved) return;

    const selBox = document.getElementById('icon-drag-select-box');
    if (!selBox) return;

    const x = Math.min(e.clientX, _dragState.startX);
    const y = Math.min(e.clientY, _dragState.startY);
    const w = Math.abs(dx);
    const h = Math.abs(dy);

    selBox.style.left = x + 'px';
    selBox.style.top = y + 'px';
    selBox.style.width = w + 'px';
    selBox.style.height = h + 'px';
    selBox.style.display = 'block';

    // 矩形と重なるアイテムをハイライト
    const selRect = { left: x, top: y, right: x + w, bottom: y + h };
    const grid = document.getElementById('icon-results-grid');
    const items = grid.querySelectorAll('.icon-grid-item');

    items.forEach(item => {
        const ir = item.getBoundingClientRect();
        const overlaps = !(ir.right < selRect.left || ir.left > selRect.right || ir.bottom < selRect.top || ir.top > selRect.bottom);
        if (overlaps) {
            item.classList.add('drag-hover');
        } else {
            item.classList.remove('drag-hover');
        }
    });
}

function _dragEnd(e) {
    if (!_dragState) return;

    const selBox = document.getElementById('icon-drag-select-box');
    if (selBox) selBox.style.display = 'none';

    if (!_dragState.moved) {
        // ドラッグではなくクリック → 通常の選択切替
        const grid = document.getElementById('icon-results-grid');
        const target = e.target.closest('.icon-grid-item');
        if (target) {
            const idx = parseInt(target.dataset.idx, 10);
            if (!isNaN(idx)) toggleIconSelect(idx);
        }
        _dragState = null;
        return;
    }

    // ドラッグ終了 — 矩形内のアイテムを選択に追加
    const grid = document.getElementById('icon-results-grid');
    const items = grid.querySelectorAll('.icon-grid-item');
    const x = Math.min(e.clientX, _dragState.startX);
    const y = Math.min(e.clientY, _dragState.startY);
    const w = Math.abs(e.clientX - _dragState.startX);
    const h = Math.abs(e.clientY - _dragState.startY);
    const selRect = { left: x, top: y, right: x + w, bottom: y + h };

    items.forEach(item => {
        item.classList.remove('drag-hover');
        const ir = item.getBoundingClientRect();
        const overlaps = !(ir.right < selRect.left || ir.left > selRect.right || ir.bottom < selRect.top || ir.top > selRect.bottom);
        if (overlaps) {
            const idx = parseInt(item.dataset.idx, 10);
            if (!isNaN(idx)) {
                const url = _iconSearchResults[idx].full;
                if (_iconSelectedUrls.indexOf(url) < 0) {
                    _iconSelectedUrls.push(url);
                }
            }
        }
    });

    _dragState = null;
    renderIconGrid();
}

function selectAllIcons() {
    _iconSelectedUrls = _iconSearchResults.map(img => img.full);
    renderIconGrid();
}

function deselectAllIcons() {
    _iconSelectedUrls = [];
    renderIconGrid();
}

async function approveIcons() {
    if (_iconSelectedUrls.length === 0) { showToast('画像を選択してください', 'error'); return; }
    const accountIds = getCheckedAccounts('profile-account-list');
    if (accountIds.length === 0) { showToast('対象アカウントを選択してください', 'error'); return; }

    const btn = document.getElementById('icon-approve-btn');
    btn.disabled = true; btn.textContent = '適用中...';

    try {
        const res = await apiPost('/api/profiles/icons/approve', {
            image_urls: _iconSelectedUrls,
            account_ids: accountIds,
        });
        watchTask(res.task_id, 'アイコン一括変更');
    } catch (e) {
        showToast('適用失敗: ' + e.message, 'error');
    } finally {
        btn.disabled = false; btn.textContent = '承認して一括適用';
    }
}

// --- LLMプロフィール ---
let _llmProfileItems = {};

function _llmProfileStatusBadge(item) {
    const status = item?.status || 'missing';
    if (status === 'generated') return '<span class="badge badge-active">生成済み</span>';
    if (status === 'applied') return '<span class="badge badge-active">適用済み</span>';
    if (status === 'failed') return '<span class="badge badge-warning">失敗</span>';
    return '<span class="badge badge-pending">未生成</span>';
}

function _llmProfileVisibleUsernames() {
    const selected = getCheckedAccounts('profile-account-list');
    if (selected.length > 0) return selected;
    return Object.values(_llmProfileItems)
        .sort((a, b) => String(b.generated_at || '').localeCompare(String(a.generated_at || '')))
        .map(item => item.username)
        .filter(Boolean)
        .slice(0, 200);
}

async function loadLlmProfiles({ silent = false } = {}) {
    const tbody = document.getElementById('llm-profile-preview-tbody');
    if (!tbody) return;
    try {
        const data = await apiGet('/api/llm/profiles');
        _llmProfileItems = data.items || {};
        const summary = data.summary || {};
        const summaryEl = document.getElementById('llm-profile-summary');
        if (summaryEl) {
            summaryEl.textContent = `未生成 ${summary.llm_profile_missing || 0} / 未適用 ${summary.llm_profile_generated_unapplied || 0} / 適用済み ${summary.llm_profile_applied || 0}`;
        }
        renderLlmProfilePreview();
    } catch (e) {
        if (!silent) showToast('LLMプロフィール読み込み失敗: ' + e.message, 'error');
    }
}

function renderLlmProfilePreview() {
    const tbody = document.getElementById('llm-profile-preview-tbody');
    const countEl = document.getElementById('llm-profile-preview-count');
    if (!tbody) return;
    const usernames = _llmProfileVisibleUsernames();
    if (countEl) countEl.textContent = `(${usernames.length}件)`;
    if (usernames.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="color:var(--text-muted);">表示するプロフィールがありません</td></tr>';
        return;
    }
    tbody.innerHTML = usernames.map(username => {
        const item = _llmProfileItems[username] || { username, status: 'missing' };
        const applyBlocked = item.apply_status === 'blocked';
        const canApply = item.status === 'generated' && item.display_name && item.bio && !item.applied_at && !applyBlocked;
        const checked = canApply ? 'checked' : '';
        const disabled = canApply ? '' : 'disabled';
        const topics = (item.topics || []).slice(0, 3).join(' / ');
        const meta = [item.tone_id || '', topics].filter(Boolean).join('<br>');
        let status = item.error
            ? `${_llmProfileStatusBadge(item)}<div style="font-size:11px;color:var(--danger);margin-top:4px;">${_escHtml(item.error)}</div>`
            : _llmProfileStatusBadge(item);
        if (applyBlocked) {
            status = `<span class="badge badge-warning">X側適用不可</span><div style="font-size:11px;color:var(--danger);margin-top:4px;">${_escHtml(item.last_apply_error || 'X側でプロフィールを更新できません')}</div>`;
        } else if (item.apply_status === 'failed' && item.last_apply_error) {
            status += `<div style="font-size:11px;color:var(--danger);margin-top:4px;">${_escHtml(item.last_apply_error)}</div>`;
        }
        return `<tr>
            <td><input type="checkbox" class="llm-profile-apply-check" value="${_escHtml(username)}" ${checked} ${disabled}></td>
            <td><strong>@${_escHtml(username)}</strong></td>
            <td><strong>${item.display_name ? _escHtml(item.display_name) : '<span style="color:var(--text-muted);font-weight:400;">-</span>'}</strong></td>
            <td style="font-size:13px;max-width:360px;white-space:normal;word-break:break-word;">${item.bio ? _escHtml(item.bio) : '<span style="color:var(--text-muted);">-</span>'}</td>
            <td style="font-size:12px;color:var(--text-muted);">${meta || '-'}</td>
            <td>${status}</td>
        </tr>`;
    }).join('');
}

function selectAllLlmProfileChecks(checked) {
    document.querySelectorAll('.llm-profile-apply-check:not(:disabled)').forEach(el => { el.checked = !!checked; });
}

async function generateLlmProfiles() {
    const accountIds = getCheckedAccounts('profile-account-list');
    if (accountIds.length === 0) { showToast('対象アカウントを選択してください', 'error'); return; }
    const regenerate = !!document.getElementById('llm-profile-regenerate')?.checked;
    try {
        const res = await apiPost('/api/llm/profiles/generate', {
            usernames: accountIds,
            regenerate,
            retry_failed: true,
            limit: accountIds.length,
        });
        showToast(res.message || `${res.total || 0}件のLLMプロフィール生成を開始しました`, 'success');
        if (res.task?.task_id) watchTask(res.task.task_id, 'LLMプロフィール生成');
        setTimeout(() => loadLlmProfiles({ silent: true }), 2500);
    } catch (e) {
        showToast('LLMプロフィール生成失敗: ' + e.message, 'error');
    }
}

async function applyLlmProfiles() {
    const usernames = Array.from(document.querySelectorAll('.llm-profile-apply-check:checked')).map(el => el.value);
    if (usernames.length === 0) { showToast('適用するプロフィールを選択してください', 'error'); return; }
    if (!confirm(`${usernames.length}件のLLMプロフィールを適用します。よろしいですか？`)) return;
    try {
        const res = await apiPost('/api/llm/profiles/apply', {
            usernames,
            limit: usernames.length,
        });
        showToast(res.message || `${res.total || 0}件のLLMプロフィール適用を開始しました`, 'success');
        if (res.task?.task_id) watchTask(res.task.task_id, 'LLMプロフィール適用');
        setTimeout(() => loadLlmProfiles({ silent: true }), 2500);
    } catch (e) {
        showToast('LLMプロフィール適用失敗: ' + e.message, 'error');
    }
}

// ============================================
// 競合監視
// ============================================
let _competitorTargetsCache = [];
let _competitorPostsCache = [];
let _competitorBackfillFocus = null;

async function refreshCompetitorPage() {
    await Promise.all([
        loadCompetitorProxyOptions(),
        loadCompetitorSummary(),
        loadCompetitorAuthAccounts(),
        loadCompetitorTargets(),
    ]);
    await loadCompetitorPosts();
}

async function loadCompetitorSummary() {
    try {
        const data = await apiGet('/api/competitors/summary');
        document.getElementById('competitor-stat-targets').textContent = data.enabled_targets || 0;
        document.getElementById('competitor-stat-posts').textContent = data.posts || 0;
        document.getElementById('competitor-stat-monitored').textContent = data.monitored_posts || 0;
        document.getElementById('competitor-stat-auth').textContent = data.enabled_auth_accounts || 0;
        const scheduler = data.scheduler || {};
        const statusEl = document.getElementById('competitor-scheduler-status');
        const nextRun = _competitorFormatTime(scheduler.next_run_at);
        const running = scheduler.running ? '実行中' : '待機中';
        const last = scheduler.last_result || {};
        statusEl.textContent = `${running} / ${scheduler.schedule_label || '15分ごと'} / 次回 ${nextRun || '-'} / 最終 ${last.status || 'なし'}`;
    } catch (e) {
        showToast('競合監視サマリー読込失敗: ' + e.message, 'error');
    }
}

async function loadCompetitorProxyOptions() {
    const select = document.getElementById('competitor-auth-proxy');
    if (!select) return;
    try {
        const data = await apiGet('/api/proxy/list');
        const options = (data.proxies || []).filter(p => p.type).map(p => {
            const label = p.display_name || p.country_code || p.country || p.proxy;
            const type = p.type === 'residential' ? 'Residential / ' : '';
            return `<option value="${_escHtml(p.proxy)}">${type}${_escHtml(label)} (${p.account_count || 0})</option>`;
        });
        select.innerHTML = `<option value="">Proxyを選択</option>${options.join('')}`;
    } catch (e) {
        select.innerHTML = '<option value="">Proxy読込失敗</option>';
    }
}

async function loadCompetitorAuthAccounts() {
    const area = document.getElementById('competitor-auth-list');
    if (!area) return;
    try {
        const data = await apiGet('/api/competitors/auth-accounts');
        const rows = data.items || [];
        if (!rows.length) {
            area.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">監視用AuthToken未登録</p>';
            return;
        }
        area.innerHTML = rows.map(row => {
            const status = row.last_status || 'untested';
            const color = status === 'ready' ? 'var(--success)' : status === 'error' ? 'var(--danger)' : 'var(--text-muted)';
            return `
                <div style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px;">
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                        <strong>${_esc(row.label || row.id || 'monitor')}</strong>
                        <span style="font-size:12px;color:${color};">${_esc(status)}</span>
                    </div>
                    <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">Token: ${_esc(row.auth_token_masked || '-')}</div>
                    <div style="font-size:11px;color:var(--text-muted);margin-top:2px;word-break:break-all;">Proxy: ${_esc(row.proxy || '-')}</div>
                    ${row.last_error ? `<div style="font-size:11px;color:var(--danger);margin-top:4px;">${_esc(row.last_error)}</div>` : ''}
                    <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
                        <button class="btn btn-sm btn-outline" onclick="toggleCompetitorAuth('${_esc(row.id)}', ${row.enabled ? 'false' : 'true'})">${row.enabled ? '無効化' : '有効化'}</button>
                        <button class="btn btn-sm btn-danger" onclick="deleteCompetitorAuth('${_esc(row.id)}')">削除</button>
                    </div>
                </div>
            `;
        }).join('');
    } catch (e) {
        area.innerHTML = `<p style="color:var(--danger);font-size:13px;">読込失敗: ${_esc(e.message)}</p>`;
    }
}

async function addCompetitorAuthAccount() {
    const label = document.getElementById('competitor-auth-label')?.value || '';
    const authToken = document.getElementById('competitor-auth-token')?.value || '';
    const proxy = document.getElementById('competitor-auth-proxy')?.value || '';
    const enabled = document.getElementById('competitor-auth-enabled')?.checked ?? true;
    if (!authToken.trim()) { showToast('AuthTokenを入力してください', 'error'); return; }
    if (!proxy.trim()) { showToast('Proxyを選択してください', 'error'); return; }
    try {
        await apiPost('/api/competitors/auth-accounts', { label, auth_token: authToken, proxy, enabled });
        document.getElementById('competitor-auth-token').value = '';
        document.getElementById('competitor-auth-label').value = '';
        showToast('監視用AuthTokenを追加しました', 'success');
        await Promise.all([loadCompetitorAuthAccounts(), loadCompetitorSummary()]);
    } catch (e) {
        showToast('AuthToken追加失敗: ' + e.message, 'error');
    }
}

async function toggleCompetitorAuth(id, enabled) {
    try {
        await apiPut(`/api/competitors/auth-accounts/${encodeURIComponent(id)}`, { enabled });
        await Promise.all([loadCompetitorAuthAccounts(), loadCompetitorSummary()]);
    } catch (e) {
        showToast('AuthToken更新失敗: ' + e.message, 'error');
    }
}

async function deleteCompetitorAuth(id) {
    if (!confirm('この監視用AuthTokenを削除しますか？')) return;
    try {
        await apiDelete(`/api/competitors/auth-accounts/${encodeURIComponent(id)}`);
        await Promise.all([loadCompetitorAuthAccounts(), loadCompetitorSummary()]);
    } catch (e) {
        showToast('AuthToken削除失敗: ' + e.message, 'error');
    }
}

async function loadCompetitorTargets() {
    const area = document.getElementById('competitor-target-list');
    const select = document.getElementById('competitor-post-username');
    if (!area) return;
    try {
        const data = await apiGet('/api/competitors/targets');
        _competitorTargetsCache = data.items || [];
        if (select) {
            const current = select.value;
            select.innerHTML = '<option value="">全アカウント</option>' + _competitorTargetsCache
                .map(t => `<option value="${_escHtml(t.username)}">@${_escHtml(t.username)}</option>`)
                .join('');
            select.value = current;
        }
        if (!_competitorTargetsCache.length) {
            area.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">監視対象未登録</p>';
            return;
        }
        area.innerHTML = _competitorTargetsCache.map(t => `
            <div style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px;">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                    <strong>@${_esc(t.username)}</strong>
                    <span class="badge ${t.enabled ? 'badge-active' : 'badge-pending'}">${t.enabled ? '有効' : '無効'}</span>
                </div>
                <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">
                    過去${t.backfill_days || 7}日 / 新規自動監視: ${t.auto_monitor_new_posts ? 'ON' : 'OFF'} / 最終: ${_competitorFormatTime(t.last_checked_at) || '-'}
                </div>
                ${t.last_error ? `<div style="font-size:11px;color:var(--danger);margin-top:4px;">${_esc(t.last_error)}</div>` : ''}
                <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
                    <button class="btn btn-sm btn-outline" onclick="toggleCompetitorTarget('${encodeURIComponent(t.username)}', ${t.enabled ? 'false' : 'true'})">${t.enabled ? '無効化' : '有効化'}</button>
                    <button class="btn btn-sm btn-outline" onclick="backfillCompetitorTarget('${encodeURIComponent(t.username)}', ${t.backfill_days || 7})">過去取得</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteCompetitorTarget('${encodeURIComponent(t.username)}')">削除</button>
                </div>
            </div>
        `).join('');
    } catch (e) {
        area.innerHTML = `<p style="color:var(--danger);font-size:13px;">読込失敗: ${_esc(e.message)}</p>`;
    }
}

async function addCompetitorTarget() {
    const username = (document.getElementById('competitor-target-username')?.value || '').trim().replace(/^@/, '');
    const backfillDays = parseInt(document.getElementById('competitor-target-days')?.value || '7', 10);
    const normalizedDays = Math.max(1, Math.min(backfillDays || 7, 30));
    const enabled = document.getElementById('competitor-target-enabled')?.checked ?? true;
    const autoMonitor = document.getElementById('competitor-target-auto-new')?.checked ?? true;
    if (!username) { showToast('アカウントIDを入力してください', 'error'); return; }
    try {
        const result = await apiPost('/api/competitors/targets', {
            username,
            enabled,
            backfill_days: normalizedDays,
            auto_monitor_new_posts: autoMonitor,
        });
        document.getElementById('competitor-target-username').value = '';
        if (result.task?.task_id) {
            watchTask(result.task.task_id, '競合ポスト過去取得', {
                onComplete: (task) => focusCompetitorBackfillResults(username, normalizedDays, task),
            });
        }
        await Promise.all([loadCompetitorTargets(), loadCompetitorSummary()]);
    } catch (e) {
        showToast('監視対象追加失敗: ' + e.message, 'error');
    }
}

async function toggleCompetitorTarget(encodedUsername, enabled) {
    const username = decodeURIComponent(encodedUsername);
    try {
        await apiPut(`/api/competitors/targets/${encodeURIComponent(username)}`, { enabled });
        await Promise.all([loadCompetitorTargets(), loadCompetitorSummary()]);
    } catch (e) {
        showToast('監視対象更新失敗: ' + e.message, 'error');
    }
}

async function backfillCompetitorTarget(encodedUsername, days) {
    const username = decodeURIComponent(encodedUsername);
    const normalizedDays = Math.max(1, Math.min(parseInt(days || '7', 10) || 7, 30));
    try {
        const result = await apiPost(`/api/competitors/targets/${encodeURIComponent(username)}/backfill`, { days: normalizedDays });
        if (result.task?.task_id) {
            watchTask(result.task.task_id, '競合ポスト過去取得', {
                onComplete: (task) => focusCompetitorBackfillResults(username, normalizedDays, task),
            });
        }
    } catch (e) {
        showToast('過去取得開始失敗: ' + e.message, 'error');
    }
}

function _lastTaskResult(task) {
    const results = task?.results || [];
    return results.length ? (results[results.length - 1] || {}) : {};
}

async function focusCompetitorBackfillResults(username, days, task) {
    const result = _lastTaskResult(task);
    const fetched = Number(result.fetched ?? task?.progress ?? 0);
    const userSelect = document.getElementById('competitor-post-username');
    const monitoredSelect = document.getElementById('competitor-post-monitored');
    const sinceInput = document.getElementById('competitor-post-since-days');
    const limitInput = document.getElementById('competitor-post-limit');
    if (userSelect) userSelect.value = username;
    if (monitoredSelect) monitoredSelect.value = 'false';
    if (sinceInput) sinceInput.value = String(days);
    if (limitInput) limitInput.value = '500';
    _competitorBackfillFocus = { username, days, fetched };
    showCompetitorBackfillResult(username, days, fetched, result);
    await Promise.all([loadCompetitorTargets(), loadCompetitorSummary()]);
    await loadCompetitorPosts();
    document.getElementById('competitor-posts-body')?.closest('.card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function showCompetitorBackfillResult(username, days, fetched, result = {}) {
    const area = document.getElementById('competitor-backfill-result');
    if (!area) return;
    const fetchedCount = Number.isFinite(fetched) ? fetched : 0;
    const source = result.source_operation || '-';
    const checked = Array.isArray(result.checked_operations) && result.checked_operations.length
        ? result.checked_operations.join(' → ')
        : '-';
    const auth = [result.auth_label, result.auth_status].filter(Boolean).join(' / ') || '-';
    const zeroNote = fetchedCount === 0
        ? `<div style="margin-top:6px;color:var(--warning);">0件でした。取得経路: ${_esc(checked)} / 採用経路: ${_esc(source)} / Auth: ${_esc(auth)}</div>`
        : `<div style="margin-top:6px;color:var(--text-muted);">採用経路: ${_esc(source)} / Auth: ${_esc(auth)}</div>`;
    area.style.display = 'block';
    area.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
            <div>
                <strong style="color:var(--text);">@${_esc(username)}</strong>
                の過去${_esc(days)}日分を取得しました。未監視ポストを表示中です。
                <span style="color:var(--text-muted);">取得: ${fetchedCount}件 / チェックを付けると継続監視になります。</span>
                ${zeroNote}
            </div>
            <button class="btn btn-sm btn-outline" onclick="clearCompetitorBackfillResult()">全ポスト表示に戻す</button>
        </div>
    `;
}

async function clearCompetitorBackfillResult() {
    _competitorBackfillFocus = null;
    const area = document.getElementById('competitor-backfill-result');
    if (area) {
        area.style.display = 'none';
        area.innerHTML = '';
    }
    const monitoredSelect = document.getElementById('competitor-post-monitored');
    const sinceInput = document.getElementById('competitor-post-since-days');
    if (monitoredSelect) monitoredSelect.value = '';
    if (sinceInput) sinceInput.value = '';
    await loadCompetitorPosts();
}

async function deleteCompetitorTarget(encodedUsername) {
    const username = decodeURIComponent(encodedUsername);
    if (!confirm(`@${username} を監視対象から削除しますか？`)) return;
    try {
        await apiDelete(`/api/competitors/targets/${encodeURIComponent(username)}`);
        await refreshCompetitorPage();
    } catch (e) {
        showToast('監視対象削除失敗: ' + e.message, 'error');
    }
}

async function loadCompetitorPosts() {
    const body = document.getElementById('competitor-posts-body');
    if (!body) return;
    const username = document.getElementById('competitor-post-username')?.value || '';
    const monitored = document.getElementById('competitor-post-monitored')?.value || '';
    const sinceDays = document.getElementById('competitor-post-since-days')?.value || '';
    const limit = document.getElementById('competitor-post-limit')?.value || '200';
    const params = new URLSearchParams();
    if (username) params.set('username', username);
    if (monitored) params.set('monitored', monitored);
    if (sinceDays) params.set('since_days', sinceDays);
    if (limit) params.set('limit', limit);
    body.innerHTML = '<tr><td colspan="9" style="color:var(--text-muted);">読み込み中...</td></tr>';
    try {
        const data = await apiGet(`/api/competitors/posts?${params.toString()}`);
        _competitorPostsCache = data.items || [];
        if (!_competitorPostsCache.length) {
            body.innerHTML = '<tr><td colspan="9" style="color:var(--text-muted);">ポストなし</td></tr>';
            document.getElementById('competitor-post-detail').innerHTML = '';
            return;
        }
        body.innerHTML = _competitorPostsCache.map(post => _renderCompetitorPostRow(post)).join('');
    } catch (e) {
        body.innerHTML = `<tr><td colspan="9" style="color:var(--danger);">読込失敗: ${_esc(e.message)}</td></tr>`;
    }
}

function _renderCompetitorPostRow(post) {
    const text = _esc((post.text || '').length > 80 ? post.text.substring(0, 80) + '...' : (post.text || '(本文なし)'));
    const tweetId = _esc(post.tweet_id || '');
    return `
        <tr onclick="showCompetitorPostDetail('${tweetId}')" style="cursor:pointer;">
            <td onclick="event.stopPropagation();">
                <input type="checkbox" ${post.monitored ? 'checked' : ''} onchange="toggleCompetitorPost('${tweetId}', this.checked)">
            </td>
            <td>@${_esc(post.username || '-')}</td>
            <td>
                <a href="${_esc(post.tweet_url || '#')}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation();">${text}</a>
                <div style="font-size:11px;color:var(--text-muted);">${_competitorFormatTime(post.posted_at) || '-'}</div>
            </td>
            <td>${_metricWithDeltas(post, 'like_count')}</td>
            <td>${_metricWithDeltas(post, 'retweet_count')}</td>
            <td>${_metricWithDeltas(post, 'reply_count')}</td>
            <td>${_metricWithDeltas(post, 'bookmark_count', true)}</td>
            <td>${_metricWithDeltas(post, 'impression_count', true)}</td>
            <td style="font-size:12px;color:var(--text-muted);">${_competitorFormatTime(post.last_checked_at) || '-'}</td>
        </tr>
    `;
}

async function toggleCompetitorPost(tweetId, monitored) {
    try {
        await apiPut(`/api/competitors/posts/${encodeURIComponent(tweetId)}`, { monitored });
        const post = _competitorPostsCache.find(p => String(p.tweet_id) === String(tweetId));
        if (post) post.monitored = monitored;
        await loadCompetitorSummary();
        const filter = document.getElementById('competitor-post-monitored')?.value || '';
        if ((filter === 'false' && monitored) || (filter === 'true' && !monitored)) {
            await loadCompetitorPosts();
        }
    } catch (e) {
        showToast('監視状態更新失敗: ' + e.message, 'error');
        await loadCompetitorPosts();
    }
}

async function enableVisibleCompetitorPosts() {
    const targets = _competitorPostsCache.filter(post => !post.monitored && post.tweet_id);
    if (!targets.length) {
        showToast('表示中の未監視ポストはありません', 'info');
        return;
    }
    try {
        for (const post of targets) {
            await apiPut(`/api/competitors/posts/${encodeURIComponent(post.tweet_id)}`, { monitored: true });
        }
        showToast(`表示中の${targets.length}件を監視ONにしました`, 'success');
        await Promise.all([loadCompetitorSummary(), loadCompetitorPosts()]);
    } catch (e) {
        showToast('一括監視ON失敗: ' + e.message, 'error');
        await loadCompetitorPosts();
    }
}

function showCompetitorPostDetail(tweetId) {
    const post = _competitorPostsCache.find(p => String(p.tweet_id) === String(tweetId));
    const area = document.getElementById('competitor-post-detail');
    if (!post || !area) return;
    const history = post.history || [];
    const chartsHtml = _renderCompetitorHistoryCharts(history);
    const historyRows = history.slice(-10).reverse().map(h => `
        <tr>
            <td>${_competitorFormatTime(h.checked_at) || '-'}</td>
            <td>${_metricValue(h.like_count)}</td>
            <td>${_metricValue(h.retweet_count)}</td>
            <td>${_metricValue(h.reply_count)}</td>
            <td>${_metricValue(h.bookmark_count, true)}</td>
            <td>${_metricValue(h.impression_count, true)}</td>
        </tr>
    `).join('');
    area.innerHTML = `
        <div style="border:1px solid var(--border);border-radius:8px;padding:12px;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
                <strong>@${_esc(post.username || '-')} / ${_competitorFormatTime(post.posted_at) || '-'}</strong>
                <a href="${_esc(post.tweet_url || '#')}" target="_blank" rel="noopener noreferrer">Xで開く</a>
            </div>
            <p style="white-space:pre-wrap;word-break:break-word;margin:10px 0;">${_esc(post.text || '(本文なし)')}</p>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
                <span class="badge badge-active">いいね ${_metricValue(post.like_count)}</span>
                <span class="badge badge-active">RT ${_metricValue(post.retweet_count)}</span>
                <span class="badge badge-active">リプ ${_metricValue(post.reply_count)}</span>
                <span class="badge badge-active">BM ${_metricValue(post.bookmark_count, true)}</span>
                <span class="badge badge-active">インプ ${_metricValue(post.impression_count, true)}</span>
                <span class="badge ${post.monitored ? 'badge-active' : 'badge-pending'}">${post.monitored ? '監視中' : '未監視'}</span>
            </div>
            ${chartsHtml}
            <div class="table-wrapper" style="max-height:260px;overflow:auto;">
                <table>
                    <thead><tr><th>取得時刻</th><th>いいね</th><th>RT</th><th>リプ</th><th>BM</th><th>インプ</th></tr></thead>
                    <tbody>${historyRows || '<tr><td colspan="6" style="color:var(--text-muted);">履歴なし</td></tr>'}</tbody>
                </table>
            </div>
        </div>
    `;
    area.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function _renderCompetitorHistoryCharts(history) {
    const sorted = (history || [])
        .filter(h => h && h.checked_at)
        .slice()
        .sort((a, b) => String(a.checked_at).localeCompare(String(b.checked_at)));
    if (sorted.length < 2) {
        return `
            <div style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px;color:var(--text-muted);font-size:13px;">
                変化グラフは取得履歴が2点以上になると表示されます。
            </div>
        `;
    }
    const metrics = [
        { key: 'like_count', label: 'いいね', color: '#45e6a4', na: false },
        { key: 'retweet_count', label: 'RT', color: '#60a5fa', na: false },
        { key: 'reply_count', label: 'リプ', color: '#f59e0b', na: false },
        { key: 'bookmark_count', label: 'BM', color: '#c084fc', na: true },
        { key: 'impression_count', label: 'インプ', color: '#f472b6', na: true },
    ];
    const cards = metrics.map(metric => _renderCompetitorMetricChart(sorted, metric)).join('');
    return `
        <div style="margin:12px 0;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
                <strong style="font-size:14px;">反応推移</strong>
                <span style="font-size:12px;color:var(--text-muted);">${_competitorFormatTime(sorted[0].checked_at)} → ${_competitorFormatTime(sorted[sorted.length - 1].checked_at)}</span>
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;">
                ${cards}
            </div>
        </div>
    `;
}

function _renderCompetitorMetricChart(history, metric) {
    const points = history
        .map((h, idx) => ({ idx, checked_at: h.checked_at, value: _competitorMetricNumber(h[metric.key]) }))
        .filter(p => p.value !== null);
    if (points.length < 2) {
        return `
            <div style="border:1px solid var(--border);border-radius:8px;padding:10px;min-height:130px;">
                <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:8px;">
                    <strong style="color:${metric.color};">${_esc(metric.label)}</strong>
                    <span style="color:var(--text-muted);font-size:12px;">N/A</span>
                </div>
                <div style="color:var(--text-muted);font-size:12px;">この指標は取得できていません。</div>
            </div>
        `;
    }
    const values = points.map(p => p.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = Math.max(1, max - min);
    const width = 300;
    const height = 112;
    const padX = 18;
    const padY = 18;
    const usableW = width - padX * 2;
    const usableH = height - padY * 2;
    const lastIndex = Math.max(1, history.length - 1);
    const coords = points.map(p => {
        const x = padX + (p.idx / lastIndex) * usableW;
        const y = padY + (1 - ((p.value - min) / range)) * usableH;
        return { ...p, x, y };
    });
    const polyline = coords.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const area = `${padX},${height - padY} ${polyline} ${coords[coords.length - 1].x.toFixed(1)},${height - padY}`;
    const first = points[0].value;
    const current = points[points.length - 1].value;
    const delta = current - first;
    const sign = delta > 0 ? '+' : '';
    const deltaColor = delta > 0 ? 'var(--success)' : delta < 0 ? 'var(--danger)' : 'var(--text-muted)';
    const dotEls = coords.map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.2" fill="${metric.color}"><title>${_esc(_competitorFormatTime(p.checked_at))}: ${_metricValue(p.value, metric.na)}</title></circle>`).join('');
    return `
        <div style="border:1px solid var(--border);border-radius:8px;padding:10px;min-height:150px;background:rgba(255,255,255,0.02);">
            <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;margin-bottom:4px;">
                <div>
                    <strong style="color:${metric.color};">${_esc(metric.label)}</strong>
                    <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${points.length}点 / ${_metricValue(min, metric.na)}〜${_metricValue(max, metric.na)}</div>
                </div>
                <div style="text-align:right;">
                    <div style="font-size:20px;font-weight:700;">${_metricValue(current, metric.na)}</div>
                    <div style="font-size:12px;color:${deltaColor};">${sign}${delta.toLocaleString()}</div>
                </div>
            </div>
            <svg viewBox="0 0 ${width} ${height}" width="100%" height="112" role="img" aria-label="${_esc(metric.label)}推移">
                <line x1="${padX}" y1="${padY}" x2="${padX}" y2="${height - padY}" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
                <line x1="${padX}" y1="${height - padY}" x2="${width - padX}" y2="${height - padY}" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
                <line x1="${padX}" y1="${padY + usableH / 2}" x2="${width - padX}" y2="${padY + usableH / 2}" stroke="rgba(255,255,255,0.08)" stroke-width="1" stroke-dasharray="4 5"/>
                <polygon points="${area}" fill="${metric.color}" opacity="0.12"></polygon>
                <polyline points="${polyline}" fill="none" stroke="${metric.color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
                ${dotEls}
            </svg>
        </div>
    `;
}

function _competitorMetricNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

async function runCompetitorMonitorNow() {
    try {
        const result = await apiPost('/api/competitors/run-now', {});
        if (result.task?.task_id) watchTask(result.task.task_id, '競合監視');
    } catch (e) {
        showToast('競合監視開始失敗: ' + e.message, 'error');
    }
}

function _metricValue(value, na = false) {
    if (value === null || value === undefined || value === '') return na ? 'N/A' : '-';
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString() : _esc(value);
}

function _metricWithDeltas(post, key, na = false) {
    const value = _metricValue(post[key], na);
    const deltas = post.deltas || {};
    const parts = [
        _deltaBadge(deltas.previous?.[key], '前'),
        _deltaBadge(deltas.one_hour?.[key], '1h'),
        _deltaBadge(deltas.twenty_four_hour?.[key], '24h'),
    ].filter(Boolean).join(' ');
    return `<div>${value}</div><div style="margin-top:3px;">${parts}</div>`;
}

function _deltaBadge(value, label) {
    if (value === null || value === undefined) return '';
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    const color = n > 0 ? 'var(--success)' : n < 0 ? 'var(--danger)' : 'var(--text-muted)';
    const sign = n > 0 ? '+' : '';
    return `<span style="font-size:10px;color:${color};margin-right:4px;">${label} ${sign}${n}</span>`;
}

function _competitorFormatTime(value) {
    if (!value) return '';
    return String(value).replace('T', ' ').substring(0, 16);
}

// ============================================
// 一括アクション
// ============================================
const ACTION_TYPE_LABELS = {
    like: 'いいね',
    bookmark: 'ブックマーク',
    follow: 'フォロー',
    retweet: 'リツイート',
};

let _urlEngagementPreviewCache = null;
let _actionFilterOptionsLoaded = false;
let _urlEngagementInputsBound = false;

async function refreshActionPage() {
    refreshAccountCheckboxes('action-account-list');
    _bindUrlEngagementInputs();
    _syncUrlEngagementLimit();
    await loadActionFilterOptions();
}

function _setActionSelectOptions(selectId, options, keepFirst = true) {
    const select = document.getElementById(selectId);
    if (!select) return;
    const first = keepFirst ? (select.options[0]?.outerHTML || '<option value="">指定なし</option>') : '';
    select.innerHTML = first + options.join('');
}

async function loadActionFilterOptions(force = false) {
    if (_actionFilterOptionsLoaded && !force) return;
    try {
        const stats = await apiGet('/api/export/stats');
        const yearKeys = Object.keys(stats.years || {}).map(Number).sort((a, b) => a - b);
        const yearOptions = yearKeys.map(y => `<option value="${y}">${y}年 (${stats.years[y]})</option>`);
        _setActionSelectOptions('action-filter-year-from', yearOptions);
        _setActionSelectOptions('action-filter-year-to', yearOptions);

        const proxyOptions = [];
        if ((stats.no_proxy_count || 0) > 0) {
            proxyOptions.push(`<option value="__no_proxy__">Proxyなし (${stats.no_proxy_count})</option>`);
        }
        (stats.proxy_options || []).forEach(p => {
            const tag = p.type === 'residential' ? 'Residential / ' : '';
            const country = p.country_code || p.country || '';
            proxyOptions.push(`<option value="${_escHtml(p.value)}">${tag}${_escHtml(p.label)}${country ? ` / ${_escHtml(country)}` : ''} (${p.count})</option>`);
        });
        _setActionSelectOptions('action-filter-proxy', proxyOptions);
        _actionFilterOptionsLoaded = true;
    } catch (e) {
        showToast('アクション用フィルタ読込失敗: ' + e.message, 'error');
    }
}

function _bindUrlEngagementInputs() {
    if (_urlEngagementInputsBound) return;
    const ids = [
        'action-tweet-id',
        'action-count-like',
        'action-count-bookmark',
        'action-count-retweet',
        'action-filter-year-from',
        'action-filter-year-to',
        'action-filter-shadowban',
        'action-filter-status',
        'action-filter-proxy',
        'action-filter-usernames',
        'action-filter-sort1',
        'action-filter-sort2',
        'action-concurrency',
        'action-filter-exclude-exported',
    ];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const eventName = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
        el.addEventListener(eventName, () => {
            _urlEngagementPreviewCache = null;
            _syncUrlEngagementLimit();
            const btn = document.getElementById('action-url-execute-btn');
            if (btn) btn.disabled = true;
        });
    });
    _urlEngagementInputsBound = true;
}

function _collectTweetEngagementTarget() {
    return (document.getElementById('action-tweet-id')?.value || '').trim();
}

function _isValidTweetEngagementTarget(value) {
    return /^\d{5,}$/.test(value) || /\/status\/\d+/.test(value);
}

function _readActionCount(id) {
    const raw = document.getElementById(id)?.value || '0';
    const value = parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function _collectUrlEngagementActionCounts() {
    const counts = {
        like: _readActionCount('action-count-like'),
        bookmark: _readActionCount('action-count-bookmark'),
        retweet: _readActionCount('action-count-retweet'),
    };
    Object.keys(counts).forEach(key => {
        if (counts[key] <= 0) delete counts[key];
    });
    return counts;
}

function _urlEngagementRequiredAccounts(counts = null) {
    const values = Object.values(counts || _collectUrlEngagementActionCounts());
    return values.length ? Math.max(...values) : 0;
}

function _syncUrlEngagementLimit() {
    const required = _urlEngagementRequiredAccounts();
    const limitEl = document.getElementById('action-filter-limit');
    if (limitEl) limitEl.value = required || 1;
    return required;
}

function _collectActionConcurrency() {
    const raw = document.getElementById('action-concurrency')?.value || '5';
    const value = parseInt(raw, 10);
    if (!Number.isFinite(value)) return 5;
    return Math.max(1, Math.min(value, 10));
}

function _collectActionAccountFilters() {
    const yearFrom = document.getElementById('action-filter-year-from')?.value || '';
    const yearTo = document.getElementById('action-filter-year-to')?.value || '';
    const shadowban = document.getElementById('action-filter-shadowban')?.value || '';
    const status = document.getElementById('action-filter-status')?.value || '';
    const proxyFilter = document.getElementById('action-filter-proxy')?.value || '';
    const excludeExported = document.getElementById('action-filter-exclude-exported')?.checked ?? true;
    const requiredCount = _syncUrlEngagementLimit();
    const limitVal = requiredCount || (document.getElementById('action-filter-limit')?.value || '');
    const usernames = typeof _parseExportIds === 'function'
        ? _parseExportIds(document.getElementById('action-filter-usernames')?.value || '')
        : (document.getElementById('action-filter-usernames')?.value || '').split(/[\s,]+/).map(v => v.trim()).filter(Boolean);
    const sortParts = [
        document.getElementById('action-filter-sort1')?.value || '',
        document.getElementById('action-filter-sort2')?.value || '',
    ].filter(Boolean);

    return {
        year_from: yearFrom ? parseInt(yearFrom, 10) : null,
        year_to: yearTo ? parseInt(yearTo, 10) : null,
        clean_only: shadowban === 'clean',
        search_ok_only: shadowban === 'search_ok',
        latest_post_latest_ok_only: shadowban === 'latest_post_latest_ok',
        status_filter: status || null,
        proxy_filter: proxyFilter || null,
        usernames,
        exclude_exported: excludeExported,
        sort_by: sortParts.length ? sortParts.join(',') : null,
        limit: limitVal ? parseInt(limitVal, 10) : null,
    };
}

function _renderActionPlanBadges(index, counts) {
    const actions = ["like", "bookmark", "retweet"]
        .filter(action => index < (counts[action] || 0))
        .map(action => ACTION_TYPE_LABELS[action] || action);
    if (!actions.length) return '-';
    return actions.map(label => `<span style="display:inline-block;margin:2px;padding:3px 8px;border:1px solid rgba(255,255,255,.18);border-radius:999px;font-size:12px;">${_esc(label)}</span>`).join('');
}

function _renderUrlEngagementPreview(accounts, counts = {}) {
    if (!accounts.length) {
        return '<p style="color:var(--text-muted)">対象アカウントがありません</p>';
    }
    const rows = accounts.map((a, i) => `
        <tr>
            <td>${i + 1}</td>
            <td>@${_esc(a.username)}</td>
            <td>${_renderActionPlanBadges(i, counts)}</td>
            <td>${_esc(a.status || '-')}</td>
            <td>${a.created_year || '-'}</td>
            <td>${_esc(a.search_status || '-')}</td>
            <td>${_esc(a.proxy_label || a.proxy_country_code || a.proxy_display_name || '-')}</td>
        </tr>
    `).join('');
    return `
        <div class="table-wrapper">
            <table>
                <thead><tr><th>#</th><th>アカウント</th><th>実行</th><th>状態</th><th>作成年</th><th>検索状態</th><th>Proxy</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

async function previewUrlEngagementAccounts() {
    await loadActionFilterOptions();
    const area = document.getElementById('action-url-preview-area');
    const summary = document.getElementById('action-url-preview-summary');
    const executeBtn = document.getElementById('action-url-execute-btn');
    const tweetTarget = _collectTweetEngagementTarget();
    const actionCounts = _collectUrlEngagementActionCounts();
    const requiredCount = _syncUrlEngagementLimit();
    if (!tweetTarget) { showToast('ツイートIDを入力してください', 'error'); return; }
    if (!_isValidTweetEngagementTarget(tweetTarget)) { showToast('ツイートIDまたはstatus URLを入力してください', 'error'); return; }
    if (!requiredCount) { showToast('実行数量を1件以上指定してください', 'error'); return; }
    area.innerHTML = '<p style="color:var(--text-muted)">対象を抽出中...</p>';
    if (executeBtn) executeBtn.disabled = true;
    try {
        const filters = _collectActionAccountFilters();
        filters.limit = requiredCount;
        const resp = await apiPost('/api/export/preview', filters);
        _urlEngagementPreviewCache = { ...resp, tweetTarget, actionCounts };
        const accounts = resp.accounts || [];
        area.innerHTML = _renderUrlEngagementPreview(accounts, actionCounts);
        const actionSummary = Object.entries(actionCounts)
            .map(([action, count]) => `${ACTION_TYPE_LABELS[action] || action} ${count}`)
            .join(' / ');
        if (summary) {
            const shortage = accounts.length < requiredCount ? ` / 不足 ${requiredCount - accounts.length} 件` : '';
            summary.textContent = `${actionSummary} / 必要 ${requiredCount} 件 / 抽出 ${accounts.length} 件 / 並列 ${_collectActionConcurrency()} / 条件一致 ${resp.total_matched ?? accounts.length} 件${shortage}`;
        }
        if (executeBtn) executeBtn.disabled = accounts.length < requiredCount;
    } catch (e) {
        _urlEngagementPreviewCache = null;
        area.innerHTML = `<p style="color:var(--danger)">対象抽出失敗: ${_esc(e.message)}</p>`;
        if (summary) summary.textContent = '';
    }
}

async function executeUrlEngagement() {
    const tweetTarget = _collectTweetEngagementTarget();
    const actionCounts = _collectUrlEngagementActionCounts();
    const requiredCount = _syncUrlEngagementLimit();
    if (!tweetTarget) { showToast('ツイートIDを入力してください', 'error'); return; }
    if (!_isValidTweetEngagementTarget(tweetTarget)) { showToast('ツイートIDまたはstatus URLを入力してください', 'error'); return; }
    if (!requiredCount) { showToast('実行数量を1件以上指定してください', 'error'); return; }
    const samePreview = _urlEngagementPreviewCache
        && _urlEngagementPreviewCache.tweetTarget === tweetTarget
        && JSON.stringify(_urlEngagementPreviewCache.actionCounts || {}) === JSON.stringify(actionCounts);
    if (!samePreview || !(_urlEngagementPreviewCache.accounts || []).length) {
        await previewUrlEngagementAccounts();
    }
    const accounts = (_urlEngagementPreviewCache && _urlEngagementPreviewCache.accounts) || [];
    if (accounts.length < requiredCount) {
        showToast(`対象アカウントが不足しています（必要 ${requiredCount} 件 / 抽出 ${accounts.length} 件）`, 'error');
        return;
    }
    const accountIds = accounts.slice(0, requiredCount).map(a => a.username).filter(Boolean);
    if (!accountIds.length) { showToast('対象アカウントがありません', 'error'); return; }
    const actionLabel = Object.entries(actionCounts)
        .map(([action, count]) => `${ACTION_TYPE_LABELS[action] || action}: ${count}`)
        .join(' / ');
    if (!confirm(`ツイート ${tweetTarget} に実行しますか？\n${actionLabel}\n使用アカウント: ${accountIds.length}件\n並列数: ${_collectActionConcurrency()}`)) return;

    try {
        const result = await apiPost('/api/actions/url-engagement', {
            account_ids: accountIds,
            tweet_id: tweetTarget,
            action_counts: actionCounts,
            concurrency: _collectActionConcurrency(),
        });
        watchTask(result.task_id, 'ツイートID指定エンゲージ');
    } catch (e) {
        showToast('ツイートID指定エンゲージ開始失敗: ' + e.message, 'error');
    }
}

async function bulkAction(type) {
    const accountIds = getCheckedAccounts('action-account-list');
    if (accountIds.length === 0) { showToast('アカウントを選択してください', 'error'); return; }

    const targetEl = document.getElementById(`${type}-targets`);
    const targets = targetEl.value.trim().split('\n').filter(t => t.trim());
    if (targets.length === 0) { showToast('対象を1つ以上入力してください', 'error'); return; }

    try {
        const result = await apiPost(`/api/actions/${type}`, {
            account_ids: accountIds,
            targets: targets,
        });
        watchTask(result.task_id, ACTION_TYPE_LABELS[type]);
        targetEl.value = '';
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// ============================================
// タスク管理
// ============================================
async function refreshTasks() {
    try {
        const tasks = await apiGet('/api/tasks');
        const container = document.getElementById('tasks-list');
        if (tasks.length === 0) {
            container.innerHTML = '<div class="card"><p style="color:var(--text-muted)">タスクはありません</p></div>';
            return;
        }
        container.innerHTML = tasks.reverse().map(t => {
            const pct = t.total > 0 ? Math.round((t.progress / t.total) * 100) : 0;
            const badgeClass = t.status === 'running' ? 'badge-pending' :
                               t.status === 'completed' ? 'badge-active' : 'badge-error';
            const errorCount = t.error_count ?? (t.errors || []).length;
            const resultCount = t.result_count ?? (t.results || []).length;
            const errors = t.errors || [];
            return `<div class="card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <strong>${actionLabel(t.action)}</strong>
                    <span class="badge ${badgeClass}">${statusLabel(t.status)}</span>
                </div>
                <div style="font-size:13px;color:var(--text-muted)">
                    タスクID: ${t.task_id} | 進捗: ${t.progress}/${t.total} (${pct}%)
                </div>
                <div class="progress-bar">
                    <div class="progress-fill" style="width:${pct}%"></div>
                </div>
                ${errorCount > 0 ? `<div style="margin-top:8px;font-size:12px;color:var(--danger)">エラー: ${errorCount}件${errors.length ? ` (${errors.join(', ')})` : ''}</div>` : ''}
                ${resultCount > 0 ? `<div style="margin-top:8px;font-size:12px;color:var(--text-muted)">結果: ${resultCount}件</div>` : ''}
                ${t.status === 'running' ? `<button class="btn btn-sm btn-danger" style="margin-top:8px" onclick="cancelTask('${t.task_id}')">キャンセル</button>` : ''}
            </div>`;
        }).join('');
    } catch (e) {
        showToast('タスク読み込み失敗: ' + e.message, 'error');
    }
}

async function cancelTask(taskId) {
    try {
        await apiPost(`/api/tasks/${taskId}/cancel`);
        showToast('タスクをキャンセルしました', 'success');
        refreshTasks();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function clearTasks() {
    try {
        await apiDelete('/api/tasks/clear');
        showToast('完了済みタスクを削除しました', 'success');
        refreshTasks();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// ============================================
// Proxy管理
// ============================================
let _proxyListCache = null;

async function loadProxyDashboard() {
    const area = document.getElementById('proxy-table-area');
    area.innerHTML = '<p style="color:var(--text-muted)">読み込み中...</p>';
    try {
        const listData = await apiGet('/api/proxy/list');
        _proxyListCache = listData;
        let alertData = { alerts: [], alert_count: 0 };
        let escapeData = { enabled: false, states: [], rotations_24h: 0, proxy_errors_24h: 0, distinct_proxy_error_accounts_24h: 0 };
        try { alertData = await apiGet('/api/proxy/alerts'); } catch (_) {}
        try { escapeData = await apiGet('/api/proxy/escape/summary'); } catch (_) {}
        _renderProxyStats(listData, alertData, escapeData);
        _renderProxyAlerts(alertData);
        _renderProxyEscape(escapeData);
        _renderProxyTable(listData);
        _updateProxySelect(listData);
        _renderProxyAccountList(listData);
    } catch (e) {
        area.innerHTML = `<p style="color:var(--danger)">読み込みエラー: ${e.message}</p>`;
        console.error('Proxy dashboard error:', e);
    }
}

function _renderProxyStats(listData, alertData, escapeData = {}) {
    const assigned = listData.total_accounts - listData.unassigned_count;
    document.getElementById('proxy-stat-total').textContent = listData.total_proxies;
    document.getElementById('proxy-stat-accounts').textContent = assigned;
    document.getElementById('proxy-stat-unassigned').textContent = listData.unassigned_count;
    const alertEl = document.getElementById('proxy-stat-alerts');
    alertEl.textContent = alertData.alert_count;
    alertEl.style.color = alertData.alert_count > 0 ? 'var(--danger)' : '';
    const escapeEl = document.getElementById('proxy-stat-escape');
    if (escapeEl) {
        escapeEl.textContent = escapeData.rotations_24h || 0;
        escapeEl.style.color = (escapeData.rotations_24h || 0) > 0 ? 'var(--warning)' : '';
    }
}

function _renderProxyAlerts(alertData) {
    const area = document.getElementById('proxy-alerts-area');
    if (alertData.alerts.length === 0) { area.innerHTML = ''; return; }
    area.innerHTML = alertData.alerts.map(a => {
        const bg = a.severity === 'critical' ? 'rgba(248,113,113,0.15)' : 'rgba(251,191,36,0.15)';
        const border = a.severity === 'critical' ? 'var(--danger)' : '#f59e0b';
        const acctList = a.frozen_accounts.map(f => `@${f.username}`).join(', ');
        return `<div style="padding:12px;border-left:4px solid ${border};background:${bg};border-radius:6px;margin-bottom:8px;">
            <strong style="color:${border};">${a.severity === 'critical' ? '🚨' : '⚠️'} ${a.message}</strong>
            <p style="margin:4px 0 0;font-size:12px;color:var(--text-muted);">凍結アカウント: ${acctList}</p>
        </div>`;
    }).join('');
}

function _formatProxyEscapeStatus(status) {
    const map = {
        rotated: '退避済み',
        proxy_error: 'Proxyエラー',
        x_selective_failed: 'X側だけ失敗',
        x_app: 'X制限',
        success: '正常',
        skipped: '保留',
        failed: '失敗',
    };
    return map[status] || status || '-';
}

function _renderProxyEscape(escapeData) {
    const area = document.getElementById('proxy-escape-area');
    if (!area) return;
    const states = Array.isArray(escapeData.states) ? escapeData.states : [];
    const rows = states
        .filter(s => (s.consecutive_proxy_failures || 0) > 0 || s.status === 'rotated' || s.last_escape_at)
        .slice(0, 10);
    const enabledLabel = escapeData.enabled
        ? '<span class="badge badge-active" style="font-size:11px;">有効</span>'
        : '<span class="badge badge-pending" style="font-size:11px;">無効</span>';
    const killswitchLabel = escapeData.killswitch_enabled
        ? '<span class="badge badge-error" style="font-size:11px;">killswitch ON</span>'
        : '<span class="badge badge-pending" style="font-size:11px;">killswitch OFF</span>';

    area.innerHTML = `<div class="card" style="margin-bottom:16px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px;">
            <div>
                <div class="card-title" style="margin-bottom:4px;">Proxy自動退避</div>
                <div style="font-size:12px;color:var(--text-muted);">
                    Proxy層の連続失敗だけを、別Residential sessionへ退避します。226/344/locked/suspendedは対象外です。
                </div>
            </div>
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">${enabledLabel}${killswitchLabel}</div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:10px;">
            <div style="padding:10px;border:1px solid var(--border);border-radius:8px;">
                <div style="font-size:12px;color:var(--text-muted);">Proxyエラー24h</div>
                <div style="font-size:24px;font-weight:800;color:var(--warning);">${escapeData.proxy_errors_24h || 0}</div>
            </div>
            <div style="padding:10px;border:1px solid var(--border);border-radius:8px;">
                <div style="font-size:12px;color:var(--text-muted);">対象アカウント24h</div>
                <div style="font-size:24px;font-weight:800;">${escapeData.distinct_proxy_error_accounts_24h || 0}</div>
            </div>
            <div style="padding:10px;border:1px solid var(--border);border-radius:8px;">
                <div style="font-size:12px;color:var(--text-muted);">退避24h</div>
                <div style="font-size:24px;font-weight:800;">${escapeData.rotations_24h || 0}</div>
            </div>
        </div>
        ${rows.length ? `<div style="overflow-x:auto;">
            <table style="width:100%;font-size:12px;">
                <thead>
                    <tr>
                        <th>アカウント</th>
                        <th>状態</th>
                        <th>連続</th>
                        <th>24h</th>
                        <th>最終エラー</th>
                        <th>退避</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map(s => `
                        <tr>
                            <td>@${_escHtml(s.username || '')}</td>
                            <td>${_escHtml(_formatProxyEscapeStatus(s.status))}</td>
                            <td>${s.consecutive_proxy_failures || 0}</td>
                            <td>${s.proxy_failures_24h || 0}</td>
                            <td style="max-width:360px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--danger);" title="${_escAttr(s.last_error || '')}">${_escHtml(s.last_error || '-')}</td>
                            <td>${_escHtml(s.last_escape_at || '-')}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>` : `<div style="font-size:12px;color:var(--text-muted);">直近の退避対象はありません。</div>`}
    </div>`;
}

function _proxyLabel(p) {
    const name = p.display_name || '';
    const urlShort = p.proxy.length > 40 ? p.proxy.substring(0, 40) + '...' : p.proxy;
    return name ? `${name} (${urlShort})` : urlShort;
}

function _updateProxySelect(listData) {
    const sel = document.getElementById('proxy-assign-select');
    sel.innerHTML = '<option value="">-- Proxyを選択 --</option>';
    listData.proxies.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.proxy;
        opt.textContent = _proxyLabel(p) + ` [${p.account_count}アカウント]`;
        sel.appendChild(opt);
    });
}

function _renderProxyAccountList(listData) {
    const container = document.getElementById('proxy-account-list');
    // 全アカウント（割当済み＋未割当）をチェックボックスリストに表示
    const allAccounts = [];
    listData.proxies.forEach(p => {
        p.accounts.forEach(a => allAccounts.push({ ...a, proxy: p.proxy, proxyName: p.display_name }));
    });
    listData.no_proxy_accounts.forEach(a => allAccounts.push({ ...a, proxy: '', proxyName: '' }));

    container.innerHTML = allAccounts.map(a => {
        const proxyInfo = a.proxy
            ? `<span style="font-size:10px;color:var(--text-muted);margin-left:4px;">Proxy設定済</span>`
            : `<span style="font-size:10px;color:var(--warning);margin-left:4px;">未割当</span>`;
        return `<label style="display:flex;align-items:center;gap:6px;padding:4px 0;">
            <input type="checkbox" class="acct-cb-proxy-account-list" value="${a.username}" data-has-proxy="${a.proxy ? '1' : '0'}">
            ${accountAvatarHtml(a.username, 22)}
            <span style="font-size:13px;">@${a.username}</span>
            ${proxyInfo}
        </label>`;
    }).join('');
    activateLazyAvatars(container);
}

function selectUnassignedForProxy() {
    document.querySelectorAll('.acct-cb-proxy-account-list').forEach(cb => {
        cb.checked = cb.dataset.hasProxy === '0';
    });
}

function _countryFlag(code) {
    if (!code || code.length !== 2) return '';
    const cp = [...code.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65);
    return String.fromCodePoint(...cp);
}

function _renderProxyTable(listData) {
    const area = document.getElementById('proxy-table-area');
    let html = '';

    if (listData.proxies.length > 0) {
        html += '<div style="display:grid;gap:12px;">';
        listData.proxies.forEach((p, idx) => {
            const alertBadge = p.alert
                ? '<span class="badge badge-error" style="font-size:10px;margin-left:6px;">凍結多数</span>'
                : '';

            const residentialBadge = p.type === 'residential'
                ? '<span class="badge badge-active" style="font-size:10px;margin-left:6px;">Residential</span>'
                : '';

            // 国旗 + 国情報
            const flag = _countryFlag(p.country_code);
            const location = p.city && p.country ? `${p.city}, ${p.country}` : (p.country || '');
            const geoDisplay = flag
                ? `<span style="font-size:14px;margin-right:4px;" title="${location}">${flag}</span><span style="font-size:11px;color:var(--text-muted);">${location}</span>`
                : (p.ip ? '' : '<span style="font-size:10px;color:var(--text-muted);">ヘルスチェック未実行</span>');

            // 表示名（インライン編集対応）
            const eid = 'pname-' + idx;
            const nameDisplay = `<span id="${eid}" class="proxy-name-label" style="font-size:14px;font-weight:600;cursor:pointer;${p.display_name ? '' : 'color:var(--text-muted);font-style:italic;'}"
                onclick="inlineEditProxyName('${_escHtml(p.proxy)}','${eid}')"
                title="クリックで表示名を編集">${p.display_name ? _escHtml(p.display_name) : '表示名未設定 (クリックで追加)'}</span>`;

            const proxyShort = p.proxy.length > 55 ? p.proxy.substring(0, 55) + '...' : p.proxy;
            const ipDisplay = p.ip ? `<span style="font-size:10px;color:var(--text-muted);margin-left:6px;">IP: ${p.ip}</span>` : '';

            html += `<div style="border:1px solid var(--border);border-radius:8px;padding:12px;">
                <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:6px;">
                    <div style="min-width:0;flex:1;">
                        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                            ${nameDisplay}
                        </div>
                        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                            <code style="font-size:11px;background:var(--bg-dark);padding:2px 6px;border-radius:4px;">${_escHtml(proxyShort)}</code>
                            ${ipDisplay}
                            ${residentialBadge}
                            ${alertBadge}
                        </div>
                        <div style="margin-top:4px;display:flex;align-items:center;gap:4px;">
                            ${geoDisplay}
                        </div>
                    </div>
                    <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;margin-left:12px;">
                        <span style="font-size:13px;font-weight:600;">${p.account_count}アカウント</span>
                        <button
                            class="btn btn-sm btn-outline"
                            onclick="toggleProxyResidential('${_escHtml(p.proxy)}', ${p.type === 'residential' ? 'false' : 'true'})"
                            title="${p.type === 'residential' ? 'Fixed (固定IP) に変更' : 'Residential (帯域課金ゲートウェイ) に変更'}"
                            style="font-size:10px;padding:2px 8px;">
                            ${p.type === 'residential' ? '→Fixed' : '→Residential'}
                        </button>
                        <button class="btn btn-sm btn-danger" onclick="deleteProxy('${_escHtml(p.proxy)}')" title="削除" style="font-size:10px;padding:2px 6px;">✕</button>
                    </div>
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:6px;">
                    ${p.accounts.length > 0
                        ? (p.type === 'residential'
                            ? `<span style="font-size:12px;color:var(--text-muted);">Residential割当: ${p.account_count}アカウント（個別IDは非表示）</span>`
                            : p.accounts.map(a => {
                                const cls = a.status === 'active' ? 'badge-active' : a.status === 'error' ? 'badge-error' : 'badge-pending';
                                return `<span class="badge ${cls}" style="font-size:11px;display:inline-flex;align-items:center;gap:6px;padding-right:6px;">
                                    <span>@${a.username}</span>
                                    <button
                                        type="button"
                                        onclick="unassignSingleProxyAccount('${_escHtml(a.username)}')"
                                        title="@${_escHtml(a.username)} のProxy割り当てを解除"
                                        style="border:none;background:transparent;color:inherit;cursor:pointer;font-size:12px;line-height:1;padding:0;opacity:0.8;"
                                    >✕</button>
                                </span>`;
                            }).join(''))
                        : '<span style="font-size:12px;color:var(--text-muted);">割当アカウントなし</span>'}
                </div>
            </div>`;
        });
        html += '</div>';
    }

    if (listData.no_proxy_accounts.length > 0) {
        html += `<div style="margin-top:16px;padding:12px;border:1px dashed var(--border);border-radius:8px;">
            <div style="font-weight:600;margin-bottom:8px;color:var(--warning);">⚠ Proxy未設定 (${listData.no_proxy_accounts.length}アカウント)</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;">
                ${listData.no_proxy_accounts.map(a => {
                    const cls = a.status === 'active' ? 'badge-active' : a.status === 'error' ? 'badge-error' : 'badge-pending';
                    return `<span class="badge ${cls}" style="font-size:11px;">@${a.username}</span>`;
                }).join('')}
            </div>
        </div>`;
    }

    if (!html) {
        html = '<p style="color:var(--text-muted)">Proxyが登録されていません。上から追加してください。</p>';
    }

    area.innerHTML = html;
}

async function unassignSingleProxyAccount(username) {
    if (!confirm(`@${username} のProxy割り当てを解除しますか？`)) return;
    try {
        const res = await apiPost('/api/proxy/unassign', { proxy_url: '', account_ids: [username] });
        showToast(res.message, 'success');
        loadProxyDashboard();
    } catch (e) {
        showToast('解除失敗: ' + e.message, 'error');
    }
}

async function toggleProxyResidential(proxyUrl, residential) {
    const label = residential ? 'Residential' : 'Fixed';
    if (!confirm(`このProxyを ${label} に切替えますか？\n\n` +
        (residential
            ? 'Residential: アカウント割当時に session が自動注入され、1垢=固有IPになります。帯域課金プロキシ向け。'
            : 'Fixed: 通常の固定IPプロキシとして扱われます。最大10アカウント/Proxy。')
    )) return;
    try {
        const res = await apiPut('/api/proxy/type?proxy_url=' + encodeURIComponent(proxyUrl), { residential });
        showToast(res.message, 'success');
        loadProxyDashboard();
    } catch (e) {
        showToast('切替失敗: ' + e.message, 'error');
    }
}

async function importProxies() {
    const text = document.getElementById('proxy-import-text').value.trim();
    if (!text) { showToast('Proxyを入力してください', 'error'); return; }
    const proxies = text.split('\n').map(l => l.trim()).filter(l => l);
    if (proxies.length === 0) { showToast('有効なProxyがありません', 'error'); return; }
    const residential = document.getElementById('proxy-import-residential')?.checked || false;
    try {
        const res = await apiPost('/api/proxy/import', { proxies, residential });
        showToast(res.message, 'success');
        document.getElementById('proxy-import-text').value = '';
        const cb = document.getElementById('proxy-import-residential');
        if (cb) cb.checked = false;
        loadProxyDashboard();
    } catch (e) {
        showToast('追加失敗: ' + e.message, 'error');
    }
}

async function assignProxyToAccounts() {
    const proxyUrl = document.getElementById('proxy-assign-select').value;
    if (!proxyUrl) { showToast('Proxyを選択してください', 'error'); return; }
    const selected = Array.from(document.querySelectorAll('.acct-cb-proxy-account-list:checked')).map(cb => cb.value);
    if (selected.length === 0) { showToast('アカウントを選択してください', 'error'); return; }
    showProcessing('Proxy割当中...', `${selected.length}アカウントに適用しています`);
    try {
        const res = await apiPost('/api/proxy/assign', { proxy_url: proxyUrl, account_ids: selected });
        updateProcessing('Proxy割当完了', res.message, 100);
        setTimeout(() => hideProcessing(), 1200);
        showToast(res.message, 'success');
        loadProxyDashboard();
    } catch (e) {
        updateProcessing('Proxy割当失敗', e.message, 100);
        _markProcessingError();
        setTimeout(() => hideProcessing(), 2000);
        showToast('割当失敗: ' + e.message, 'error');
    }
}

async function unassignProxyFromAccounts() {
    const selected = Array.from(document.querySelectorAll('.acct-cb-proxy-account-list:checked')).map(cb => cb.value);
    if (selected.length === 0) { showToast('アカウントを選択してください', 'error'); return; }
    if (!confirm(`${selected.length}アカウントのProxy設定を解除しますか？`)) return;
    try {
        const res = await apiPost('/api/proxy/unassign', { proxy_url: '', account_ids: selected });
        showToast(res.message, 'success');
        loadProxyDashboard();
    } catch (e) {
        showToast('解除失敗: ' + e.message, 'error');
    }
}

function inlineEditProxyName(proxyUrl, spanId) {
    const span = document.getElementById(spanId);
    if (!span || span._editing) return;
    span._editing = true;

    const current = _proxyListCache?.proxies.find(p => p.proxy === proxyUrl);
    const oldName = current?.display_name || '';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = spanId;
    input.value = oldName;
    input.placeholder = '表示名を入力...';
    input.style.cssText = 'font-size:14px;font-weight:600;padding:2px 6px;border:1px solid var(--primary);border-radius:4px;background:var(--bg-dark);color:var(--text);width:200px;outline:none;';

    span.replaceWith(input);
    input.focus();
    input.select();

    let saved = false;
    const save = async () => {
        if (saved) return;
        saved = true;
        const newName = input.value.trim();

        // input → span に戻す（再描画しない）
        const newSpan = document.createElement('span');
        newSpan.id = spanId;
        newSpan.className = 'proxy-name-label';
        newSpan.setAttribute('onclick', `inlineEditProxyName('${proxyUrl.replace(/'/g,"\\'")}','${spanId}')`);
        newSpan.title = 'クリックで表示名を編集';
        newSpan.style.cssText = 'font-size:14px;font-weight:600;cursor:pointer;' + (newName ? '' : 'color:var(--text-muted);font-style:italic;');
        newSpan.textContent = newName || '表示名未設定 (クリックで追加)';
        input.replaceWith(newSpan);

        // キャッシュも更新
        if (current) current.display_name = newName;

        // API保存（バックグラウンド）
        if (newName !== oldName) {
            try {
                await apiPut(`/api/proxy/name?proxy_url=${encodeURIComponent(proxyUrl)}`, { display_name: newName });
            } catch (e) {
                showToast('表示名更新失敗: ' + e.message, 'error');
            }
        }
    };

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = oldName; input.blur(); }
    });
}

async function deleteProxy(proxyUrl) {
    if (!confirm('このProxyを削除しますか？\n(割当済みアカウントのProxy設定も解除されます)')) return;
    try {
        await apiDelete(`/api/proxy/delete?proxy_url=${encodeURIComponent(proxyUrl)}`);
        showToast('Proxyを削除しました', 'success');
        loadProxyDashboard();
    } catch (e) {
        showToast('削除失敗: ' + e.message, 'error');
    }
}

async function runProxyHealthcheck() {
    try {
        const res = await apiPost('/api/proxy/healthcheck', {});
        watchTask(res.task_id, 'Proxyヘルスチェック');
    } catch (e) {
        showToast('ヘルスチェック失敗: ' + e.message, 'error');
    }
}

// ============================================
// Proxy 自動割振
// ============================================
async function autoAssignProxies() {
    // まずプレビューを取得
    try {
        const preview = await apiGet('/api/proxy/auto-assign/preview');

        // 確認ダイアログ用のHTML構築
        let planHtml = `未割当 ${preview.unassigned_count}アカウント → ${preview.proxy_count}個のProxy（約${preview.per_proxy}アカウント/Proxy）\n\n`;
        planHtml += '【分配計画】\n';
        preview.details.forEach(d => {
            const name = d.display_name || d.proxy;
            const nameShort = name.length > 30 ? name.substring(0, 30) + '...' : name;
            const existing = d.existing_count > 0 ? `(既存${d.existing_count} + ` : '(';
            planHtml += `  ${nameShort}: ${existing}新規${d.new_count})\n`;
        });
        planHtml += '\nこの分配で実行しますか？';

        if (!confirm(planHtml)) return;

        showProcessing('自動割振中...', `${preview.unassigned_count}アカウントを分配しています`);
        const res = await apiPost('/api/proxy/auto-assign', { accounts_per_proxy: 0 });
        updateProcessing('自動割振完了', res.message, 100);
        setTimeout(() => hideProcessing(), 1500);
        showToast(res.message, 'success');
        loadProxyDashboard();
    } catch (e) {
        if (e.message) {
            showToast(e.message, 'error');
        }
        hideProcessing();
    }
}

// ============================================
// 育成工場 (Farming) — コンフィグベース
// ============================================

function _renderFarmCheckboxList(accounts) {
    const containerId = 'farm-account-list';
    const container = document.getElementById(containerId);
    container.innerHTML = accounts.map(a => {
        return `<label class="checkbox-item" style="align-items:center" data-username="${a.username}">
            <input type="checkbox" value="${a.username}" class="acct-cb-${containerId}">
            ${accountAvatarHtml(a.username, 28)}
            <span>@${a.username}</span>
            <span class="badge ${a.status === 'active' ? 'badge-active' : 'badge-pending'}" style="margin-left:auto;font-size:11px">${a.status}</span>
        </label>`;
    }).join('');
    activateLazyAvatars(container);
}

async function refreshFarmAccountList() {
    try {
        const accounts = await apiGet('/api/accounts');
        const container = document.getElementById('farm-account-list');
        container._allAccounts = accounts;
        _renderFarmCheckboxList(accounts);
    } catch (e) {
        console.error('育成工場アカウント読み込み失敗:', e);
    }
}

function switchFarmTab(name) {
    document.querySelectorAll('.farm-tab').forEach(el => el.style.display = 'none');
    document.querySelectorAll('[data-farm-tab]').forEach(b => {
        b.classList.toggle('btn-primary', b.dataset.farmTab === name);
        b.classList.toggle('btn-outline', b.dataset.farmTab !== name);
    });
    document.getElementById('farm-tab-' + name).style.display = '';
    if (name === 'configs') loadFarmingConfigs();
    if (name === 'create') refreshFarmAccountList();
    if (name === 'schedule') loadTodaySchedule();
    if (name === 'history') loadPostHistory();
    if (name === 'quarantine') loadQuarantine();
    if (name === 'resources') loadFarmingResources();
}

// ── 隔離 (Quarantine) ──

async function loadQuarantineBadge() {
    try {
        const stats = await apiGet('/api/farming/quarantine/stats');
        const badge = document.getElementById('farm-quarantine-badge');
        if (!badge) return;
        const active = (stats.active_quarantined || 0) + (stats.retired || 0);
        if (active > 0) {
            badge.textContent = active;
            badge.style.display = '';
        } else {
            badge.style.display = 'none';
        }
    } catch (e) {
        // silent
    }
}

async function loadQuarantine() {
    const area = document.getElementById('farm-quarantine-list');
    const showAll = document.getElementById('q-show-all')?.checked || false;
    area.innerHTML = '<p style="color:var(--text-muted)">読み込み中...</p>';
    try {
        const resp = await apiGet('/api/farming/quarantine?active_only=' + (!showAll));
        const records = resp.records || [];
        const stats = resp.stats || {};

        document.getElementById('q-stat-active').textContent = stats.active_quarantined || 0;
        document.getElementById('q-stat-retired').textContent = stats.retired || 0;
        document.getElementById('q-stat-total').textContent = stats.total || 0;
        const errByCode = stats.errors_by_code || {};
        document.getElementById('q-stat-226').textContent = errByCode['226'] || 0;
        const el9001 = document.getElementById('q-stat-9001');
        if (el9001) el9001.textContent = errByCode['9001'] || 0;

        loadQuarantineBadge();

        if (records.length === 0) {
            area.innerHTML = '<p style="color:var(--text-muted)">隔離中のアカウントはありません 🎉</p>';
            return;
        }

        const rows = records.map(r => {
            const strikes = r.strikes || {};
            const strikeText = Object.entries(strikes)
                .map(([code, n]) => `${code}×${n}`).join(' ') || '-';
            const lastAt = r.last_error_at ? new Date(r.last_error_at).toLocaleString('ja-JP') : '-';
            let statusBadge;
            if (r.retired) {
                statusBadge = `<span class="badge" style="background:var(--danger);color:white;">退役</span>`;
            } else if (r.quarantined_until) {
                const until = new Date(r.quarantined_until);
                const remainMs = until - new Date();
                if (remainMs > 0) {
                    const hours = (remainMs / 3600000).toFixed(1);
                    statusBadge = `<span class="badge badge-pending" style="color:var(--warning);">隔離中 (残り${hours}h)</span>`;
                } else {
                    statusBadge = `<span class="badge badge-active">期限切れ</span>`;
                }
            } else {
                statusBadge = `<span class="badge badge-active">復帰可</span>`;
            }
            const reason = r.retired_reason || '';
            const lastCode = r.last_error_code || '-';
            const removed = r.removed_from_farming_at
                ? `<small style="color:var(--text-muted);">除外日時: ${new Date(r.removed_from_farming_at).toLocaleString('ja-JP')}</small>`
                : '';

            // Proxy 情報 (国旗 + 表示名)
            let proxyCell;
            if (r.proxy_url) {
                const flag = _countryFlag(r.proxy_country_code || '');
                const country = r.proxy_country || '';
                const label = r.proxy_display_name || r.proxy_ip || '(登録外)';
                const tooltip = _esc(`${country} ${r.proxy_ip || ''}`).trim() || '未登録 Proxy';
                proxyCell = `<span title="${tooltip}" style="font-size:11px;white-space:nowrap;">
                    <span style="font-size:15px;margin-right:3px;">${flag || '🏳️'}</span>${_esc(label)}
                </span>`;
            } else {
                proxyCell = '<span style="font-size:11px;color:var(--text-muted);">Proxy なし</span>';
            }

            return `<tr>
                <td>
                    <div style="display:flex;align-items:center;gap:6px;">
                        ${accountAvatarHtml(r.username, 24)}
                        <strong>@${_esc(r.username)}</strong>
                    </div>
                </td>
                <td>${proxyCell}</td>
                <td>${statusBadge}</td>
                <td style="font-size:12px;">${lastCode}</td>
                <td style="font-size:12px;">${_esc(strikeText)}</td>
                <td style="font-size:11px;color:var(--text-muted);">${lastAt}<br>${removed}</td>
                <td style="font-size:11px;color:var(--danger);">${_esc(reason)}</td>
                <td>
                    <div class="btn-group">
                        <button class="btn btn-sm btn-outline" onclick="restoreQuarantine('${_esc(r.username)}')">復帰</button>
                        <button class="btn btn-sm btn-outline" onclick="deleteQuarantineRecord('${_esc(r.username)}')" style="color:var(--danger);">記録削除</button>
                    </div>
                </td>
            </tr>`;
        }).join('');

        area.innerHTML = `<div class="table-wrapper">
            <table>
                <thead><tr>
                    <th>アカウント</th><th>Proxy</th><th>状態</th><th>最新Code</th>
                    <th>Strike履歴</th><th>発生日時</th><th>理由</th><th>操作</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
    } catch (e) {
        area.innerHTML = `<p style="color:var(--danger)">読み込み失敗: ${e.message}</p>`;
    }
}

async function restoreQuarantine(username) {
    if (!confirm(`@${username} の隔離を解除しますか？\n\n注意: 育成コンフィグへの再追加は手動で行ってください。`)) return;
    try {
        await apiPost(`/api/farming/quarantine/${encodeURIComponent(username)}/restore`, {});
        showToast('隔離を解除しました', 'success');
        loadQuarantine();
    } catch (e) {
        showToast('解除失敗: ' + e.message, 'error');
    }
}

async function deleteQuarantineRecord(username) {
    if (!confirm(`@${username} の隔離記録を完全削除しますか？\n\n注意: Strike履歴も消えるため、次回226で1回目扱いになります。`)) return;
    try {
        await apiDelete(`/api/farming/quarantine/${encodeURIComponent(username)}`);
        showToast('記録を削除しました', 'success');
        loadQuarantine();
    } catch (e) {
        showToast('削除失敗: ' + e.message, 'error');
    }
}

// 退役アカウント(37/64)を一括削除
async function bulkDeleteRetiredQuarantine() {
    // まず対象件数を取得
    try {
        const resp = await apiGet('/api/farming/quarantine?active_only=false');
        const records = (resp.records || []).filter(r =>
            r.retired && (r.last_error_code === 37 || r.last_error_code === 64)
        );
        if (records.length === 0) {
            showToast('凍結アカウント (37/64 退役) はありません', 'info');
            return;
        }
        const names = records.map(r => '@' + r.username);
        const preview = names.slice(0, 20).join('\n') + (names.length > 20 ? `\n...他 ${names.length - 20} 件` : '');
        if (!confirm(`以下の ${records.length} 件の退役アカウントを削除しますか？\n\n${preview}\n\n行動履歴は「削除済み」タブに保存されます。`)) return;

        showProcessing('凍結アカウント一括削除中', `${records.length} 件`);
        const result = await apiPost('/api/farming/quarantine/bulk-delete-retired', {});
        hideProcessing();

        if (result.errors && result.errors.length > 0) {
            showToast(`${result.deleted}件削除、${result.errors.length}件失敗`, 'warning');
            console.warn('Bulk delete errors:', result.errors);
        } else {
            showToast(`${result.deleted} 件の凍結アカウントを削除しました`, 'success');
        }
        loadQuarantine();
        // アカウント一覧も再読み込み
        if (typeof refreshAccounts === 'function') refreshAccounts();
    } catch (e) {
        hideProcessing();
        showToast('一括削除失敗: ' + e.message, 'error');
    }
}

function updateFarmModeForm() {
    const mode = document.getElementById('farm-mode').value;
    ['random_template','template','target','unsplash'].forEach(m => {
        const el = document.getElementById('farm-fields-' + m);
        if (el) el.style.display = (m === mode) ? '' : 'none';
    });
}

function updateRandomTemplateCount() {
    const ta = document.getElementById('farm-random-templates');
    if (!ta) return;
    const items = ta.value.split(',').filter(t => t.trim());
    const span = document.getElementById('farm-random-tpl-count');
    if (span) span.textContent = items.length > 0 ? `有効テンプレート: ${items.length}件` : '';
}

async function loadTweetTemplates() {
    try {
        const res = await apiGet('/api/farming/resources/templates');
        const ta = document.getElementById('farm-random-templates');
        if (ta && res.text) {
            ta.value = res.text;
            updateRandomTemplateCount();
            showToast(`テンプレート集を読み込みました (${res.count}件)`, 'success');
        } else {
            showToast('テンプレート集が見つかりません。data/resources/tweet_templates.txt を作成してください', 'error');
        }
    } catch (e) {
        showToast('テンプレート集の読み込み失敗: ' + e.message, 'error');
    }
}

async function loadFarmingResources() {
    try {
        const vars = await apiGet('/api/farming/resources/variables');
        const container = document.getElementById('farm-variables-list');
        if (container) {
            const entries = Object.entries(vars.variables || {});
            if (entries.length === 0) {
                container.innerHTML = `<p style="color:var(--text-muted)">変数ファイルがありません。${vars.dir} に .txt ファイルを配置してください。</p>`;
            } else {
                container.innerHTML = entries.map(([key, info]) =>
                    `<div style="padding:6px 0;border-bottom:1px solid var(--border);">
                        <strong>{${key}}</strong> <span style="color:var(--text-muted)">(${info.count}件)</span>
                        <div style="font-size:12px;color:var(--text-muted)">例: ${info.sample.join(', ')}</div>
                    </div>`
                ).join('');
            }
        }
        // テンプレート作成側のヒント
        const hint = document.getElementById('farm-variables-hint');
        if (hint) {
            const keys = Object.keys(vars.variables || {});
            hint.textContent = keys.length > 0 ? `利用可能な変数: ${keys.map(k => '{'+k+'}').join(', ')}` : '変数ファイル未登録';
        }

        const ng = await apiGet('/api/farming/resources/ngwords');
        const ngEl = document.getElementById('farm-ngwords');
        if (ngEl) ngEl.value = (ng.words || []).join('\n');
    } catch (e) {
        console.error('リソース読み込み失敗:', e);
    }
}

async function saveFarmingNGWords() {
    const text = document.getElementById('farm-ngwords').value;
    const words = text.split('\n').map(s => s.trim()).filter(Boolean);
    try {
        await apiPut('/api/farming/resources/ngwords', { words });
        showToast(`NGワード ${words.length}件を保存しました`, 'success');
    } catch (e) {
        showToast(e.message, 'error');
    }
}

function _collectFarmParams() {
    const mode = document.getElementById('farm-mode').value;
    const params = {};
    if (mode === 'random_template') {
        params.templates = document.getElementById('farm-random-templates').value;
    } else if (mode === 'template') {
        params.template = document.getElementById('farm-template').value;
    } else if (mode === 'target') {
        params.target_username = document.getElementById('farm-target-username').value.trim();
        params.limit = parseInt(document.getElementById('farm-target-limit').value, 10) || 20;
    } else if (mode === 'unsplash') {
        params.keyword = document.getElementById('farm-unsplash-keyword').value.trim();
        params.caption = document.getElementById('farm-unsplash-caption').value;
    }
    return { mode, params };
}

async function previewFarming() {
    const { mode, params } = _collectFarmParams();
    try {
        const result = await apiPost('/api/farming/preview', { mode, params });
        const card = document.getElementById('farm-preview-card');
        const body = document.getElementById('farm-preview-body');
        const mediaHtml = (result.media_paths || []).length > 0
            ? `<div style="margin-top:8px;font-size:12px;color:var(--text-muted)">画像: ${result.media_paths.join(', ')}</div>`
            : '';
        const srcHtml = result.source_url
            ? `<div style="margin-top:8px;font-size:12px;color:var(--text-muted)">出典: <a href="${result.source_url}" target="_blank">${result.source_url}</a></div>`
            : '';
        const creditHtml = result.image_credit
            ? `<div style="margin-top:8px;font-size:12px;color:var(--text-muted)">${result.image_credit}</div>`
            : '';
        const chosenHtml = result.chosen_template
            ? `<div style="margin-top:8px;font-size:12px;color:var(--text-muted)">選択テンプレート: <code>${result.chosen_template.replace(/</g,'&lt;')}</code></div>`
            : '';
        body.innerHTML = `<div style="white-space:pre-wrap;padding:12px;background:var(--bg-dark);border-radius:8px;">${(result.text || '(テキストなし)').replace(/</g,'&lt;')}</div>${chosenHtml}${mediaHtml}${srcHtml}${creditHtml}`;
        card.style.display = '';
        showToast('プレビュー生成成功', 'success');
    } catch (e) {
        showToast('プレビュー失敗: ' + e.message, 'error');
    }
}

async function createFarmingConfig() {
    const { mode, params } = _collectFarmParams();
    const accountIds = getCheckedAccounts('farm-account-list');
    if (accountIds.length === 0) { showToast('アカウントを選択してください', 'error'); return; }

    const hourStart = parseInt(document.getElementById('farm-hour-start').value, 10);
    const hourEnd = parseInt(document.getElementById('farm-hour-end').value, 10);
    const slotsPerDay = parseInt(document.getElementById('farm-slots-per-day').value, 10) || 1;

    const payload = {
        name: document.getElementById('farm-name').value.trim(),
        mode, params,
        account_ids: accountIds,
        slots_per_day: slotsPerDay,
        hour_start: hourStart,
        hour_end: hourEnd,
    };

    try {
        const cfg = await apiPost('/api/farming/config', payload);
        showToast(`コンフィグ作成: ${accountIds.length}アカウント × ${slotsPerDay}回/日`, 'success');
        switchFarmTab('configs');
    } catch (e) {
        showToast('コンフィグ作成失敗: ' + e.message, 'error');
    }
}

const FARM_JOB_STATUS = {
    scheduled: '予約中', pending: '予約中', generating: '生成中',
    posted: '投稿完了', error: 'エラー', cancelled: 'キャンセル', missed: '期限切れ',
};

const FARM_MODE_LABELS = {
    random_template: 'ランダムテンプレート',
    template: 'テンプレート+変数',
    target: 'ターゲット複製',
    unsplash: 'Unsplash画像+文',
};

function _esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── コンフィグ一覧 ──

async function loadFarmingConfigs() {
    const container = document.getElementById('farm-configs-list');
    const summary = document.getElementById('farm-configs-summary');
    try {
        const configs = await apiGet('/api/farming/config');
        const enabled = configs.filter(c => c.enabled !== false).length;
        const totalAccounts = new Set(configs.flatMap(c => c.account_ids || [])).size;
        if (summary) summary.textContent = `${configs.length}件のコンフィグ (有効${enabled}) / ${totalAccounts}アカウント`;

        if (!configs || configs.length === 0) {
            container.innerHTML = '<div class="card"><p style="color:var(--text-muted)">コンフィグがありません。「新規作成」タブから作成してください。</p></div>';
            return;
        }

        container.innerHTML = configs.map(cfg => {
            const isEnabled = cfg.enabled !== false;
            const modeLabel = FARM_MODE_LABELS[cfg.mode] || cfg.mode;
            const accountCount = (cfg.account_ids || []).length;
            const slots = cfg.slots_per_day || 1;
            const todayCount = cfg.today_scheduled || 0;

            const content = _renderConfigContent(cfg);

            return `<div class="card" style="margin-bottom:10px;${isEnabled ? '' : 'opacity:0.6;'}">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
                    <div style="flex:1;">
                        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                            <strong style="font-size:14px;">${_esc(cfg.name || 'Config-' + cfg.config_id)}</strong>
                            <span class="badge badge-active" style="font-size:10px;">${modeLabel}</span>
                            ${isEnabled
                                ? `<span class="badge badge-active" style="font-size:10px;background:var(--success);">有効</span>`
                                : `<span class="badge badge-pending" style="font-size:10px;">停止中</span>`}
                        </div>
                        <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">
                            ${accountCount}アカウント | ${slots}回/日 | ${cfg.hour_start || 9}時〜${cfg.hour_end || 23}時 | 今日の予定: ${todayCount}件
                        </div>
                        ${content}
                    </div>
                    <div style="display:flex;gap:6px;flex-shrink:0;">
                        <button class="btn btn-sm ${isEnabled ? 'btn-outline' : 'btn-primary'}"
                                onclick="toggleFarmingConfig('${cfg.config_id}', ${!isEnabled})">
                            ${isEnabled ? '停止' : '有効化'}
                        </button>
                        <button class="btn btn-sm btn-danger" onclick="deleteFarmingConfig('${cfg.config_id}')">削除</button>
                    </div>
                </div>
                <div style="margin-top:8px;font-size:11px;color:var(--text-muted);">
                    対象: ${(cfg.account_ids || []).map(u => '@' + _esc(u)).join(', ')}
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        container.innerHTML = `<p style="color:var(--danger)">読み込み失敗: ${e.message}</p>`;
    }
}

function _renderConfigContent(cfg) {
    const p = cfg.params || {};
    if (cfg.mode === 'random_template') {
        const lines = (p.templates || '').split(',').filter(t => t.trim());
        const preview = lines.slice(0, 2).map(l => _esc(l.trim())).join(', ');
        return `<div style="font-size:12px;color:var(--text-muted);">テンプレ ${lines.length}件: ${preview}${lines.length > 2 ? '...' : ''}</div>`;
    }
    if (cfg.mode === 'template') {
        return `<div style="font-size:12px;color:var(--text-muted);">${_esc((p.template || '').substring(0, 80))}</div>`;
    }
    if (cfg.mode === 'target') {
        return `<div style="font-size:12px;color:var(--text-muted);">ターゲット: @${_esc(p.target_username || '')}</div>`;
    }
    if (cfg.mode === 'unsplash') {
        return `<div style="font-size:12px;color:var(--text-muted);">キーワード: ${_esc(p.keyword || '')}</div>`;
    }
    return '';
}

async function toggleFarmingConfig(configId, enabled) {
    try {
        await apiPost(`/api/farming/config/${configId}/toggle?enabled=${enabled}`);
        showToast(enabled ? 'コンフィグを有効化しました' : 'コンフィグを停止しました', 'success');
        loadFarmingConfigs();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function deleteFarmingConfig(configId) {
    if (!confirm('このコンフィグを削除しますか？')) return;
    try {
        await apiDelete(`/api/farming/config/${configId}`);
        showToast('コンフィグを削除しました', 'success');
        loadFarmingConfigs();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// ── 今日の予定 ──

async function loadTodaySchedule() {
    const container = document.getElementById('farm-today-schedule');
    const summary = document.getElementById('farm-schedule-summary');
    try {
        const resp = await apiGet('/api/farming/schedule/today');
        const jobs = resp.jobs || [];
        if (summary) summary.textContent = `今日の予定: ${jobs.length}件`;

        if (jobs.length === 0) {
            container.innerHTML = '<div class="card"><p style="color:var(--text-muted)">今日の予定はありません。コンフィグを作成するか「再スケジュール」を押してください。</p></div>';
            return;
        }

        const rows = jobs.map(j => {
            const time = (j.run_at || '').substring(11, 16) || '--:--';
            const mode = j.mode || '';
            // 画像付き判定: unsplash モードのみ画像を生成する
            const mediaCell = j.has_image
                ? `<span title="${_esc(mode)} — 画像付き" style="font-size:14px;">🖼️</span>`
                : `<span title="${_esc(mode) || 'テキストのみ'}" style="font-size:12px;color:var(--text-muted);">—</span>`;
            return `<tr>
                <td style="font-size:13px;white-space:nowrap;font-weight:600;">${time}</td>
                <td style="font-size:13px;">@${_esc(j.username)}</td>
                <td style="text-align:center;">${mediaCell}</td>
                <td style="font-size:12px;color:var(--text-muted);">${_esc(j.config_id)}</td>
            </tr>`;
        }).join('');

        const withImage = jobs.filter(j => j.has_image).length;
        const textOnly = jobs.length - withImage;

        container.innerHTML = `<div class="card">
            <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px 0;">
                🖼️ 画像付き: ${withImage}件 / — テキスト: ${textOnly}件
            </p>
            <div class="table-wrapper">
                <table>
                    <thead><tr><th>予定時刻</th><th>アカウント</th><th style="text-align:center;">画像</th><th>コンフィグID</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>`;
    } catch (e) {
        container.innerHTML = `<p style="color:var(--danger)">読み込み失敗: ${e.message}</p>`;
    }
}

async function replanToday() {
    try {
        const resp = await apiPost('/api/farming/schedule/replan');
        showToast(`${resp.count}件のジョブを再スケジュールしました`, 'success');
        loadTodaySchedule();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// ============================================
// ロジック比較
// ============================================
let _logicComparisonState = null;

function _logicNum(value) {
    const n = Number(value || 0);
    return Number.isFinite(n) ? n.toLocaleString() : '0';
}

function _logicGroupLabel(key) {
    return key === 'daily_image' ? '毎日+画像' : '現行';
}

function _logicSummaryCard(title, summary, accent) {
    const total = summary?.total || 0;
    const ok = summary?.search_full_ok || 0;
    const latest = summary?.latest_post_ok || 0;
    const sensitive = summary?.sensitive_limited || 0;
    const posted7d = summary?.posted_7d || 0;
    return `<div class="stat-card">
        <div class="stat-value" style="color:${accent};">${_logicNum(ok)} / ${_logicNum(total)}</div>
        <div class="stat-label">${_esc(title)} 検索完全OK</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:8px;">
            最新OK ${_logicNum(latest)} / センシ ${_logicNum(sensitive)} / 7日投稿 ${_logicNum(posted7d)}
        </div>
    </div>`;
}

function _renderLogicComparisonStats(live) {
    const area = document.getElementById('logic-comparison-stats');
    if (!area) return;
    const current = live?.groups?.current?.summary || {};
    const exp = live?.groups?.daily_image?.summary || {};
    const expJobs = (_logicComparisonState?.comparison_job_count || 0);
    area.innerHTML = [
        _logicSummaryCard('現行ロジック', current, 'var(--success)'),
        _logicSummaryCard('毎日+画像', exp, '#60a5fa'),
        `<div class="stat-card">
            <div class="stat-value">${_logicNum(expJobs)}</div>
            <div class="stat-label">今日の実験予定</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:8px;">
                実験適用中: ${_logicComparisonState?.state?.enabled ? 'ON' : 'OFF'}
            </div>
        </div>`,
        `<div class="stat-card">
            <div class="stat-value">${_logicNum(_logicComparisonState?.candidate_count || 0)}</div>
            <div class="stat-label">割当候補</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:8px;">
                active / sessionあり / 未Export
            </div>
        </div>`,
    ].join('');
}

function _logicDailyRow(snapshot) {
    const current = snapshot?.groups?.current?.summary || {};
    const exp = snapshot?.groups?.daily_image?.summary || {};
    const date = snapshot?.date || '-';
    const captured = (snapshot?.captured_at || '').replace('T', ' ').substring(0, 16);
    return `<tr>
        <td style="font-weight:700;">${_esc(date)}</td>
        <td>${_logicNum(current.search_full_ok)} / ${_logicNum(current.total)}</td>
        <td>${_logicNum(exp.search_full_ok)} / ${_logicNum(exp.total)}</td>
        <td>${_logicNum(current.latest_post_ok)}</td>
        <td>${_logicNum(exp.latest_post_ok)}</td>
        <td>${_logicNum(current.sensitive_limited)}</td>
        <td>${_logicNum(exp.sensitive_limited)}</td>
        <td>${_logicNum(current.posted_7d)} / ${_logicNum(exp.posted_7d)}</td>
        <td style="color:var(--text-muted);">${_esc(captured)}</td>
    </tr>`;
}

function _renderLogicComparisonDaily(state) {
    const area = document.getElementById('logic-comparison-daily');
    if (!area) return;
    const snapshots = state?.daily_snapshots || [];
    if (!snapshots.length) {
        area.innerHTML = '<p style="color:var(--text-muted);margin:0;">記録はまだありません。</p>';
        return;
    }
    area.innerHTML = `<div class="table-wrapper">
        <table>
            <thead>
                <tr>
                    <th>日付</th>
                    <th>現行 検索OK</th>
                    <th>毎日+画像 検索OK</th>
                    <th>現行 最新OK</th>
                    <th>毎日+画像 最新OK</th>
                    <th>現行 センシ</th>
                    <th>毎日+画像 センシ</th>
                    <th>7日投稿 現行/実験</th>
                    <th>記録時刻</th>
                </tr>
            </thead>
            <tbody>${snapshots.map(_logicDailyRow).join('')}</tbody>
        </table>
    </div>`;
}

function _logicStatusBadge(row) {
    if (row.suspended || row.not_found) return '<span class="badge badge-error">除外</span>';
    if (row.search_full_ok) return '<span class="badge badge-active">検索OK</span>';
    if (row.sensitive_limited) return '<span class="badge badge-pending">センシ</span>';
    if (row.search_ban) return '<span class="badge badge-pending">検索なし</span>';
    return '<span class="badge badge-pending">未完全</span>';
}

function _renderLogicComparisonAccounts(live) {
    const area = document.getElementById('logic-comparison-accounts');
    if (!area) return;
    const rows = [];
    for (const key of ['current', 'daily_image']) {
        const accounts = live?.groups?.[key]?.accounts || [];
        accounts.forEach(row => rows.push({ ...row, group_key: key }));
    }
    if (!rows.length) {
        area.innerHTML = '<p style="color:var(--text-muted);margin:0;">まだ比較アカウントが割り当てられていません。</p>';
        return;
    }
    area.innerHTML = `<div class="table-wrapper">
        <table>
            <thead>
                <tr>
                    <th>グループ</th>
                    <th>アカウント</th>
                    <th>検索状態</th>
                    <th>最新OK</th>
                    <th>投稿 7日/今日</th>
                    <th>最終履歴</th>
                    <th>エラー</th>
                </tr>
            </thead>
            <tbody>
                ${rows.map(row => {
                    const latest = row.latest_post_ok ? '<span class="badge badge-active">OK</span>' : '<span class="badge badge-pending">-</span>';
                    const lastAt = (row.last_history_at || row.latest_post_run_at || '').replace('T', ' ').substring(0, 16) || '-';
                    return `<tr>
                        <td>${_esc(_logicGroupLabel(row.group_key))}</td>
                        <td style="font-weight:700;">@${_esc(row.username)}</td>
                        <td>${_logicStatusBadge(row)} <span style="color:var(--text-muted);font-size:12px;">${_esc(row.search_status || '')}</span></td>
                        <td>${latest}</td>
                        <td>${_logicNum(row.posted_7d)} / ${_logicNum(row.posted_today)}</td>
                        <td>
                            <span style="font-weight:600;">${_esc(row.last_history_status || '-')}</span>
                            <span style="color:var(--text-muted);font-size:12px;">${_esc(lastAt)}</span>
                        </td>
                        <td style="max-width:360px;color:var(--danger);font-size:12px;">${_esc(row.last_history_error || '')}</td>
                    </tr>`;
                }).join('')}
            </tbody>
        </table>
    </div>`;
}

function _renderLogicComparison(data) {
    _logicComparisonState = data || {};
    const state = data?.state || {};
    const status = document.getElementById('logic-comparison-status');
    const intervalInput = document.getElementById('logic-image-interval');
    if (intervalInput && state.image_interval_days) {
        intervalInput.value = state.image_interval_days;
    }
    const currentCount = state?.groups?.current?.usernames?.length || 0;
    const expCount = state?.groups?.daily_image?.usernames?.length || 0;
    if (status) {
        const applied = state.enabled ? `適用中 / 実験予定 ${_logicNum(data.comparison_job_count || 0)}件` : '未適用';
        status.textContent = `現行 ${currentCount}件 / 毎日+画像 ${expCount}件 / ${applied}`;
    }
    _renderLogicComparisonStats(data?.live);
    _renderLogicComparisonDaily(state);
    _renderLogicComparisonAccounts(data?.live);
}

async function loadLogicComparison() {
    const status = document.getElementById('logic-comparison-status');
    if (status) status.textContent = '読み込み中...';
    try {
        const data = await apiGet('/api/logic-comparison/state');
        _renderLogicComparison(data);
    } catch (e) {
        if (status) status.textContent = `読み込み失敗: ${e.message}`;
        showToast(`ロジック比較の読み込み失敗: ${e.message}`, 'error');
    }
}

async function initializeLogicComparison(reset) {
    if (reset && !confirm('比較アカウントを再割当しますか？既存の比較グループは上書きされます。')) return;
    const interval = parseInt(document.getElementById('logic-image-interval')?.value || '3', 10) || 3;
    showProcessing(reset ? 'ロジック比較を再割当中' : 'ロジック比較を割当中', '候補から20件を選定しています', 20, 'logic-comparison');
    try {
        const result = await apiPost('/api/logic-comparison/initialize', {
            current_count: 10,
            experiment_count: 10,
            image_interval_days: interval,
            reset: !!reset,
        });
        updateProcessing('ロジック比較を割当中', 'スナップショットを保存しました', 100, 'logic-comparison');
        setTimeout(() => hideProcessing('logic-comparison'), 700);
        showToast(result.reused ? '既存の比較セットを読み込みました' : '比較セットを作成しました', 'success');
        await loadLogicComparison();
    } catch (e) {
        _markProcessingError('logic-comparison');
        setTimeout(() => hideProcessing('logic-comparison'), 1200);
        showToast(`割当失敗: ${e.message}`, 'error');
    }
}

async function applyLogicComparison() {
    if (!confirm('実験群10件を共通育成プランから外し、毎日テキスト + 周期画像の専用ロジックへ切り替えますか？')) return;
    showProcessing('ロジック比較を適用中', '専用コンフィグを作成して再スケジュールしています', 35, 'logic-comparison');
    try {
        const result = await apiPost('/api/logic-comparison/apply', { replan: true });
        updateProcessing('ロジック比較を適用中', `${result.planned || 0}件をスケジュールしました`, 100, 'logic-comparison');
        setTimeout(() => hideProcessing('logic-comparison'), 700);
        showToast('実験設定を適用しました', 'success');
        await loadLogicComparison();
    } catch (e) {
        _markProcessingError('logic-comparison');
        setTimeout(() => hideProcessing('logic-comparison'), 1200);
        showToast(`適用失敗: ${e.message}`, 'error');
    }
}

async function captureLogicComparison() {
    showProcessing('ロジック比較を記録中', '現在の状態を保存しています', 60, 'logic-comparison-capture');
    try {
        await apiPost('/api/logic-comparison/capture', {});
        updateProcessing('ロジック比較を記録中', '保存しました', 100, 'logic-comparison-capture');
        setTimeout(() => hideProcessing('logic-comparison-capture'), 700);
        showToast('今日の状態を記録しました', 'success');
        await loadLogicComparison();
    } catch (e) {
        _markProcessingError('logic-comparison-capture');
        setTimeout(() => hideProcessing('logic-comparison-capture'), 1200);
        showToast(`記録失敗: ${e.message}`, 'error');
    }
}

async function disableLogicComparison() {
    if (!confirm('ロジック比較の実験設定を停止し、実験群を共通育成プランへ戻しますか？')) return;
    showProcessing('ロジック比較を停止中', '専用コンフィグを削除して再スケジュールしています', 40, 'logic-comparison');
    try {
        const result = await apiPost('/api/logic-comparison/disable', { replan: true });
        updateProcessing('ロジック比較を停止中', `${result.planned || 0}件をスケジュールしました`, 100, 'logic-comparison');
        setTimeout(() => hideProcessing('logic-comparison'), 700);
        showToast('実験設定を停止しました', 'success');
        await loadLogicComparison();
    } catch (e) {
        _markProcessingError('logic-comparison');
        setTimeout(() => hideProcessing('logic-comparison'), 1200);
        showToast(`停止失敗: ${e.message}`, 'error');
    }
}

// ============================================
// 投稿履歴
// ============================================
let _postHistoryCache = null;
let _postHistoryPage = 1;
const _POST_HISTORY_PER_PAGE = 50;

async function loadPostHistory() {
    const area = document.getElementById('history-table-area');
    area.innerHTML = '<p style="color:var(--text-muted)">読み込み中...</p>';
    try {
        const resp = await apiGet('/api/farming/history?limit=500');
        _postHistoryCache = resp;
        _postHistoryPage = 1;
        _updateHistoryStats(resp);
        _updateHistoryAccountFilter(resp);
        filterPostHistory();
    } catch (e) {
        area.innerHTML = `<p style="color:var(--danger)">読み込みエラー: ${e.message}</p>`;
    }
}

function _updateHistoryStats(resp) {
    document.getElementById('history-stat-total').textContent = resp.total || 0;
    document.getElementById('history-stat-posted').textContent = resp.posted || 0;
    document.getElementById('history-stat-errors').textContent = resp.errors || 0;
    const acctCount = resp.account_counts ? Object.keys(resp.account_counts).length : 0;
    document.getElementById('history-stat-accounts').textContent = acctCount;
}

function _updateHistoryAccountFilter(resp) {
    const sel = document.getElementById('history-filter-account');
    const current = sel.value;
    sel.innerHTML = '<option value="">全アカウント</option>';
    if (resp.account_counts) {
        // 投稿数が多い順
        const sorted = Object.entries(resp.account_counts).sort((a, b) => b[1] - a[1]);
        sorted.forEach(([username, count]) => {
            const opt = document.createElement('option');
            opt.value = username;
            opt.textContent = `@${username} (${count}件)`;
            sel.appendChild(opt);
        });
    }
    sel.value = current;
}

function filterPostHistory() {
    if (!_postHistoryCache) return;
    const account = document.getElementById('history-filter-account').value;
    const status = document.getElementById('history-filter-status').value;
    const mode = document.getElementById('history-filter-mode').value;
    const search = document.getElementById('history-filter-search').value.trim().toLowerCase();

    let items = _postHistoryCache.history || [];

    if (account) items = items.filter(h => h.username === account);
    if (status) items = items.filter(h => h.status === status);
    if (mode) items = items.filter(h => h.mode === mode);
    if (search) items = items.filter(h =>
        (h.text || '').toLowerCase().includes(search) ||
        (h.username || '').toLowerCase().includes(search) ||
        (h.error || '').toLowerCase().includes(search)
    );

    _postHistoryPage = 1;
    _renderPostHistory(items);
}

function _historyActionView(h) {
    const isFollowback = h.action_type === 'internal_followback' || h.mode === 'internal_followback';
    if (isFollowback) {
        const target = h.target ? `@${_esc(h.target)}` : '対象アカウント';
        const labels = {
            mutual: '相互フォロー完了',
            skipped: '相互フォロースキップ',
            deferred: '相互フォロー延期',
            failed: '相互フォロー失敗',
        };
        return {
            statusCls: h.status === 'mutual' ? 'active' : h.status === 'failed' ? 'error' : 'pending',
            statusLabel: labels[h.status] || _esc(h.status || '相互フォロー'),
            modeLabel: '相互フォロー',
            textContent: `<span style="color:var(--text-muted);">投稿なし: ${target} へのフォロー返し処理</span>`,
            mediaInfo: '',
        };
    }
    return null;
}

function _renderPostHistory(items) {
    const area = document.getElementById('history-table-area');
    const pagArea = document.getElementById('history-pagination');

    if (items.length === 0) {
        area.innerHTML = '<div class="card"><p style="color:var(--text-muted)">該当する投稿履歴がありません</p></div>';
        pagArea.innerHTML = '';
        return;
    }

    // ページネーション
    const totalPages = Math.ceil(items.length / _POST_HISTORY_PER_PAGE);
    const start = (_postHistoryPage - 1) * _POST_HISTORY_PER_PAGE;
    const pageItems = items.slice(start, start + _POST_HISTORY_PER_PAGE);

    // 日付グループ化
    const groups = {};
    pageItems.forEach(h => {
        const date = (h.run_at || '').substring(0, 10) || '日付不明';
        if (!groups[date]) groups[date] = [];
        groups[date].push(h);
    });

    const today = new Date().toISOString().substring(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().substring(0, 10);

    let html = '';
    for (const [date, jobs] of Object.entries(groups)) {
        let dateLabel = date;
        if (date === today) dateLabel += '（今日）';
        else if (date === yesterday) dateLabel += '（昨日）';

        const postedCount = jobs.filter(j => j.status === 'posted').length;
        const errorCount = jobs.filter(j => j.status === 'error').length;
        const dateSummary = [
            postedCount > 0 ? `成功${postedCount}` : '',
            errorCount > 0 ? `失敗${errorCount}` : '',
        ].filter(Boolean).join(' / ');

        const rows = jobs.map(h => {
            const time = (h.run_at || '').substring(11, 16) || '--:--';
            const actionView = _historyActionView(h);
            const statusCls = actionView?.statusCls || (h.status === 'posted' ? 'active' : h.status === 'error' ? 'error' : 'pending');
            const statusLabel = actionView?.statusLabel || FARM_JOB_STATUS[h.status] || h.status;
            const modeLabel = actionView?.modeLabel || FARM_MODE_LABELS[h.mode] || h.mode || '';
            const textContent = actionView?.textContent || (h.text
                ? _esc(h.text)
                : '<span style="color:var(--text-muted);">(テキストなし)</span>');
            const err = h.error
                ? `<div style="font-size:11px;color:var(--danger);margin-top:2px;word-break:break-word;">${_esc(h.error)}</div>`
                : '';
            const mediaInfo = actionView?.mediaInfo || ((h.media && h.media.length > 0)
                ? `<span style="font-size:10px;color:var(--accent);margin-left:4px;" title="${_esc(h.media.join(', '))}">📎${h.media.length}</span>`
                : '');
            return `<tr>
                <td style="font-size:12px;white-space:nowrap;font-weight:600;vertical-align:top;">${time}</td>
                <td style="font-size:12px;white-space:nowrap;vertical-align:top;">
                    <div style="display:flex;align-items:center;gap:4px;">
                        ${accountAvatarHtml(h.username, 20)}
                        <span>@${_esc(h.username)}</span>
                    </div>
                </td>
                <td style="vertical-align:top;"><span class="badge badge-${statusCls}">${statusLabel}</span></td>
                <td style="font-size:12px;color:var(--text-muted);white-space:nowrap;vertical-align:top;">${_esc(modeLabel)}</td>
                <td style="font-size:12px;max-width:450px;word-break:break-word;vertical-align:top;">${textContent}${mediaInfo}${err}</td>
            </tr>`;
        }).join('');

        html += `<div class="card" style="margin-bottom:8px;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                <strong style="font-size:14px;">${dateLabel}</strong>
                <span style="font-size:12px;color:var(--text-muted);">${jobs.length}件${dateSummary ? ' (' + dateSummary + ')' : ''}</span>
            </div>
            <div class="table-wrapper">
                <table>
                    <thead><tr><th>時刻</th><th>アカウント</th><th>状態</th><th>モード</th><th>ツイート内容</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>`;
    }

    // 件数表示
    html = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">
        ${items.length}件中 ${start + 1}〜${Math.min(start + _POST_HISTORY_PER_PAGE, items.length)}件を表示
    </div>` + html;

    area.innerHTML = html;

    // ページネーション
    if (totalPages <= 1) {
        pagArea.innerHTML = '';
        return;
    }
    let pagHtml = '';
    pagHtml += `<button class="btn btn-sm btn-outline" ${_postHistoryPage <= 1 ? 'disabled' : ''} onclick="_postHistoryGoPage(${_postHistoryPage - 1}, _lastHistoryItems)">前へ</button>`;
    // ページ番号
    const maxShow = 7;
    let pStart = Math.max(1, _postHistoryPage - Math.floor(maxShow / 2));
    let pEnd = Math.min(totalPages, pStart + maxShow - 1);
    if (pEnd - pStart < maxShow - 1) pStart = Math.max(1, pEnd - maxShow + 1);
    for (let p = pStart; p <= pEnd; p++) {
        const cls = p === _postHistoryPage ? 'btn-primary' : 'btn-outline';
        pagHtml += `<button class="btn btn-sm ${cls}" onclick="_postHistoryGoPage(${p}, _lastHistoryItems)">${p}</button>`;
    }
    pagHtml += `<button class="btn btn-sm btn-outline" ${_postHistoryPage >= totalPages ? 'disabled' : ''} onclick="_postHistoryGoPage(${_postHistoryPage + 1}, _lastHistoryItems)">次へ</button>`;
    pagHtml += `<span style="font-size:11px;color:var(--text-muted);margin-left:8px;">${totalPages}ページ中 ${_postHistoryPage}ページ</span>`;
    pagArea.innerHTML = pagHtml;

    // フィルタ結果のアイテムをグローバルに保持（ページ遷移用）
    window._lastHistoryItems = items;
}

function _postHistoryGoPage(page, items) {
    if (!items || page < 1) return;
    const totalPages = Math.ceil(items.length / _POST_HISTORY_PER_PAGE);
    if (page > totalPages) return;
    _postHistoryPage = page;
    _renderPostHistory(items);
    // スクロール
    document.getElementById('history-table-area')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}


// ============================================
// エクスポート
// ============================================

let _exportPreviewCache = null;
let _exportHistoryCache = null;
let _exportPerfectMode = false;

async function initExportPage() {
    await loadExportStats();
    loadExportHistory();
}

async function loadExportStats() {
    try {
        const stats = await apiGet('/api/export/stats');
        document.getElementById('export-stat-total').textContent = stats.total || 0;
        document.getElementById('export-stat-remaining').textContent = stats.remaining || 0;
        document.getElementById('export-stat-exported').textContent = stats.exported || 0;
        document.getElementById('export-stat-clean').textContent = `${stats.clean || 0} / ${stats.checked || 0}`;

        // 年セレクタ構築
        const years = stats.years || {};
        const yearKeys = Object.keys(years).map(Number).sort();
        ['export-year-from', 'export-year-to'].forEach(id => {
            const sel = document.getElementById(id);
            const cur = sel.value;
            sel.innerHTML = '<option value="">指定なし</option>';
            yearKeys.forEach(y => {
                const opt = document.createElement('option');
                opt.value = y;
                opt.textContent = `${y}年 (${years[y]}件)`;
                sel.appendChild(opt);
            });
            sel.value = cur;
        });

        const proxySel = document.getElementById('export-proxy');
        if (proxySel) {
            const cur = proxySel.value;
            const proxyOptions = stats.proxy_options || [];
            proxySel.innerHTML = '<option value="">全て</option>';
            const noProxyOpt = document.createElement('option');
            noProxyOpt.value = '__no_proxy__';
            noProxyOpt.textContent = `Proxyなし (${stats.no_proxy_count || 0}件)`;
            proxySel.appendChild(noProxyOpt);
            proxyOptions.forEach(proxy => {
                const opt = document.createElement('option');
                opt.value = proxy.value || '';
                const name = proxy.label || proxy.display_name || proxy.country_code || proxy.value || 'Proxy';
                opt.textContent = `${name} (${proxy.count || 0}件)`;
                opt.title = proxy.value || '';
                proxySel.appendChild(opt);
            });
            proxySel.value = Array.from(proxySel.options).some(opt => opt.value === cur) ? cur : '';
        }
    } catch (e) {
        console.error('Export stats load failed:', e);
    }
}

function _parseExportIds(text) {
    const seen = new Set();
    return String(text || '')
        .split(/[\s,]+/)
        .map(v => v.trim())
        .filter(Boolean)
        .map(v => v.replace(/^https?:\/\//, '').replace(/^(x\.com|twitter\.com)\//, '').split(/[/?#]/)[0].replace(/^@/, ''))
        .filter(v => {
            const key = v.toLowerCase();
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

function _escAttr(s) {
    return _esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _collectExportFilters() {
    const yearFrom = document.getElementById('export-year-from').value;
    const yearTo = document.getElementById('export-year-to').value;
    const shadowban = document.getElementById('export-shadowban').value;
    const status = document.getElementById('export-status').value;
    const proxyFilter = document.getElementById('export-proxy')?.value || '';
    const excludeExported = document.getElementById('export-exclude-exported').checked;
    const limitVal = document.getElementById('export-limit').value;
    const usernames = _parseExportIds(document.getElementById('export-usernames')?.value || '');

    const sort1 = document.getElementById('export-sort1').value;
    const sort2 = document.getElementById('export-sort2').value;
    const sortParts = [sort1, sort2].filter(Boolean);

    return {
        year_from: yearFrom ? parseInt(yearFrom) : null,
        year_to: yearTo ? parseInt(yearTo) : null,
        clean_only: shadowban === 'clean',
        search_ok_only: shadowban === 'search_ok',
        latest_post_latest_ok_only: shadowban === 'latest_post_latest_ok',
        status_filter: status || null,
        proxy_filter: proxyFilter || null,
        exclude_exported: excludeExported,
        sort_by: sortParts.length > 0 ? sortParts.join(',') : null,
        limit: limitVal ? parseInt(limitVal) : null,
        usernames,
        perfect_account_only: _exportPerfectMode,
        warmup_done_min_days: _exportPerfectMode ? 10 : null,
        xpilot_tweet_history_only: _exportPerfectMode,
        iproyal_residential_only: _exportPerfectMode,
    };
}

async function previewExport(options = {}) {
    if (options.perfectMode === true) _exportPerfectMode = true;
    if (options.perfectMode === false) _exportPerfectMode = false;
    const filters = _collectExportFilters();
    const area = document.getElementById('export-preview-area');
    const countEl = document.getElementById('export-preview-count');
    area.innerHTML = '<p style="color:var(--text-muted)">読み込み中...</p>';

    try {
        const resp = await apiPost('/api/export/preview', filters);
        _exportPreviewCache = resp;
        const accounts = resp.accounts || [];
        const totalMatched = resp.total_matched || accounts.length;
        if (totalMatched > accounts.length) {
            countEl.textContent = `${accounts.length}件 / ${totalMatched}件中`;
        } else {
            countEl.textContent = `${accounts.length}件`;
        }
        const missing = resp.missing_usernames || [];
        const missingHtml = missing.length
            ? `<div style="font-size:11px;color:var(--warning);margin-bottom:8px;">未発見ID: ${missing.map(_esc).join(', ')}</div>`
            : '';

        if (accounts.length === 0) {
            area.innerHTML = `${missingHtml}<p style="color:var(--text-muted)">条件に合うアカウントがありません</p>`;
            document.getElementById('export-execute-btn').disabled = true;
            document.getElementById('export-remove-only-btn').disabled = true;
            return;
        }

        const rows = accounts.map((a, i) => {
            const label = a.ban_label || 'unchecked';
            let cleanBadge;
            if (label === 'clean') {
                cleanBadge = '<span class="badge badge-active" style="font-size:9px;">OK</span>';
            } else if (label === 'search_ok') {
                cleanBadge = '<span class="badge badge-active" style="font-size:9px;">検索完全OK</span>';
            } else if (label === 'unchecked') {
                cleanBadge = '<span class="badge badge-pending" style="font-size:9px;">未確認</span>';
            } else if (label === 'suspended') {
                cleanBadge = '<span class="badge badge-pending" style="font-size:9px;color:var(--danger);">凍結</span>';
            } else if (label === 'not_found') {
                cleanBadge = '<span class="badge badge-pending" style="font-size:9px;color:var(--danger);">不明</span>';
            } else {
                cleanBadge = `<span class="badge badge-pending" style="font-size:9px;color:var(--danger);">${_esc(label)}</span>`;
            }
            const year = a.created_year || '-';
            const followers = a.followers_count != null ? a.followers_count.toLocaleString() : '-';
            const tweets = a.statuses_count != null ? a.statuses_count.toLocaleString() : '-';
            const extras = [
                a.has_2fa ? '2FA' : '',
                a.has_mail_pw ? 'MailPW' : '',
                a.has_auth_token ? 'Token' : '',
            ].filter(Boolean).join(' ');
            const proxyTitle = a.proxy || '';
            const proxyLabel = a.proxy_label || a.proxy_display_name || a.proxy_country_code || (a.proxy ? '設定あり' : '');
            const proxyCell = proxyLabel
                ? `<span title="${_escAttr(proxyTitle)}" style="font-size:11px;color:var(--text-muted);display:inline-block;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(proxyLabel)}</span>`
                : '<span style="color:var(--text-muted);font-size:11px;">-</span>';
            const usernameAttr = _escAttr(a.username);
            const latestPostCell = _exportLatestPostBadge(a);

            return `<tr>
                <td style="font-size:12px;">${i + 1}</td>
                <td style="font-size:12px;">
                    <div style="display:flex;align-items:center;gap:4px;">
                        ${accountAvatarHtml(a.username, 20)}
                        <button onclick="showExportAccountDetail('${usernameAttr}')" title="アカウント情報を表示" style="border:none;background:transparent;color:var(--primary);padding:0;cursor:pointer;font-size:12px;">@${_esc(a.username)}</button>
                    </div>
                </td>
                <td style="font-size:12px;">${year}</td>
                <td style="font-size:12px;">${cleanBadge}</td>
                <td style="font-size:12px;">${latestPostCell}</td>
                <td style="font-size:12px;">${proxyCell}</td>
                <td style="font-size:12px;text-align:right;">${followers}</td>
                <td style="font-size:12px;text-align:right;">${tweets}</td>
                <td style="font-size:11px;color:var(--text-muted);">${extras}</td>
            </tr>`;
        }).join('');

        area.innerHTML = `${missingHtml}<div class="table-wrapper">
            <table>
                <thead><tr>
                    <th>#</th><th>アカウント</th><th>作成年</th>
                    <th>BAN</th><th>最新投稿</th><th>Proxy</th><th style="text-align:right;">フォロワー</th>
                    <th style="text-align:right;">ツイート</th><th>保有データ</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;

        document.getElementById('export-execute-btn').disabled = false;
        document.getElementById('export-remove-only-btn').disabled = false;
    } catch (e) {
        area.innerHTML = `<p style="color:var(--danger)">${e.message}</p>`;
        document.getElementById('export-execute-btn').disabled = true;
        document.getElementById('export-remove-only-btn').disabled = true;
    }
}

function _clearExportPreview(message) {
    _exportPreviewCache = null;
    const area = document.getElementById('export-preview-area');
    const countEl = document.getElementById('export-preview-count');
    if (area) {
        area.innerHTML = `<p style="color:var(--text-muted)">${_esc(message || '「プレビュー」を押すと対象アカウントが表示されます')}</p>`;
    }
    if (countEl) countEl.textContent = '';
    const executeBtn = document.getElementById('export-execute-btn');
    const removeOnlyBtn = document.getElementById('export-remove-only-btn');
    if (executeBtn) executeBtn.disabled = true;
    if (removeOnlyBtn) removeOnlyBtn.disabled = true;
}

function _selectPerfectExportProxy() {
    const proxySel = document.getElementById('export-proxy');
    if (!proxySel) return;
    const match = Array.from(proxySel.options).find(opt => {
        const text = `${opt.value || ''} ${opt.textContent || ''}`.toLowerCase();
        return text.includes('iproyal') && (
            text.includes('residential') ||
            text.includes('rasidential') ||
            text.includes('geo.iproyal.com')
        );
    });
    proxySel.value = match ? match.value : '';
}

function previewPerfectExport() {
    _exportPerfectMode = true;
    document.getElementById('export-year-from').value = '';
    document.getElementById('export-year-to').value = '';
    document.getElementById('export-shadowban').value = 'latest_post_latest_ok';
    document.getElementById('export-status').value = 'active';
    _selectPerfectExportProxy();
    const usernamesEl = document.getElementById('export-usernames');
    if (usernamesEl) usernamesEl.value = '';
    document.getElementById('export-exclude-exported').checked = true;
    document.getElementById('export-sort1').value = 'created_year';
    document.getElementById('export-sort2').value = 'username';
    document.getElementById('export-limit').value = '';
    _clearExportPreview('完璧アカウント条件を入力しました。「プレビュー」を押すと対象アカウントが表示されます');
    showToast('完璧アカウント条件を入力しました。プレビューで抽出します', 'info');
}

function _exportLatestPostBadge(a) {
    if (!a.latest_post_tweet_id) {
        return '<span class="badge badge-pending" style="font-size:9px;">投稿なし</span>';
    }
    if (a.latest_post_search_hit) {
        const modeMap = {
            latest: '最新',
            top: '話題',
            both: '話題/最新',
            top_latest: '話題/最新',
        };
        const mode = modeMap[a.latest_post_search_mode] || '話題';
        const cls = ['latest', 'both', 'top_latest'].includes(String(a.latest_post_search_mode || ''))
            ? 'badge-active'
            : 'badge-pending';
        return `<span class="badge ${cls}" style="font-size:9px;">検索OK(${mode})</span>`;
    }
    if (!a.latest_post_search_checked) {
        return '<span class="badge badge-pending" style="font-size:9px;">未チェック</span>';
    }
    return '<span class="badge badge-warning" style="font-size:9px;">反映なし</span>';
}

async function executeExport() {
    if (!_exportPreviewCache || _exportPreviewCache.count === 0) {
        showToast('先にプレビューを実行してください', 'error');
        return;
    }
    const count = _exportPreviewCache.count;
    const filters = _collectExportFilters();
    filters.remove_from_farming = document.getElementById('export-remove-farming').checked;
    const removeNote = filters.remove_from_farming
        ? 'エクスポート済みとして記録され、育成コンフィグから除外されます。'
        : 'エクスポート済みとして記録しますが、育成コンフィグからは除外しません。';
    if (!confirm(`${count}件のアカウントをエクスポートしますか？\n\n${removeNote}`)) return;

    try {
        const response = await fetch(API + '/api/export/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(filters),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || 'エクスポート失敗');
        }

        // ダウンロード
        const blob = await response.blob();
        const disposition = response.headers.get('Content-Disposition') || '';
        const match = disposition.match(/filename="?([^"]+)"?/);
        const filename = match ? match[1] : `export_${Date.now()}.txt`;

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast(`${count}件のアカウントをエクスポートしました: ${filename}`, 'success');

        // 画面更新
        _exportPreviewCache = null;
        document.getElementById('export-execute-btn').disabled = true;
        document.getElementById('export-remove-only-btn').disabled = true;
        loadExportStats();
        loadExportHistory();
    } catch (e) {
        showToast('エクスポート失敗: ' + e.message, 'error');
    }
}

async function removePreviewFromFarming() {
    const accounts = (_exportPreviewCache && _exportPreviewCache.accounts) || [];
    const usernames = accounts.map(a => a.username).filter(Boolean);
    if (!usernames.length) {
        showToast('先にプレビューを実行してください', 'error');
        return;
    }
    if (!confirm(`${usernames.length}件を育成コンフィグから除外しますか？\n\nエクスポート済み記録やExcel削除は行いません。`)) return;
    try {
        const resp = await apiPost('/api/export/remove-from-farming', { usernames });
        showToast(resp.message || '育成コンフィグから除外しました', 'success');
        document.getElementById('export-remove-only-btn').disabled = true;
    } catch (e) {
        showToast('育成除外に失敗: ' + e.message, 'error');
    }
}

function resetExportFilters() {
    _exportPerfectMode = false;
    document.getElementById('export-year-from').value = '';
    document.getElementById('export-year-to').value = '';
    document.getElementById('export-shadowban').value = '';
    document.getElementById('export-status').value = '';
    const proxySel = document.getElementById('export-proxy');
    if (proxySel) proxySel.value = '';
    document.getElementById('export-usernames').value = '';
    document.getElementById('export-exclude-exported').checked = true;
    document.getElementById('export-sort1').value = '';
    document.getElementById('export-sort2').value = '';
    document.getElementById('export-limit').value = '';
    document.getElementById('export-preview-area').innerHTML = '<p style="color:var(--text-muted)">「プレビュー」を押すと対象アカウントが表示されます</p>';
    document.getElementById('export-preview-count').textContent = '';
    document.getElementById('export-execute-btn').disabled = true;
    document.getElementById('export-remove-only-btn').disabled = true;
    _exportPreviewCache = null;
}

function _parseCreatedYear(createdAt) {
    if (!createdAt) return '';
    const m = String(createdAt).match(/\b(20\d{2})\b/);
    return m ? m[1] : '';
}

function _fmtNum(n) {
    if (n == null) return '-';
    const num = Number(n);
    if (Number.isNaN(num)) return '-';
    return num.toLocaleString();
}

function _banBadge(sb) {
    if (!sb || typeof sb !== 'object' || Object.keys(sb).length === 0) {
        return '<span class="badge badge-pending" style="font-size:9px;">未チェック</span>';
    }
    if (sb.suspend) return '<span class="badge" style="font-size:9px;background:#7f1d1d;color:#fff;">凍結</span>';
    if (sb.not_found) return '<span class="badge" style="font-size:9px;background:#7f1d1d;color:#fff;">不明</span>';
    if (sb.sensitive_limited || sb.search_status === 'センシ限定') return '<span class="badge badge-pending" style="font-size:9px;">センシ限定</span>';
    if (sb.top_search_ok && sb.latest_search_ok) return '<span class="badge badge-active" style="font-size:9px;">検索OK</span>';
    if (sb.top_search_ok || sb.latest_search_ok) return '<span class="badge badge-pending" style="font-size:9px;">部分OK</span>';
    return '<span class="badge badge-pending" style="font-size:9px;color:var(--danger);">NG</span>';
}

function toggleExportGroup(groupKey) {
    const body = document.getElementById(`export-group-body-${groupKey}`);
    const chevron = document.getElementById(`export-group-chevron-${groupKey}`);
    if (!body) return;
    const hidden = body.hasAttribute('hidden');
    if (hidden) {
        body.removeAttribute('hidden');
        if (chevron) chevron.textContent = '▼';
    } else {
        body.setAttribute('hidden', '');
        if (chevron) chevron.textContent = '▶';
    }
}

function _secretCell(value, label) {
    if (!value) return '<span style="color:var(--text-muted);font-size:10px;">-</span>';
    const safeAttr = _esc(value);
    const trimmed = value.length > 18 ? value.slice(0, 16) + '…' : value;
    return `<span class="export-secret" data-copy="${safeAttr}" title="クリックでコピー: ${label}" onclick="_copyExportSecret(this)" style="font-family:monospace;font-size:10px;background:var(--bg-dark,#0f1419);padding:2px 5px;border-radius:3px;cursor:pointer;user-select:all;max-width:140px;display:inline-block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(trimmed)}</span>`;
}

function _copyExportSecret(el) {
    const val = el.getAttribute('data-copy') || '';
    if (!val) return;
    try {
        navigator.clipboard.writeText(val).then(() => {
            const prev = el.textContent;
            el.textContent = 'コピーしました';
            el.style.background = 'var(--success,#16a34a)';
            el.style.color = '#fff';
            setTimeout(() => {
                el.textContent = prev;
                el.style.background = '';
                el.style.color = '';
            }, 900);
        });
    } catch (_) {
        // フォールバック
        const ta = document.createElement('textarea');
        ta.value = val;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (_) {}
        document.body.removeChild(ta);
    }
}

function _exportDetailValue(value, label, sensitive = false, long = false) {
    if (!value && value !== 0) return '<span style="color:var(--text-muted);font-size:12px;">-</span>';
    const val = String(value);
    const attr = _escAttr(val);
    const body = sensitive
        ? `<span class="detail-sensitive" data-value="${attr}" onclick="this.textContent=this.dataset.value;this.style.color='var(--text)'" title="クリックで表示" style="font-family:monospace;font-size:12px;color:var(--text-muted);cursor:pointer;">${'●'.repeat(Math.min(val.length, 18))}</span>`
        : `<span style="font-size:12px;word-break:break-all;${long ? 'max-height:72px;overflow:auto;display:block;' : ''}">${_esc(val)}</span>`;
    return `<div style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);">
        <span style="min-width:130px;font-size:12px;color:var(--text-muted);flex-shrink:0;">${_esc(label)}</span>
        <div style="flex:1;min-width:0;">${body}</div>
        <button class="copy-id-btn" data-copy="${attr}" onclick="_copyExportDetailButton(this)" title="コピー" style="margin-left:auto;flex-shrink:0;">コピー</button>
    </div>`;
}

function _copyExportDetailButton(btn) {
    copyToClipboard(btn.getAttribute('data-copy') || '', btn);
}

function _renderExportAccountDetail(d) {
    const profile = d.profile || {};
    const sb = d.shadowban || {};
    const year = _parseCreatedYear(profile.created_at);
    const proxyLabel = d.proxy_label || d.proxy_display_name || d.proxy_country_code || '';
    const fields = [
        ['ユーザー名', d.username, false, false],
        ['パスワード', d.password, true, false],
        ['メールアドレス', d.email, false, false],
        ['メールPW', d.mail_password, true, false],
        ['2FA', d['2fa'], true, false],
        ['Auth Token', d.auth_token, true, false],
        ['Cookie', d.cookies, true, true],
        ['Proxy', d.proxy, false, true],
        ['Proxy表示', proxyLabel, false, false],
        ['ログイン方式', d.login_method, false, false],
        ['ステータス', d.status, false, false],
        ['最終ログイン', d.last_login, false, false],
        ['インポートグループ', d.import_group, false, false],
        ['メモ', d.notes, false, true],
        ['エクスポート行', d.export_line, true, true],
    ];
    const stats = [];
    if (year) stats.push(`${year}年作成`);
    if (profile.statuses_count != null) stats.push(`${_formatNumber(profile.statuses_count)} 投稿`);
    if (profile.followers_count != null) stats.push(`${_formatNumber(profile.followers_count)} フォロワー`);
    if (profile.following_count != null) stats.push(`${_formatNumber(profile.following_count)} フォロー`);
    const sbFlags = _shadowbanBadgeList(sb, false);
    const source = d.source === 'exported' ? 'エクスポート履歴' : 'アカウント管理';
    let html = `<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">参照元: ${source}</div>`;
    html += fields.map(f => _exportDetailValue(f[1], f[0], f[2], f[3])).join('');
    if (stats.length) {
        html += `<div style="padding:8px 0;border-bottom:1px solid var(--border);font-size:12px;"><span style="color:var(--text-muted);">プロフィール統計: </span>${stats.join(' / ')}</div>`;
    }
    html += `<div style="padding:8px 0;border-bottom:1px solid var(--border);font-size:12px;"><span style="color:var(--text-muted);">BAN: </span>${sbFlags.length ? sbFlags.join(' ') : '<span class="badge badge-pending" style="font-size:10px;">未チェック</span>'}</div>`;
    html += `<div style="margin-top:12px;display:flex;gap:8px;">
        <button class="btn btn-sm btn-outline" data-copy="${_escAttr(d.export_line || '')}" onclick="_copyExportDetailButton(this)">エクスポート行をコピー</button>
        <button class="btn btn-sm btn-outline" onclick="closeModal('account-detail-modal')">閉じる</button>
    </div>`;
    return html;
}

async function showExportAccountDetail(username) {
    const modal = document.getElementById('account-detail-modal');
    const titleEl = document.getElementById('detail-modal-title');
    const bodyEl = document.getElementById('detail-modal-body');
    titleEl.textContent = `@${username} のエクスポート情報`;
    bodyEl.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px;">読み込み中...</p>';
    modal.classList.add('active');
    try {
        const d = await apiGet(`/api/export/account/${encodeURIComponent(username)}`);
        titleEl.textContent = `@${d.username || username} のエクスポート情報`;
        bodyEl.innerHTML = _renderExportAccountDetail(d);
    } catch (e) {
        bodyEl.innerHTML = `<p style="color:var(--danger);text-align:center;padding:20px;">読み込み失敗: ${_esc(e.message)}</p>`;
    }
}

function showExportHistoryAccountDetail(username) {
    const groups = (_exportHistoryCache && _exportHistoryCache.groups) || {};
    let found = null;
    Object.values(groups).forEach(group => {
        (group.accounts || []).forEach(account => {
            if ((account.username || '').toLowerCase() === String(username || '').toLowerCase()) {
                if (!found || String(account.exported_at || '') > String(found.exported_at || '')) found = account;
            }
        });
    });
    if (!found) {
        showExportAccountDetail(username);
        return;
    }
    const modal = document.getElementById('account-detail-modal');
    document.getElementById('detail-modal-title').textContent = `@${found.username} のエクスポート情報`;
    document.getElementById('detail-modal-body').innerHTML = _renderExportAccountDetail({ ...found, source: 'exported' });
    modal.classList.add('active');
}

function _renderExportedRow(a, i) {
    const profile = a.profile || {};
    const sb = a.shadowban || {};
    const year = _parseCreatedYear(profile.created_at);
    const followers = _fmtNum(profile.followers_count);
    const following = _fmtNum(profile.following_count);
    const tweets = _fmtNum(profile.statuses_count);
    const statusCell = a.status
        ? `<span class="badge badge-${a.status === 'active' ? 'active' : 'pending'}" style="font-size:9px;">${_esc(a.status)}</span>`
        : '-';
    const proxyShort = a.proxy_label || (a.proxy ? a.proxy.replace(/^https?:\/\/([^@]*@)?/, '') : '-');
    const displayName = profile.display_name
        ? `<div style="font-size:10px;color:var(--text-muted);margin-left:24px;">${_esc(profile.display_name)}</div>`
        : '';
    const pwCell = _secretCell(a.password, 'パスワード');
    const mailPwCell = _secretCell(a.mail_password, 'メールパスワード');
    const twoFaCell = _secretCell(a['2fa'], '2FA キー');
    const tokenCell = _secretCell(a.auth_token, 'Auth Token');
    return `<tr>
        <td style="font-size:11px;">${i + 1}</td>
        <td style="font-size:12px;">
            <div style="display:flex;align-items:center;gap:4px;">
                ${accountAvatarHtml(a.username, 20)}
                <button onclick="showExportHistoryAccountDetail('${_escAttr(a.username)}')" title="アカウント情報を表示" style="border:none;background:transparent;color:var(--primary);padding:0;cursor:pointer;font-size:12px;">@${_esc(a.username)}</button>
            </div>
            ${displayName}
        </td>
        <td style="font-size:11px;">${_esc(a.email || '-')}</td>
        <td>${pwCell}</td>
        <td>${mailPwCell}</td>
        <td>${twoFaCell}</td>
        <td>${tokenCell}</td>
        <td style="font-size:11px;color:var(--text-muted);" title="${_esc(a.proxy || '')}">${proxyShort}</td>
        <td style="font-size:11px;text-align:center;">${year || '-'}</td>
        <td style="font-size:11px;text-align:right;">${followers}</td>
        <td style="font-size:11px;text-align:right;">${following}</td>
        <td style="font-size:11px;text-align:right;">${tweets}</td>
        <td style="font-size:11px;text-align:center;">${_banBadge(sb)}</td>
        <td style="font-size:11px;">${statusCell}</td>
    </tr>`;
}

function _renderExportedGroup([filename, info], gIdx) {
    const date = (info.exported_at || '').replace('T', ' ').substring(0, 19);
    const accounts = info.accounts || [];
    const groupKey = `g${gIdx}`;
    const rows = accounts.map(_renderExportedRow).join('');
    return `<div class="export-group" style="border:1px solid var(--border);border-radius:6px;margin-bottom:8px;overflow:hidden;">
        <div onclick="toggleExportGroup('${groupKey}')" style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;cursor:pointer;background:var(--bg-surface-2,rgba(255,255,255,0.02));">
            <div style="display:flex;align-items:center;gap:8px;">
                <span id="export-group-chevron-${groupKey}" style="font-size:10px;color:var(--text-muted);">▶</span>
                <strong style="font-size:13px;">${_esc(filename)}</strong>
                <span class="badge badge-pending" style="font-size:10px;">${info.count}件</span>
            </div>
            <div style="font-size:11px;color:var(--text-muted);">${date}</div>
        </div>
        <div id="export-group-body-${groupKey}" hidden>
            <div class="table-wrapper" style="max-height:460px;overflow-x:auto;overflow-y:auto;">
                <table style="min-width:1500px;">
                    <thead><tr>
                        <th>#</th>
                        <th>アカウント</th>
                        <th>メール</th>
                        <th>PW</th>
                        <th>MailPW</th>
                        <th>2FA</th>
                        <th>AuthToken</th>
                        <th>Proxy</th>
                        <th>作成年</th>
                        <th style="text-align:right;">フォロワー</th>
                        <th style="text-align:right;">フォロー</th>
                        <th style="text-align:right;">ツイート</th>
                        <th>BAN</th>
                        <th>状態</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>
    </div>`;
}

async function loadExportHistory() {
    const area = document.getElementById('export-history-area');
    try {
        const resp = await apiGet('/api/export/history');
        _exportHistoryCache = resp;
        const records = resp.records || [];
        const groups = resp.groups || {};

        if (records.length === 0) {
            area.textContent = '';
            const p = document.createElement('p');
            p.style.color = 'var(--text-muted)';
            p.textContent = 'エクスポート履歴はありません';
            area.appendChild(p);
            return;
        }

        const groupEntries = Object.entries(groups).sort((a, b) =>
            (b[1].exported_at || '').localeCompare(a[1].exported_at || '')
        );

        const html = groupEntries.map(_renderExportedGroup).join('');
        area.innerHTML = html;
    } catch (e) {
        area.textContent = '';
        const p = document.createElement('p');
        p.style.color = 'var(--danger)';
        p.textContent = `履歴読み込み失敗: ${e.message}`;
        area.appendChild(p);
    }
}


// ============================================
// 削除済みアカウント
// ============================================
const REASON_LABELS = {
    suspended: '凍結',
    not_found: 'アカウント不明',
    manual: '手動削除',
};

async function loadDeletedAccounts() {
    try {
        const records = await apiGet('/api/accounts/deleted/list');
        const container = document.getElementById('deleted-accounts-list');
        const summaryEl = document.getElementById('deleted-summary');

        if (!records || records.length === 0) {
            container.innerHTML = '<div class="card"><p style="color:var(--text-muted)">削除済みアカウントはありません</p></div>';
            if (summaryEl) summaryEl.innerHTML = '';
            return;
        }

        // サマリー
        const suspendedCount = records.filter(r => r.reason === 'suspended').length;
        const manualCount = records.filter(r => r.reason === 'manual').length;
        const otherCount = records.length - suspendedCount - manualCount;
        summaryEl.innerHTML = `<div style="display:flex;gap:12px;flex-wrap:wrap;">
            <span style="font-size:13px;color:var(--text-muted);">合計: <strong>${records.length}</strong>件</span>
            ${suspendedCount > 0 ? `<span style="font-size:13px;color:#f87171;">凍結: <strong>${suspendedCount}</strong></span>` : ''}
            ${manualCount > 0 ? `<span style="font-size:13px;color:var(--text-muted);">手動: <strong>${manualCount}</strong></span>` : ''}
            ${otherCount > 0 ? `<span style="font-size:13px;color:var(--text-muted);">その他: <strong>${otherCount}</strong></span>` : ''}
        </div>`;

        // 新しい順にソート
        records.sort((a, b) => (b.deleted_at || '').localeCompare(a.deleted_at || ''));

        container.innerHTML = records.map(r => {
            const username = r.username || '?';
            const deletedAt = (r.deleted_at || '').replace('T', ' ').substring(0, 16);
            const reasonLabel = REASON_LABELS[r.reason] || r.reason || '不明';
            const reasonColor = r.reason === 'suspended' ? '#f87171' : r.reason === 'not_found' ? '#fbbf24' : 'var(--text-muted)';

            // アカウント情報
            const info = r.account_info || {};
            const meta = r.metadata || {};
            const profile = meta.profile || {};
            const sb = meta.shadowban || {};

            // プロフィール統計
            const year = _parseCreatedYear(profile.created_at);
            const statsItems = [];
            if (year) statsItems.push(`${year}年作成`);
            if (profile.statuses_count != null) statsItems.push(`${_formatNumber(profile.statuses_count)}投稿`);
            if (profile.followers_count != null) statsItems.push(`${_formatNumber(profile.followers_count)}フォロワー`);
            if (profile.following_count != null) statsItems.push(`${_formatNumber(profile.following_count)}フォロー`);
            const statsHtml = statsItems.length > 0
                ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${statsItems.join(' / ')}</div>`
                : '';

            // シャドウバン情報
            const sbFlags = _shadowbanBadgeList(sb, true);
            const sbHtml = sbFlags.length > 0
                ? `<div style="display:flex;gap:3px;margin-top:4px;flex-wrap:wrap;">${sbFlags.join('')}</div>`
                : '';

            // 設定状況
            const editBadges = [];
            if (info.edited_icon) editBadges.push('アイコン');
            if (info.edited_name) editBadges.push('ネーム');
            if (info.edited_bio) editBadges.push('プロフ');
            const editHtml = editBadges.length > 0
                ? `<span style="font-size:11px;color:var(--accent);">設定済み: ${editBadges.join(', ')}</span>`
                : '<span style="font-size:11px;color:var(--text-muted);">プロフ未設定</span>';

            // farming 行動履歴
            const farming = r.farming_history || [];
            let farmingHtml = '';
            if (farming.length > 0) {
                let totalJobs = 0, postedJobs = 0, errorJobs = 0;
                farming.forEach(batch => {
                    (batch.jobs || []).forEach(j => {
                        totalJobs++;
                        if (j.status === 'posted') postedJobs++;
                        if (j.status === 'error') errorJobs++;
                    });
                });

                const jobRows = farming.flatMap(batch =>
                    (batch.jobs || []).filter(j => j.status === 'posted' || j.status === 'error').slice(0, 5).map(j => {
                        const time = (j.run_at || '').replace('T', ' ').substring(0, 16);
                        const statusCls = j.status === 'posted' ? 'badge-active' : 'badge-error';
                        const text = j.text ? _esc(j.text.length > 50 ? j.text.substring(0, 50) + '...' : j.text) : '-';
                        return `<tr>
                            <td style="font-size:11px;white-space:nowrap;">${time}</td>
                            <td><span class="badge ${statusCls}" style="font-size:9px;">${j.status === 'posted' ? '投稿' : '失敗'}</span></td>
                            <td style="font-size:11px;">${text}</td>
                        </tr>`;
                    })
                ).slice(0, 10);

                const tableId = `del-farm-${username}`;
                farmingHtml = `
                    <div style="margin-top:8px;">
                        <div style="display:flex;align-items:center;gap:8px;">
                            <span style="font-size:12px;font-weight:600;">育成工場履歴</span>
                            <span style="font-size:11px;color:var(--text-muted);">全${totalJobs}件 (投稿${postedJobs} / 失敗${errorJobs})</span>
                            ${jobRows.length > 0 ? `<button class="btn btn-sm btn-outline" onclick="toggleAccountJobs('${tableId}', this)" style="font-size:10px;padding:2px 6px;">詳細表示</button>` : ''}
                        </div>
                        ${jobRows.length > 0 ? `<div id="${tableId}" class="table-wrapper" style="display:none;margin-top:4px;">
                            <table>
                                <thead><tr><th>日時</th><th>状態</th><th>内容</th></tr></thead>
                                <tbody>${jobRows.join('')}</tbody>
                            </table>
                        </div>` : ''}
                    </div>`;
            }

            const checkedAt = meta.checked_at ? `チェック: ${meta.checked_at.replace('T',' ').substring(0,16)}` : '';

            return `<div class="card" style="margin-bottom:8px;border-left:3px solid ${reasonColor};">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                    <div>
                        <div style="display:flex;align-items:center;gap:8px;">
                            <strong style="font-size:14px;">@${_esc(username)}</strong>
                            <span class="badge badge-error" style="font-size:10px;">${reasonLabel}</span>
                            <span style="font-size:11px;color:var(--text-muted);">削除: ${deletedAt}</span>
                        </div>
                        ${statsHtml}
                        ${sbHtml}
                        <div style="margin-top:4px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                            ${editHtml}
                            ${info.proxy ? `<span style="font-size:11px;color:var(--text-muted);">Proxy: ${_esc(info.proxy).substring(0,30)}</span>` : ''}
                            ${info.import_group ? `<span style="font-size:11px;color:var(--text-muted);">グループ: ${_esc(info.import_group)}</span>` : ''}
                            ${checkedAt ? `<span style="font-size:11px;color:var(--text-muted);">${checkedAt}</span>` : ''}
                        </div>
                    </div>
                    <button class="btn btn-sm btn-danger" onclick="purgeDeletedAccount('${username}')" style="font-size:11px;padding:4px 8px;white-space:nowrap;">完全削除</button>
                </div>
                ${farmingHtml}
            </div>`;
        }).join('');
    } catch (e) {
        showToast('削除済みアカウント読み込み失敗: ' + e.message, 'error');
    }
}

async function purgeDeletedAccount(username) {
    if (!confirm(`@${username} のアーカイブを完全に削除しますか？\n行動履歴も全て失われます。`)) return;
    try {
        await apiDelete(`/api/accounts/deleted/${encodeURIComponent(username)}`);
        showToast(`@${username} のアーカイブを完全に削除しました`, 'success');
        loadDeletedAccounts();
    } catch (e) {
        showToast(`削除失敗: ${e.message}`, 'error');
    }
}

async function purgeAllDeletedAccounts() {
    if (!confirm('全ての削除済みアカウントのアーカイブを完全に削除しますか？\n行動履歴も全て失われます。')) return;
    try {
        await apiDelete('/api/accounts/deleted-all');
        showToast('全アーカイブを削除しました', 'success');
        loadDeletedAccounts();
    } catch (e) {
        showToast(`削除失敗: ${e.message}`, 'error');
    }
}

// ============================================
// タスク完了通知
// ============================================
const _watchingTasks = new Map(); // task_id -> label

function watchTask(taskId, label, options = {}) {
    _watchingTasks.set(taskId, label);
    // 処理中オーバーレイを表示してポーリング開始
    showProcessing(label, '開始中...');
    _pollTaskProgress(taskId, label, options);
}

const ACTION_DONE_LABELS = {
    profile_update: 'プロフィール更新',
    icon_bulk_update: 'アイコン一括変更',
    csv_profile_update: 'CSVプロフィール適用',
    llm_profile_generate: 'LLMプロフィール生成',
    llm_profile_apply: 'LLMプロフィール適用',
    post_tweet: 'ツイート投稿',
    bulk_login: '一括ログイン',
    bulk_like: '一括いいね',
    bulk_bookmark: '一括ブックマーク',
    bulk_follow: '一括フォロー',
    bulk_retweet: '一括リツイート',
    bulk_url_engagement: 'ツイートID指定エンゲージ',
    username_change: '表示名一括変更',
    icon_bulk_update: 'アイコン一括変更',
    fetch_stats: '統計取得',
    shadowban_check: 'シャドウバンチェック',
    change_password: 'パスワード変更',
    engagement_execute_all: 'エンゲージ一気実行',
    competitor_backfill: '競合ポスト過去取得',
    competitor_monitor_run: '競合監視',
};

async function _pollTaskProgress(taskId, label, options = {}) {
    const poll = async () => {
        try {
            const t = await apiGet(`/api/tasks/${taskId}`);

            const progress = t.progress || 0;
            const total = t.total || 1;
            const pct = Math.round(progress / total * 100);

            // 最新の結果やエラーを表示
            let detail = `${progress} / ${total} アカウント`;
            if (t.action === 'competitor_backfill') {
                detail = `${progress} / ${total} ポスト取得`;
            }
            if (t.errors && t.errors.length > 0) {
                const lastErr = t.errors[t.errors.length - 1];
                detail += ` (エラー: ${t.errors.length}件)`;
            }
            if (t.results && t.results.length > 0) {
                const last = t.results[t.results.length - 1];
                const acct = last.account || '';
                if (acct) detail = `${progress} / ${total}  処理中: @${acct}`;
            }

            updateProcessing(undefined, detail, pct);

            if (t.status === 'completed') {
                const errCount = (t.errors || []).length;
                const successCount = progress - errCount;
                if (errCount > 0) {
                    updateProcessing(`${label} 完了 (一部失敗)`, `成功: ${successCount}件 / 失敗: ${errCount}件`, 100);
                    _markProcessingError();
                } else {
                    const completeDetail = t.action === 'competitor_backfill'
                        ? `${Number(_lastTaskResult(t).fetched ?? progress) || 0}件取得`
                        : `${progress} / ${total} アカウント完了`;
                    updateProcessing(`${label} 完了`, completeDetail, 100);
                }
                if (typeof options.onComplete === 'function') {
                    try {
                        await options.onComplete(t);
                    } catch (callbackError) {
                        console.warn('task completion callback failed', callbackError);
                    }
                }
                setTimeout(() => {
                    hideProcessing();
                    if (errCount > 0) {
                        showToast(`${label} 完了 — 成功: ${successCount}件, 失敗: ${errCount}件`, 'error');
                    } else {
                        showToast(`${label} 完了 (${progress}/${total})`, 'success');
                    }
                }, 1500);
                _watchingTasks.delete(taskId);
                return;
            } else if (t.status === 'cancelled') {
                updateProcessing(`${label} キャンセル`, `${progress} / ${total} アカウントで停止`, pct);
                setTimeout(() => {
                    hideProcessing();
                    showToast(`${label}をキャンセルしました (${progress}/${total})`, 'success');
                }, 800);
                _watchingTasks.delete(taskId);
                return;
            } else if (t.status === 'failed') {
                const errMsg = (t.errors && t.errors.length > 0) ? t.errors[t.errors.length - 1] : '不明なエラー';
                updateProcessing(`${label} 失敗`, errMsg, 100);
                _markProcessingError();
                setTimeout(() => {
                    hideProcessing();
                    showToast(`${label} 失敗: ${errMsg}`, 'error');
                }, 2500);
                _watchingTasks.delete(taskId);
                return;
            }

            // まだ実行中 → 続けてポーリング
            setTimeout(poll, 2000);
        } catch (e) {
            // ネットワークエラーなどは再試行
            setTimeout(poll, 3000);
        }
    };
    // 初回は500ms後（タスク作成直後は反映されてない可能性）
    setTimeout(poll, 500);
}

const TASK_RESTORE_INTERVAL_MS = 30000;
let _lastWatchedTaskRestoreAt = 0;

async function checkWatchedTasks(force = false) {
    if (document.hidden && !force) return;

    const now = Date.now();
    if (!force && now - _lastWatchedTaskRestoreAt < TASK_RESTORE_INTERVAL_MS) return;
    _lastWatchedTaskRestoreAt = now;

    await Promise.allSettled([
        restoreRunningShadowbanTaskNotification(),
        restoreRunningShadowbanSchedulerNotification(),
        restoreRunningLlmTaskNotifications(),
    ]);
}

async function restoreRunningLlmTaskNotifications() {
    try {
        const tasks = await apiGet(`/api/tasks?_=${Date.now()}`);
        const running = (tasks || []).filter(t =>
            t.status === 'running' &&
            (t.action === 'llm_profile_generate' || t.action === 'llm_profile_apply')
        );
        for (const task of running) {
            if (_watchingTasks.has(task.task_id)) continue;
            watchTask(task.task_id, actionLabel(task.action));
        }
    } catch (_) {
        // 次回の通常ポーリングで再確認する。
    }
}

// ============================================
// Scroll-time pointer-events kill (account 管理のスクロール体感向上)
// ----------------------------------------------
// スクロール中は html.is-scrolling を付け、停止から 120ms 後に解除する。
// これで hover に依存する recalc-style / paint が連続発火しなくなり、
// main-thread の scroll ハンドリングコストが大幅に下がる。
// ============================================
(function () {
    let scrollStopTimer = null;
    const html = document.documentElement;
    const onScroll = () => {
        if (!html.classList.contains('is-scrolling')) {
            html.classList.add('is-scrolling');
        }
        if (scrollStopTimer) clearTimeout(scrollStopTimer);
        scrollStopTimer = setTimeout(() => {
            html.classList.remove('is-scrolling');
        }, 120);
    };
    // passive で合成スレッドスクロールを維持
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    // wheel は passive で登録しておくと、ブラウザが wheel listener の存在だけで
    // スクロールを main-thread に降格するのを防げる (Chrome 56+ の挙動)
    window.addEventListener('wheel', () => {}, { passive: true });
})();

// ============================================
// 自動更新
// ============================================
setInterval(async () => {
    if (document.hidden) return;
    const activePage = document.querySelector('.page.active');
    if (activePage && activePage.id === 'page-tasks') {
        refreshTasks();
    }
    if (activePage && activePage.id === 'page-dashboard') {
        // 全体 DOM 再構築を避け、値だけ更新する soft refresh を使う
        // (loadDashboard は初回/ナビゲーション時のみ走らせる)
        if (typeof softRefreshOpsDashboard === 'function') {
            softRefreshOpsDashboard();
        } else if (!shouldDeferDashboardToOpsPatch()) {
            loadDashboard();
        }
    }
    checkWatchedTasks();
}, 5000);

document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    _lastWatchedTaskRestoreAt = 0;
    checkWatchedTasks(true);
});

// ============================================
// Warmup管理
// ============================================

let _warmupState = {
    accounts: [],
    activity: [],
    counts: {},
    filter: 'all',
    autoRefreshId: null,
    meta: { readonly_end_hours: 48.0, soft_ramp_end_hours: 120.0, now: null },
};

async function loadWarmupDashboard() {
    const listEl = document.getElementById('warmup-accounts-list');
    const summaryEl = document.getElementById('warmup-summary');
    const actEl = document.getElementById('warmup-activity-list');
    if (listEl) listEl.innerHTML = '<p style="color:var(--text-muted)">読み込み中...</p>';
    if (summaryEl) summaryEl.innerHTML = '<p style="color:var(--text-muted)">読み込み中...</p>';
    if (actEl) actEl.innerHTML = '<p style="color:var(--text-muted)">読み込み中...</p>';
    try {
        const [listData, actData] = await Promise.all([
            apiGet('/api/accounts/warmup/list'),
            apiGet('/api/accounts/warmup/activity?limit=50'),
        ]);
        _warmupState.accounts = listData.accounts || [];
        _warmupState.counts = listData.counts || {};
        _warmupState.meta = {
            now: listData.now,
            readonly_end_hours: listData.readonly_end_hours,
            soft_ramp_end_hours: listData.soft_ramp_end_hours,
        };
        _warmupState.activity = actData.entries || [];
        renderWarmupSummary(_warmupState.counts);
        renderWarmupAccounts(_warmupState.accounts);
        renderWarmupActivity(_warmupState.activity);
    } catch (e) {
        if (listEl) listEl.innerHTML = `<p style="color:var(--danger)">読み込みエラー: ${e.message}</p>`;
        if (summaryEl) summaryEl.innerHTML = '';
        if (actEl) actEl.innerHTML = '';
        console.error('Warmup dashboard error:', e);
    }
}

function renderWarmupSummary(counts) {
    const el = document.getElementById('warmup-summary');
    if (!el) return;
    const total = counts.total || 0;
    const ro = counts.readonly || 0;
    const sr = counts.soft_ramp || 0;
    const ac = counts.active || 0;
    const inF = counts.in_farming || 0;
    const card = (label, value, color) => `
        <div class="card" style="padding:14px;">
            <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;">${label}</div>
            <div style="font-size:26px;font-weight:700;color:${color};margin-top:4px;">${value}</div>
        </div>`;
    el.innerHTML =
        card('育成中 合計', total, 'var(--text-primary)') +
        card('readonly (0-48h)', ro, 'var(--warning)') +
        card('soft_ramp (48-120h)', sr, '#f59e0b') +
        card('active (120h+)', ac, 'var(--success)') +
        card('Farming参加中', inF, 'var(--accent, #60a5fa)');
}

function warmupSetFilter(phase) {
    _warmupState.filter = phase;
    document.querySelectorAll('[data-warmup-filter]').forEach(btn => {
        if (btn.dataset.warmupFilter === phase) {
            btn.classList.remove('btn-outline');
            btn.classList.add('btn-primary');
        } else {
            btn.classList.add('btn-outline');
            btn.classList.remove('btn-primary');
        }
    });
    renderWarmupAccounts(_warmupState.accounts);
}

function _warmupPhaseBadge(phase) {
    if (phase === 'readonly') return '<span class="badge badge-pending">readonly</span>';
    if (phase === 'soft_ramp') return '<span class="badge badge-warning">soft_ramp</span>';
    if (phase === 'active') return '<span class="badge badge-active">active</span>';
    return `<span class="badge badge-unknown">${phase || '-'}</span>`;
}

function _warmupFormatRemaining(hours) {
    if (hours == null) return '-';
    if (hours <= 0) return '完了';
    if (hours < 1) return `${Math.round(hours * 60)}分`;
    if (hours < 24) return `${hours.toFixed(1)}時間`;
    const days = Math.floor(hours / 24);
    const hrs = Math.round(hours - days * 24);
    return `${days}日${hrs}時間`;
}

function _warmupFormatTimestamp(iso) {
    if (!iso) return '-';
    try {
        const d = new Date(iso);
        const now = new Date();
        const diffMs = now - d;
        if (diffMs < 0) return d.toLocaleString('ja-JP');
        const diffMin = Math.floor(diffMs / 60000);
        if (diffMin < 1) return '今';
        if (diffMin < 60) return `${diffMin}分前`;
        const diffH = Math.floor(diffMin / 60);
        if (diffH < 24) return `${diffH}時間前`;
        const diffD = Math.floor(diffH / 24);
        return `${diffD}日前`;
    } catch (_) {
        return iso;
    }
}

function _warmupProgressBar(a) {
    const readonlyEnd = _warmupState.meta.readonly_end_hours || 48.0;
    const softRampEnd = _warmupState.meta.soft_ramp_end_hours || 120.0;
    const hrs = a.hours_since_import || 0;
    const pct = Math.min(100, (hrs / softRampEnd) * 100);
    let color = 'var(--warning)';
    if (a.phase === 'soft_ramp') color = '#f59e0b';
    if (a.phase === 'active') color = 'var(--success)';
    const readonlyPct = (readonlyEnd / softRampEnd) * 100;
    return `
        <div style="position:relative;width:100%;height:6px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden;">
            <div style="position:absolute;left:${readonlyPct}%;top:0;bottom:0;width:1px;background:rgba(255,255,255,0.2);"></div>
            <div style="height:100%;width:${pct}%;background:${color};transition:width .3s;"></div>
        </div>`;
}

function renderWarmupAccounts(accounts) {
    const el = document.getElementById('warmup-accounts-list');
    if (!el) return;
    const filtered = _warmupState.filter === 'all'
        ? accounts
        : accounts.filter(a => a.phase === _warmupState.filter);
    if (filtered.length === 0) {
        el.innerHTML = `<p style="color:var(--text-muted);padding:12px;">
            ${_warmupState.filter === 'all' ? '育成中のアカウントはありません' : `"${_warmupState.filter}" に該当するアカウントはありません`}
        </p>`;
        return;
    }

    const rows = filtered.map(a => {
        const inFarm = a.in_farming_config
            ? '<span class="badge badge-active" style="font-size:10px;">Farming参加</span>'
            : '<span class="badge badge-unknown" style="font-size:10px;">未参加</span>';
        const allowProb = a.phase === 'soft_ramp'
            ? `<div style="font-size:11px;color:var(--text-muted);">書込許可: ${Math.round((a.allow_prob || 0) * 100)}%</div>`
            : '';
        const nextPhase = a.next_phase
            ? `<div style="font-size:11px;color:var(--text-muted);">次: ${a.next_phase} (${_warmupFormatTimestamp(a.next_phase_at)})</div>`
            : '';
        const lastAct = a.last_activity_at
            ? `<div style="font-size:11px;color:var(--text-muted);">直近: ${a.last_activity_status || '-'} (${_warmupFormatTimestamp(a.last_activity_at)})</div>`
            : '<div style="font-size:11px;color:var(--text-muted);">直近: -</div>';
        const lastSteps = Array.isArray(a.last_warmup_steps) && a.last_warmup_steps.length > 0
            ? `<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">ステップ: ${a.last_warmup_steps.join(' → ')}</div>`
            : '';

        return `
        <div style="display:grid;grid-template-columns:minmax(160px,1.4fr) minmax(120px,0.9fr) 2fr minmax(180px,1.3fr) auto;gap:12px;align-items:center;padding:12px 8px;border-bottom:1px solid var(--glass-border);">
            <div style="display:flex;align-items:center;gap:8px;min-width:0;">
                ${accountAvatarHtml(a.username, 32)}
                <div style="min-width:0;">
                    <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">@${a.username}</div>
                    <div style="font-size:11px;color:var(--text-muted);">${a.hours_since_import != null ? `${a.hours_since_import.toFixed(1)}h 経過` : '-'}</div>
                </div>
            </div>
            <div>${_warmupPhaseBadge(a.phase)} ${inFarm}</div>
            <div>
                ${_warmupProgressBar(a)}
                <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">残り ${_warmupFormatRemaining(a.remaining_hours)}</div>
                ${allowProb}
            </div>
            <div>
                ${nextPhase}
                ${lastAct}
                ${lastSteps}
            </div>
            <div style="display:flex;gap:4px;flex-wrap:nowrap;">
                <button class="btn btn-outline btn-sm" onclick="warmupResetAccount('${a.username}')" title="imported_atを現在時刻に戻し、タイマーをやり直す">リセット</button>
                <button class="btn btn-danger btn-sm" onclick="warmupClearAccount('${a.username}')" title="imported_atを削除して即座にactiveにする">完了</button>
            </div>
        </div>`;
    }).join('');

    el.innerHTML = `
        <div style="display:grid;grid-template-columns:minmax(160px,1.4fr) minmax(120px,0.9fr) 2fr minmax(180px,1.3fr) auto;gap:12px;padding:8px;font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid var(--glass-border);">
            <div>アカウント</div>
            <div>フェーズ</div>
            <div>進捗</div>
            <div>ステータス</div>
            <div style="text-align:right;">操作</div>
        </div>
        ${rows}`;
}

function renderWarmupActivity(entries) {
    const el = document.getElementById('warmup-activity-list');
    if (!el) return;
    if (!entries || entries.length === 0) {
        el.innerHTML = '<p style="color:var(--text-muted);padding:12px;">まだ warmup の履歴はありません</p>';
        return;
    }
    const rows = entries.map(e => {
        const stepsText = Array.isArray(e.warmup_steps) && e.warmup_steps.length > 0
            ? e.warmup_steps.join(' → ')
            : '-';
        const errText = Array.isArray(e.warmup_errors) && e.warmup_errors.length > 0
            ? `<div style="font-size:11px;color:var(--danger);margin-top:2px;">⚠ ${e.warmup_errors.join(', ')}</div>`
            : '';
        const hoursText = e.warmup_hours != null ? `${e.warmup_hours.toFixed(1)}h` : '-';
        return `
        <div style="padding:10px 8px;border-bottom:1px solid var(--glass-border);display:grid;grid-template-columns:minmax(140px,1fr) minmax(110px,0.8fr) 3fr minmax(120px,auto);gap:12px;align-items:start;">
            <div>
                <div style="font-weight:600;font-size:13px;">@${e.username || '-'}</div>
                <div style="font-size:11px;color:var(--text-muted);">${_warmupFormatTimestamp(e.run_at)}</div>
            </div>
            <div>${_warmupPhaseBadge(e.warmup_phase)}</div>
            <div>
                <div style="font-size:12px;">${stepsText}</div>
                ${e.warmup_reason ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${e.warmup_reason}</div>` : ''}
                ${errText}
            </div>
            <div style="font-size:11px;color:var(--text-muted);text-align:right;">${hoursText} 経過<br>${e.config_id || ''}</div>
        </div>`;
    }).join('');
    el.innerHTML = rows;
}

function warmupToggleAutoRefresh() {
    const labelEl = document.getElementById('warmup-autorefresh-label');
    if (_warmupState.autoRefreshId) {
        clearInterval(_warmupState.autoRefreshId);
        _warmupState.autoRefreshId = null;
        if (labelEl) labelEl.textContent = '自動更新: OFF';
        showToast('自動更新を停止しました', 'info');
        return;
    }
    _warmupState.autoRefreshId = setInterval(() => {
        const activePage = document.querySelector('.page.active');
        if (activePage && activePage.id === 'page-warmup') {
            loadWarmupDashboard();
        }
    }, 10000);
    if (labelEl) labelEl.textContent = '自動更新: ON (10秒)';
    showToast('自動更新を開始しました (10秒間隔)', 'success');
}

async function warmupResetAccount(username) {
    if (!confirm(`@${username} のwarmupタイマーをリセットしますか？\n(imported_atが現在時刻に設定され、48時間のreadonlyから再スタートします)`)) return;
    try {
        await apiPost(`/api/accounts/${username}/warmup/reset`);
        showToast(`@${username} のタイマーをリセットしました`, 'success');
        loadWarmupDashboard();
    } catch (e) {
        showToast(`リセット失敗: ${e.message}`, 'error');
    }
}

async function warmupClearAccount(username) {
    if (!confirm(`@${username} のwarmupを完了扱いにしますか？\n(imported_atが削除され、即座にactive=通常運転になります)`)) return;
    try {
        await apiDelete(`/api/accounts/${username}/warmup`);
        showToast(`@${username} をactiveにしました`, 'success');
        loadWarmupDashboard();
    } catch (e) {
        showToast(`完了処理失敗: ${e.message}`, 'error');
    }
}

async function openWarmupBulkMarkModal() {
    let candidatesData;
    try {
        candidatesData = await apiGet('/api/accounts/warmup/candidates?only_not_in_farming=false');
    } catch (e) {
        showToast(`候補取得失敗: ${e.message}`, 'error');
        return;
    }
    const cands = candidatesData.candidates || [];
    const alreadyTracked = candidatesData.already_tracked_count || 0;

    // モーダル構築
    const existing = document.getElementById('warmup-bulk-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'warmup-bulk-modal';
    modal.className = 'modal-overlay';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';

    const cardHtml = cands.length === 0
        ? `<p style="color:var(--text-muted);padding:20px;text-align:center;">
            未追跡のアカウントはありません (既に追跡中: ${alreadyTracked} 件)
        </p>`
        : `
        <div style="display:flex;gap:8px;margin-bottom:12px;">
            <button class="btn btn-outline btn-sm" onclick="document.querySelectorAll('.warmup-cand-cb').forEach(c => c.checked = true)">全選択</button>
            <button class="btn btn-outline btn-sm" onclick="document.querySelectorAll('.warmup-cand-cb').forEach(c => c.checked = false)">全解除</button>
            <span style="color:var(--text-muted);font-size:12px;align-self:center;">候補 ${cands.length} 件 / 既追跡 ${alreadyTracked} 件</span>
        </div>
        <div style="max-height:360px;overflow-y:auto;border:1px solid var(--glass-border);border-radius:6px;padding:8px;">
            ${cands.map(c => `
                <label style="display:flex;align-items:center;gap:8px;padding:6px 4px;cursor:pointer;">
                    <input type="checkbox" class="warmup-cand-cb" value="${c.username}" checked>
                    ${accountAvatarHtml(c.username, 24)}
                    <span style="font-size:13px;">@${c.username}</span>
                    ${c.in_farming_config ? '<span class="badge badge-active" style="font-size:10px;">Farming参加中</span>' : ''}
                </label>
            `).join('')}
        </div>
        <div style="margin-top:12px;padding:10px;background:rgba(251,191,36,0.1);border-left:3px solid var(--warning);border-radius:4px;font-size:12px;color:var(--text-muted);">
            ⚠ 選択したアカウントは現在時刻から48時間 readonly、その後 72時間 soft_ramp を経て active になります。この間ツイート投稿は抑制 / 間引きされます。
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
            <button class="btn btn-outline" onclick="document.getElementById('warmup-bulk-modal').remove()">キャンセル</button>
            <button class="btn btn-primary" onclick="executeWarmupBulkMark()">選択したアカウントを追加</button>
        </div>`;

    modal.innerHTML = `
        <div class="card" style="max-width:640px;width:100%;max-height:90vh;overflow-y:auto;">
            <div class="card-title" style="display:flex;justify-content:space-between;align-items:center;">
                <span>ログイン済み未追跡アカウントの追加</span>
                <button class="btn btn-outline btn-sm" onclick="document.getElementById('warmup-bulk-modal').remove()">✕</button>
            </div>
            ${cardHtml}
        </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (ev) => {
        if (ev.target === modal) modal.remove();
    });
}

async function executeWarmupBulkMark() {
    const checked = Array.from(document.querySelectorAll('.warmup-cand-cb'))
        .filter(cb => cb.checked)
        .map(cb => cb.value);
    if (checked.length === 0) {
        showToast('少なくとも1件選択してください', 'error');
        return;
    }
    if (!confirm(`${checked.length} 件のアカウントをwarmup対象としてマークしますか？`)) return;
    try {
        const result = await apiPost('/api/accounts/warmup/bulk-mark', {
            usernames: checked,
            force: false,
        });
        const markedCount = result.marked_count || 0;
        const skippedCount = result.skipped_count || 0;
        showToast(`追加完了: ${markedCount} 件 (スキップ: ${skippedCount})`, 'success');
        const modal = document.getElementById('warmup-bulk-modal');
        if (modal) modal.remove();
        loadWarmupDashboard();
    } catch (e) {
        showToast(`bulk-mark失敗: ${e.message}`, 'error');
    }
}

// ============================================
// 初期化
// ============================================
initActivePageFromStorage();
setTimeout(() => restoreRunningShadowbanTaskNotification(), 800);
