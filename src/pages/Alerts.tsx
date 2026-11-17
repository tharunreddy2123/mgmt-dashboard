import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { useTheme } from '../context/ThemeContext';
import {
  getEvents,
  getEventTime,
  getLogAlerts,
  type OCEvent,
  type LogAlertsResponse,
} from '../lib/openshift-direct';
import { Bell, AlertTriangle, XCircle, Search, Filter, RefreshCw, FileText, Activity } from 'lucide-react';

const WINDOW_MS = 24 * 60 * 60 * 1000;

type Tab = 'events' | 'logs';

export default function Alerts() {
  const { isDark } = useTheme();
  const [tab, setTab] = useState<Tab>('events');
  const [events, setEvents] = useState<OCEvent[]>([]);
  const [logs, setLogs] = useState<LogAlertsResponse | null>(null);
  const [search, setSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState<'all' | 'error' | 'warning'>('all');
  const [loading, setLoading] = useState(true);
  const [logsLoading, setLogsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logsError, setLogsError] = useState<string | null>(null);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const ev = await getEvents();
      const cutoff = Date.now() - WINDOW_MS;
      setEvents(
        ev
          .filter(e => e.type === 'Warning' && new Date(getEventTime(e)).getTime() >= cutoff)
          .sort((a, b) => new Date(getEventTime(b)).getTime() - new Date(getEventTime(a)).getTime())
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    }
    setLoading(false);
  }, []);

  const fetchLogs = useCallback(async () => {
    setLogsLoading(true);
    setLogsError(null);
    try {
      setLogs(await getLogAlerts());
    } catch (err) {
      setLogsError(err instanceof Error ? err.message : 'Failed to scan logs');
    }
    setLogsLoading(false);
  }, []);

  useEffect(() => { fetchEvents(); }, [fetchEvents]);

  // Log scan reads every container's logs, so only run it once the tab is opened
  useEffect(() => {
    if (tab === 'logs' && !logs && !logsLoading && !logsError) fetchLogs();
  }, [tab, logs, logsLoading, logsError, fetchLogs]);

  const refresh = () => (tab === 'events' ? fetchEvents() : fetchLogs());
  const busy = tab === 'events' ? loading : logsLoading;
  const q = search.toLowerCase();

  const filteredEvents = events.filter(e =>
    e.message.toLowerCase().includes(q) ||
    e.reason.toLowerCase().includes(q) ||
    e.involvedObject.name.toLowerCase().includes(q)
  );

  const findings = (logs?.findings ?? [])
    .map(f => ({
      ...f,
      samples: f.samples.filter(s => levelFilter === 'all' || s.level === levelFilter),
    }))
    .filter(f => {
      if (levelFilter === 'error' && f.error_count === 0) return false;
      if (levelFilter === 'warning' && f.warning_count === 0) return false;
      return !q || f.pod.toLowerCase().includes(q) || f.namespace.toLowerCase().includes(q) ||
        f.samples.some(s => s.message.toLowerCase().includes(q));
    });
  const totalErrors = (logs?.findings ?? []).reduce((s, f) => s + f.error_count, 0);
  const totalWarnings = (logs?.findings ?? []).reduce((s, f) => s + f.warning_count, 0);

  const card = isDark ? 'bg-[#0d1220] border-white/[0.06]' : 'bg-white border-gray-200 shadow-sm';
  const muted = isDark ? 'text-gray-500' : 'text-gray-400';
  const tabCls = (active: boolean) =>
    `flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
      active
        ? isDark ? 'bg-white/10 text-white' : 'bg-white text-gray-900 shadow-sm'
        : isDark ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-700'
    }`;

  const summary = tab === 'events'
    ? [
        { label: 'Warning Events (24h)', value: events.length, icon: AlertTriangle, color: 'text-yellow-400' },
        { label: 'Unique Reasons', value: new Set(events.map(e => e.reason)).size, icon: XCircle, color: 'text-orange-400' },
        { label: 'Affected Objects', value: new Set(events.map(e => `${e.involvedObject.kind}/${e.involvedObject.namespace}/${e.involvedObject.name}`)).size, icon: Activity, color: 'text-blue-400' },
      ]
    : [
        { label: 'Error Lines (24h)', value: totalErrors, icon: XCircle, color: 'text-red-400' },
        { label: 'Warning Lines (24h)', value: totalWarnings, icon: AlertTriangle, color: 'text-yellow-400' },
        { label: 'Containers with Issues', value: logs?.findings.length ?? 0, icon: FileText, color: 'text-blue-400' },
      ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>Alerts</h1>
          <p className={`text-sm mt-1 ${muted}`}>
            Warnings and errors from the last 24 hours — cluster events and container logs
          </p>
        </div>
        <button onClick={refresh} disabled={busy} title="Refresh"
          className={`p-2 rounded-lg transition-colors ${isDark ? 'hover:bg-white/[0.06] text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}>
          <RefreshCw size={16} className={busy ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className={`flex gap-1 p-1 rounded-lg w-fit ${isDark ? 'bg-white/[0.04]' : 'bg-gray-100'}`}>
        <button onClick={() => setTab('events')} className={tabCls(tab === 'events')}>
          <Bell size={13} /> Warning Events ({events.length})
        </button>
        <button onClick={() => setTab('logs')} className={tabCls(tab === 'logs')}>
          <FileText size={13} /> Error &amp; Warning Logs{logs ? ` (${totalErrors + totalWarnings})` : ''}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {summary.map((item, i) => (
          <motion.div key={item.label} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
            className={`rounded-xl p-4 border ${card}`}>
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${item.color.replace('text-', 'bg-').replace('-400', '-400/10')}`}>
                <item.icon size={18} className={item.color} />
              </div>
              <div>
                <p className={`text-xs ${muted}`}>{item.label}</p>
                <p className={`text-xl font-bold ${item.color}`}>{item.value}</p>
              </div>
            </div>
          </motion.div>
        ))}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg ${isDark ? 'bg-white/[0.04]' : 'bg-gray-100'}`}>
          <Search size={14} className={muted} />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder={tab === 'events' ? 'Search events...' : 'Search pods or log messages...'}
            className={`bg-transparent text-sm outline-none w-56 ${isDark ? 'text-white placeholder-gray-500' : 'text-gray-900 placeholder-gray-400'}`} />
        </div>
        {tab === 'logs' && (
          <div className={`flex items-center gap-2 px-3 py-2 rounded-lg ${isDark ? 'bg-white/[0.04]' : 'bg-gray-100'}`}>
            <Filter size={14} className={muted} />
            <select value={levelFilter} onChange={e => setLevelFilter(e.target.value as typeof levelFilter)}
              className={`bg-transparent text-sm outline-none ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
              <option value="all">Errors &amp; Warnings</option>
              <option value="error">Errors only</option>
              <option value="warning">Warnings only</option>
            </select>
          </div>
        )}
        <span className={`text-xs ${muted}`}>
          {tab === 'events' ? `${filteredEvents.length} events` : `${findings.length} containers`}
        </span>
      </div>

      {tab === 'events' ? (
        loading ? (
          <div className="flex items-center justify-center h-48"><RefreshCw size={24} className="animate-spin text-blue-400" /></div>
        ) : error ? (
          <ErrorBox message={error} onRetry={fetchEvents} isDark={isDark} />
        ) : filteredEvents.length === 0 ? (
          <Empty text="No warning events in the last 24 hours" isDark={isDark} />
        ) : (
          <div className="space-y-3">
            {filteredEvents.slice(0, 100).map(event => (
              <div key={event.metadata.uid || event.metadata.name}
                className={`rounded-xl p-4 border ${isDark ? 'bg-yellow-500/5 border-yellow-500/20' : 'bg-yellow-50 border-yellow-200'}`}>
                <div className="flex items-start gap-3">
                  <div className="p-1.5 rounded-lg bg-yellow-400/10"><AlertTriangle size={16} className="text-yellow-400" /></div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <p className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>{event.reason}</p>
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-medium text-yellow-400 bg-yellow-400/10 border border-yellow-400/20">Warning</span>
                    </div>
                    <p className={`text-xs break-words ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{event.message}</p>
                    <div className="flex items-center gap-4 mt-2 text-[10px] flex-wrap">
                      <span className={muted}>Source: {event.source?.component}</span>
                      <span className={muted}>NS: {event.involvedObject.namespace}</span>
                      <span className={`font-mono ${muted}`}>{event.involvedObject.kind}: {event.involvedObject.name}</span>
                      <span className={isDark ? 'text-gray-600' : 'text-gray-400'}>{new Date(getEventTime(event)).toLocaleString()}</span>
                      <span className={isDark ? 'text-gray-600' : 'text-gray-400'}>Count: {event.count}</span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      ) : logsLoading ? (
        <div className="flex flex-col items-center justify-center h-48 gap-2">
          <RefreshCw size={24} className="animate-spin text-blue-400" />
          <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Scanning container logs from the last 24 hours…</span>
        </div>
      ) : logsError ? (
        <ErrorBox message={logsError} onRetry={fetchLogs} isDark={isDark} />
      ) : findings.length === 0 ? (
        <Empty text="No error or warning log lines found in the last 24 hours" isDark={isDark} />
      ) : (
        <div className="space-y-3">
          {logs && (logs.inaccessible > 0 || logs.containers_scanned < logs.containers_total) && (
            <p className={`text-xs ${muted}`}>
              Scanned {logs.containers_scanned} of {logs.containers_total} containers
              {logs.inaccessible > 0 ? ` · ${logs.inaccessible} unreadable (missing pods/log permission)` : ''}.
            </p>
          )}
          {findings.map(f => (
            <div key={`${f.namespace}/${f.pod}/${f.container}`} className={`rounded-xl p-4 border ${card}`}>
              <div className="flex items-center gap-2 flex-wrap mb-2">
                <span className={`text-sm font-mono font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>{f.pod}</span>
                <span className={`text-xs ${muted}`}>{f.namespace} · {f.container}</span>
                {f.error_count > 0 && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full font-medium text-red-400 bg-red-400/10 border border-red-400/20">{f.error_count} errors</span>
                )}
                {f.warning_count > 0 && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full font-medium text-yellow-400 bg-yellow-400/10 border border-yellow-400/20">{f.warning_count} warnings</span>
                )}
              </div>
              <div className="space-y-1">
                {f.samples.map((s, i) => (
                  <div key={i} className={`flex gap-2 text-xs font-mono rounded px-2 py-1 ${isDark ? 'bg-white/[0.03]' : 'bg-gray-50'}`}>
                    <span className={s.level === 'error' ? 'text-red-400' : 'text-yellow-400'}>{s.level === 'error' ? 'ERR' : 'WRN'}</span>
                    <span className={`flex-shrink-0 ${muted}`}>{isNaN(Date.parse(s.ts)) ? '' : new Date(s.ts).toLocaleTimeString()}</span>
                    <span className={`break-all ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>{s.message}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ErrorBox({ message, onRetry, isDark }: { message: string; onRetry: () => void; isDark: boolean }) {
  return (
    <div className="flex items-center justify-center h-48">
      <div className={`rounded-xl p-8 border max-w-md text-center ${isDark ? 'bg-[#0d1220] border-red-500/20' : 'bg-white border-red-200'}`}>
        <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{message}</p>
        <button onClick={onRetry} className="mt-4 px-4 py-2 rounded-lg bg-blue-500 text-white text-sm">Retry</button>
      </div>
    </div>
  );
}

function Empty({ text, isDark }: { text: string; isDark: boolean }) {
  return (
    <div className={`rounded-xl border p-10 text-center ${isDark ? 'bg-[#0d1220] border-white/[0.06]' : 'bg-white border-gray-200'}`}>
      <Activity size={24} className="text-green-400 mx-auto mb-3" />
      <p className={`text-sm font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>{text}</p>
    </div>
  );
}
