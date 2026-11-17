import { useTheme } from '../context/ThemeContext';
import { Bell, RefreshCw, Activity, Clock, Plug, AlertTriangle, CheckCircle, X, Eye, EyeOff } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import { BACKEND_URL } from '../lib/api-client';

type ConnStatus = 'connected' | 'unauthorized' | 'disconnected' | 'unknown';

const fmtTime = (d: Date, timeZone: string) =>
  d.toLocaleTimeString('en-US', { timeZone, hour12: true });

export default function Header() {
  const { isDark } = useTheme();
  const [time, setTime] = useState(new Date());
  const [refreshing, setRefreshing] = useState(false);

  // Cluster connection
  const [conn, setConn] = useState<ConnStatus>('unknown');
  const [server, setServer] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [tokenVisible, setTokenVisible] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Check connection on mount and every 5 minutes
  const checkConnection = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/openshift/connection`);
      if (!res.ok) return;
      const data = await res.json();
      setConn(data.status as ConnStatus);
      setServer(data.server || '');
    } catch { /* backend not reachable — ignore */ }
  }, []);

  useEffect(() => {
    checkConnection();
    const id = setInterval(checkConnection, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [checkConnection]);

  const handleRefresh = () => {
    setRefreshing(true);
    checkConnection();
    setTimeout(() => setRefreshing(false), 1500);
  };

  const openModal = () => {
    setUrlInput(server);
    setTokenInput('');
    setMsg(null);
    setTokenVisible(false);
    setShowModal(true);
  };

  const connect = async () => {
    setConnecting(true);
    setMsg(null);
    try {
      const res = await fetch(`${BACKEND_URL}/api/openshift/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_url: urlInput.trim(), token: tokenInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg({ ok: false, text: data.detail || `HTTP ${res.status}` });
      } else {
        setConn('connected');
        setServer(data.server || urlInput.trim());
        setMsg({ ok: true, text: `Connected to ${data.server}${data.version ? ` (${data.version})` : ''}` });
        setTimeout(() => { setShowModal(false); setTokenInput(''); }, 1500);
      }
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Request failed' });
    }
    setConnecting(false);
  };

  const bad = conn === 'unauthorized' || conn === 'disconnected';
  const statusLabel =
    conn === 'connected' ? 'Connected to cluster'
    : conn === 'unauthorized' ? 'Token rejected'
    : conn === 'disconnected' ? 'Cluster unreachable'
    : 'Checking cluster…';

  return (
    <>
      {/* ── Connection banner ────────────────────────────────────────────── */}
      {bad && (
        <div className="sticky top-0 z-40 flex items-center justify-between gap-3 px-5 py-2 bg-red-500/95 backdrop-blur text-white text-xs font-medium">
          <div className="flex items-center gap-2">
            <AlertTriangle size={13} className="flex-shrink-0" />
            <span>
              {conn === 'unauthorized'
                ? 'The cluster rejected the current credentials — live data is unavailable.'
                : 'Cannot reach the cluster — live data is unavailable.'}
            </span>
          </div>
          <button
            onClick={openModal}
            className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1 rounded-md bg-white/20 hover:bg-white/30 transition-colors font-semibold"
          >
            <Plug size={12} />
            Connect to cluster
          </button>
        </div>
      )}

      {/* ── Main header ──────────────────────────────────────────────────── */}
      <header
        className={`sticky top-0 z-30 h-14 flex items-center justify-between px-6 border-b backdrop-blur-xl ${
          isDark
            ? 'bg-[#0a0e1a]/80 border-white/[0.06] text-white'
            : 'bg-white/80 border-gray-200 text-gray-900'
        }`}
      >
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full animate-pulse ${bad ? 'bg-red-400' : conn === 'connected' ? 'bg-emerald-400' : 'bg-gray-400'}`} />
            <span className={`text-xs font-medium ${bad ? (isDark ? 'text-red-400' : 'text-red-500') : conn === 'connected' ? (isDark ? 'text-emerald-400' : 'text-emerald-600') : (isDark ? 'text-gray-400' : 'text-gray-500')}`}>
              {statusLabel}
            </span>
          </div>
          <div className={`h-4 w-px ${isDark ? 'bg-white/10' : 'bg-gray-300'}`} />
          <div className={`flex items-center gap-3 text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            <Clock size={13} />
            <span>IST {fmtTime(time, 'Asia/Kolkata')}</span>
            <span className={isDark ? 'text-white/20' : 'text-gray-300'}>|</span>
            <span>EST {fmtTime(time, 'America/New_York')}</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={openModal}
            title={server ? `Cluster: ${server}` : 'Connect to a cluster'}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              bad
                ? 'bg-red-500 text-white hover:bg-red-600'
                : isDark
                  ? 'bg-white/[0.06] text-gray-400 hover:bg-white/10 hover:text-white'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200 hover:text-gray-700'
            }`}
          >
            <Plug size={13} />
            Connect to cluster
          </button>

          <button
            onClick={handleRefresh}
            className={`p-2 rounded-lg transition-colors ${
              isDark ? 'hover:bg-white/[0.06] text-gray-400' : 'hover:bg-gray-100 text-gray-500'
            }`}
          >
            <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
          </button>

          <button
            className={`relative p-2 rounded-lg transition-colors ${
              isDark ? 'hover:bg-white/[0.06] text-gray-400' : 'hover:bg-gray-100 text-gray-500'
            }`}
          >
            <Bell size={16} />
            <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-red-500" />
          </button>

          <div className={`h-6 w-px ${isDark ? 'bg-white/10' : 'bg-gray-300'}`} />

          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-cyan-400 flex items-center justify-center">
              <Activity size={14} className="text-white" />
            </div>
            <span className={`text-xs font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>SRE Admin</span>
          </div>
        </div>
      </header>

      {/* ── Connect-to-cluster modal ─────────────────────────────────────── */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className={`w-full max-w-lg rounded-2xl border shadow-2xl ${isDark ? 'bg-[#0d1220] border-white/[0.08]' : 'bg-white border-gray-200'}`}>
            <div className={`flex items-center justify-between px-5 py-4 border-b ${isDark ? 'border-white/[0.06]' : 'border-gray-100'}`}>
              <div className="flex items-center gap-2">
                <Plug size={16} className="text-blue-400" />
                <h3 className={`font-semibold text-sm ${isDark ? 'text-white' : 'text-gray-900'}`}>Connect to cluster</h3>
              </div>
              <button onClick={() => setShowModal(false)} className={isDark ? 'text-gray-500 hover:text-gray-300' : 'text-gray-400 hover:text-gray-600'}>
                <X size={16} />
              </button>
            </div>

            <div className="px-5 py-4 space-y-4 text-sm">
              <p className={`text-xs leading-relaxed ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                Enter the cluster API URL and a token (OpenShift console → username → <strong>Copy login command</strong> → <strong>Display Token</strong>).
                Access is read-only. Credentials are kept in backend memory only and are not saved.
              </p>

              <div className="space-y-1.5">
                <label className={`text-xs font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Cluster API URL</label>
                <input
                  type="text"
                  value={urlInput}
                  onChange={e => setUrlInput(e.target.value)}
                  placeholder="https://api.<cluster-domain>:6443"
                  autoComplete="off"
                  className={`w-full rounded-lg border px-3 py-2.5 text-xs font-mono outline-none ${isDark ? 'bg-white/[0.04] border-white/[0.08] text-white placeholder-gray-600' : 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400'}`}
                />
              </div>

              <div className="space-y-1.5">
                <label className={`text-xs font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Token</label>
                <div className={`flex items-center rounded-lg border ${isDark ? 'bg-white/[0.04] border-white/[0.08]' : 'bg-gray-50 border-gray-200'}`}>
                  <input
                    type={tokenVisible ? 'text' : 'password'}
                    value={tokenInput}
                    onChange={e => setTokenInput(e.target.value)}
                    placeholder="sha256~..."
                    autoComplete="off"
                    className={`flex-1 bg-transparent px-3 py-2.5 text-xs font-mono outline-none ${isDark ? 'text-white placeholder-gray-600' : 'text-gray-900 placeholder-gray-400'}`}
                  />
                  <button
                    onClick={() => setTokenVisible(v => !v)}
                    className={`px-3 py-2.5 ${isDark ? 'text-gray-500 hover:text-gray-300' : 'text-gray-400 hover:text-gray-600'}`}
                  >
                    {tokenVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>

              {msg && (
                <div className={`flex items-start gap-2 text-xs px-3 py-2 rounded-lg border ${
                  msg.ok
                    ? isDark ? 'bg-emerald-400/10 text-emerald-400 border-emerald-400/20' : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : isDark ? 'bg-red-400/10 text-red-400 border-red-400/20' : 'bg-red-50 text-red-600 border-red-200'
                }`}>
                  {msg.ok ? <CheckCircle size={12} className="mt-0.5 flex-shrink-0" /> : <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />}
                  {msg.text}
                </div>
              )}
            </div>

            <div className={`flex items-center justify-end gap-2 px-5 py-4 border-t ${isDark ? 'border-white/[0.06]' : 'border-gray-100'}`}>
              <button
                onClick={() => setShowModal(false)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${isDark ? 'bg-white/[0.06] text-gray-300 hover:bg-white/10' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
              >
                Cancel
              </button>
              <button
                onClick={connect}
                disabled={connecting || !urlInput.trim() || !tokenInput.trim()}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-blue-500 hover:bg-blue-600 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {connecting ? <RefreshCw size={13} className="animate-spin" /> : <Plug size={13} />}
                {connecting ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
