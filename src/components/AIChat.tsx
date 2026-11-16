import { useState, useRef, useEffect, type ReactNode } from 'react';
import { Send, Bot, User, Loader2, Sparkles, X, Activity, Server, Box, AlertTriangle, Layers } from 'lucide-react';
import { BACKEND_URL, fetchWithRetry } from '../lib/api-client';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  actionPerformed?: string;
  actionSuccess?: boolean;
}

/** Identifies the pod/node an Incidents card was opened for, so the backend can run a targeted RCA. */
export interface ChatIncident {
  kind: 'Pod' | 'Node';
  name: string;
  namespace?: string;
  title?: string;
}

interface AIChatProps {
  isOpen: boolean;
  onClose: () => void;
  initialMessage?: string;
  incident?: ChatIncident;
}

// Inline formatting: `code` and **bold**
function renderInline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={i} className="bg-gray-200 dark:bg-gray-600 px-1 py-0.5 rounded text-xs font-mono break-all">{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>;
    }
    return <span key={i}>{part}</span>;
  });
}

// Render assistant message with basic markdown formatting
function MessageContent({ content }: { content: string }) {
  const lines = content.split('\n');
  const out: ReactNode[] = [];
  let code: string[] | null = null;

  lines.forEach((line, i) => {
    // fenced code block
    if (line.trim().startsWith('```')) {
      if (code === null) {
        code = [];
      } else {
        out.push(
          <pre key={i} className="bg-gray-900 text-green-300 rounded-lg p-3 text-xs font-mono overflow-x-auto my-1 whitespace-pre-wrap break-all">
            {code.join('\n')}
          </pre>
        );
        code = null;
      }
      return;
    }
    if (code !== null) { code.push(line); return; }

    // Section headers (## Root Cause Analysis / ## Solution Steps)
    if (/^#{1,3}\s/.test(line)) {
      out.push(
        <p key={i} className="font-bold text-blue-600 dark:text-blue-400 mt-3 pb-1 border-b border-gray-300/50 dark:border-gray-600/50">
          {line.replace(/^#{1,3}\s/, '')}
        </p>
      );
      return;
    }
    // Bullet points
    if (/^\s*[-•*]\s/.test(line)) {
      out.push(<p key={i} className="pl-3">• {renderInline(line.replace(/^\s*[-•*]\s/, ''))}</p>);
      return;
    }
    // Numbered steps
    const num = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (num) {
      out.push(
        <div key={i} className="flex gap-2 pl-1 mt-1">
          <span className="flex-shrink-0 w-5 h-5 mt-0.5 rounded-full bg-blue-600 text-white text-[11px] font-semibold flex items-center justify-center">
            {num[1]}
          </span>
          <p className="flex-1 min-w-0">{renderInline(num[2])}</p>
        </div>
      );
      return;
    }
    if (line.trim() === '') { out.push(<br key={i} />); return; }
    out.push(<p key={i}>{renderInline(line)}</p>);
  });

  return <div className="text-sm leading-relaxed space-y-1">{out}</div>;
}

const SUGGESTION_GROUPS = [
  { icon: Activity,      label: 'Cluster health',           query: 'Analyze cluster health and show all issues' },
  { icon: Box,           label: 'Unhealthy pods',            query: 'Show all unhealthy, failed and pending pods' },
  { icon: Server,        label: 'Node status',               query: 'Show all nodes and their status' },
  { icon: Layers,        label: 'Deployments',               query: 'Show all deployments and their replica status' },
  { icon: AlertTriangle, label: 'Warning events',            query: 'Show recent warning and error events' },
  { icon: Box,           label: 'Root cause of failing pods', query: 'Find the root cause of failing pods and show the evidence' },
  { icon: Layers,        label: 'Namespaces',                query: 'List all namespaces and projects' },
  { icon: AlertTriangle, label: 'Failed deployments',        query: 'Show failed or degraded deployments' },
];

type AIProvider = 'watsonx' | 'ica';

const WELCOME =
  'Hello! I\'m your OpenShift AI assistant.\n\nI am connected to your live cluster and can:\n\n• Show pods, nodes, deployments, events and namespaces\n• Diagnose CrashLoopBackOff, OOMKilled, Pending pods\n• Analyze cluster health with AI insights\n• Explain warning events and suggest fixes\n• Answer any OpenShift / Kubernetes question\n\nPick a quick action below or type your question.';

export default function AIChat({ isOpen, onClose, initialMessage, incident }: AIChatProps) {
  const [provider, setProvider] = useState<AIProvider>('watsonx');
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: WELCOME, timestamp: new Date() },
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loadingText, setLoadingText] = useState('Fetching live cluster data...');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // track which initialMessage we already fired so we don't re-send on re-renders
  const firedInitialRef = useRef<string | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  // Auto-send initialMessage when the chat is opened with one
  useEffect(() => {
    if (isOpen && initialMessage && firedInitialRef.current !== initialMessage) {
      firedInitialRef.current = initialMessage;
      // start a fresh conversation for this incident, then send
      setMessages([{ role: 'assistant', content: WELCOME, timestamp: new Date() }]);
      // slight delay so the reset renders first
      setTimeout(() => sendMessage(initialMessage, incident), 100);
    }
    // reset tracker when chat is closed so next open can fire again
    if (!isOpen) firedInitialRef.current = null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialMessage]);

  const sendMessage = async (messageText: string, incidentRef?: ChatIncident) => {
    if (!messageText.trim() || isLoading) return;

    // For incident RCA, show a short readable question instead of the long generated prompt
    const shown = incidentRef
      ? `Find the root cause and solution steps for ${incidentRef.kind} "${incidentRef.name}"` +
        (incidentRef.title ? ` — ${incidentRef.title}` : '')
      : messageText;
    const userMessage: Message = { role: 'user', content: shown, timestamp: new Date() };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setLoadingText(incidentRef
      ? `Investigating ${incidentRef.name}: collecting status, events, logs and node/dependency data...`
      : 'Fetching live cluster data...');
    setIsLoading(true);

    try {
      // Incident RCA starts a fresh conversation, so don't send history from earlier chats
      const conversationHistory = (incidentRef ? [] : messages.slice(-8)).map(m => ({
        role: m.role,
        content: m.content,
      }));

      // Route to the correct backend endpoint based on selected provider
      const endpoint = provider === 'ica' ? '/api/chat/ica' : '/api/chat';
      const response = await fetchWithRetry(`${BACKEND_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: messageText,
          conversation_history: conversationHistory,
          include_context: true,
          ...(incidentRef ? { incident: { kind: incidentRef.kind, name: incidentRef.name, namespace: incidentRef.namespace } } : {}),
        }),
      }, { timeout: 120000 });
      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Chat request failed: ${err}`);
      }
      const data = await response.json();
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.response,
        timestamp: new Date(),
        actionPerformed: data.action_performed ?? undefined,
        actionSuccess: data.action_success ?? undefined,
      }]);
    } catch (error) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: error instanceof Error
          ? `Error: ${error.message}`
          : 'Sorry, I encountered an error. Please check the backend is running.',
        timestamp: new Date(),
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  const handleSuggestionClick = (suggestion: string) => {
    sendMessage(suggestion);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed top-0 right-0 h-screen w-[420px] z-50 flex flex-col bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-white/[0.08] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-white/[0.08]">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-gradient-to-br from-blue-500 to-purple-600 rounded-xl">
              <Sparkles className="w-6 h-6 text-white" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">
                OpenShift AI Assistant
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {provider === 'ica' ? 'Powered by ICA' : 'Powered by IBM watsonx.ai'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* AI Provider toggle */}
            <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-700 rounded-lg p-1">
              <button
                onClick={() => setProvider('watsonx')}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                  provider === 'watsonx'
                    ? 'bg-white dark:bg-gray-600 text-blue-600 dark:text-blue-400 shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                }`}
              >
                watsonx
              </button>
              <button
                onClick={() => setProvider('ica')}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                  provider === 'ica'
                    ? 'bg-white dark:bg-gray-600 text-purple-600 dark:text-purple-400 shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                }`}
              >
                ICA
              </button>
            </div>
            <button
              onClick={onClose}
              className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            >
              <X className="w-5 h-5 text-gray-500 dark:text-gray-400" />
            </button>
          </div>
        </div>

        {/* Incident context banner */}
        {incident && (
          <div className="px-6 py-2 bg-blue-50 dark:bg-blue-900/20 border-b border-blue-100 dark:border-blue-900/40 flex items-center gap-2 text-xs text-blue-700 dark:text-blue-300">
            {incident.kind === 'Node' ? <Server className="w-3.5 h-3.5" /> : <Box className="w-3.5 h-3.5" />}
            <span className="font-semibold">Incident RCA</span>
            <span className="font-mono truncate">
              {incident.kind}: {incident.namespace ? `${incident.namespace}/` : ''}{incident.name}
            </span>
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((message, index) => (
            <div
              key={index}
              className={`flex gap-3 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {message.role === 'assistant' && (
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                  <Bot className="w-5 h-5 text-white" />
                </div>
              )}
              <div
                className={`max-w-[75%] rounded-2xl px-4 py-3 ${
                  message.role === 'user'
                    ? 'bg-blue-600 text-white text-sm'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white'
                }`}
              >
                {message.actionPerformed && (
                  <div className={`flex items-center gap-2 text-xs font-medium px-2 py-1 rounded-lg mb-2 ${
                    message.actionSuccess
                      ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400'
                      : 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400'
                  }`}>
                    <span>{message.actionSuccess ? '✅' : '❌'}</span>
                    <span>{message.actionPerformed}</span>
                  </div>
                )}
                {message.role === 'assistant'
                  ? <MessageContent content={message.content} />
                  : <p className="text-sm leading-relaxed">{message.content}</p>
                }
                <p className="text-xs mt-2 opacity-60">
                  {message.timestamp.toLocaleTimeString()}
                </p>
              </div>
              {message.role === 'user' && (
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center">
                  <User className="w-5 h-5 text-white" />
                </div>
              )}
            </div>
          ))}
          {isLoading && (
            <div className="flex gap-3 justify-start">
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                <Bot className="w-5 h-5 text-white" />
              </div>
              <div className="bg-gray-100 dark:bg-gray-700 rounded-2xl px-4 py-3">
                <div className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
                  <span className="text-sm text-gray-600 dark:text-gray-300">{loadingText}</span>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Quick-action suggestion chips */}
        {messages.length === 1 && !initialMessage && (
          <div className="px-6 pb-4">
            <p className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide mb-2">
              Quick actions
            </p>
            <div className="grid grid-cols-2 gap-2">
              {SUGGESTION_GROUPS.map((s, i) => (
                <button
                  key={i}
                  onClick={() => handleSuggestionClick(s.query)}
                  className="flex items-center gap-2 px-3 py-2 text-sm bg-gray-50 dark:bg-gray-700/60 hover:bg-blue-50 dark:hover:bg-blue-900/30 text-gray-700 dark:text-gray-300 hover:text-blue-700 dark:hover:text-blue-300 border border-gray-200 dark:border-gray-600 rounded-xl transition-colors text-left"
                >
                  <s.icon className="w-4 h-4 flex-shrink-0 text-blue-500" />
                  <span>{s.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Input */}
        <div className="p-4 border-t border-gray-200 dark:border-white/[0.08]">
          <form onSubmit={handleSubmit} className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask me anything about your OpenShift cluster..."
              disabled={isLoading}
              className="flex-1 px-3 py-2.5 bg-gray-100 dark:bg-white/[0.06] border-0 rounded-xl text-sm text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!input.trim() || isLoading}
              className="px-4 py-2.5 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white rounded-xl font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 text-sm"
            >
              <Send className="w-4 h-4" />
              Send
            </button>
          </form>
        </div>
    </div>
  );
}

// Made with Bob
